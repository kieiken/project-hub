'use strict';
// Failed entitlement adoption must not prevent opening unrelated general data.
// No persisted licence, native secret, clock or issuer is touched by this client.
const { License } = require('../lib/license');
const { lifecycle } = require('./license.cjs');
const reason = '以前の利用権を確認できません。選んだデータの保存先は使えますが、有料機能・無料体験の開始・コード登録は保留しています。購入や登録を繰り返さず、この表示をお知らせください。';
function createHeldLicense(config, platform, code) {
  const mismatch=code==='legacy_registration_mismatch';
  const message=mismatch?'以前の登録記録と引継ぎ元の端末情報を照合できないため、利用権を引き継いでいません。選んだデータの保存先は使えます。有料機能・無料体験の開始・コード登録は保留しています。購入や登録を繰り返さず、この表示をお知らせください。':reason;
  const blocked = () => { throw Object.assign(Error(message), { code:'legacy_license_unavailable', status:409 }); };
  const client = new License({ config, platform, owner:false,
    store:{read:()=>null,write:blocked}, secret:{get:()=>null,put:blocked},
    machineHint:blocked, elapsed:()=>0 });
  const status = client.status.bind(client), ops = lifecycle();
  client.status = () => {
    const current=status();
    return {...current, purchased:false, introAvailable:false, activationAvailable:false, purchaseUrl:'',
      trial:{...current.trial,state:'held'}, reason:message,
      diagnostic:{stage:'legacy-adoption',code:mismatch?'LEGACY_REGISTRATION_MISMATCH':'LEGACY_LICENSE_UNAVAILABLE'} };
  };
  client.prepare = async () => {}; client.start = () => {};
  client.ensureIdentity = blocked; client.refreshTime = async () => blocked();
  const activateRequest = read => ops.register(async () => {await read();return blocked();});
  const introRequest = read => ops.open(async () => {await read();return blocked();});
  client.activate = code => activateRequest(() => code);
  client.introCheckout = () => introRequest(() => {});
  return {client,lifecycle:ops,activateRequest,introRequest,busy:ops.busy};
}
module.exports = {createHeldLicense};
