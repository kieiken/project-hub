'use strict';
// Release-only view of registration records. Staging evidence stays byte-for-byte
// in place; subsequent release registrations use a separate, protected directory.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {noLinks}=require('../lib/license/storage');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=home=>Object.fromEntries(['claim','receipt','recovery'].map((key,i)=>[key,path.join(home,['registration-claimed.json','registration-result.json','registration-recovery.json'][i])]));
function read(file) {
  noLinks(file);
  if(!fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&stat.nlink===1&&stat.size<=65536,'registration_record_invalid');
  const bytes=fs.readFileSync(file);return {bytes,value:JSON.parse(bytes)};
}
function staging(record,config,platform) {
  return record?.version===2 && record.os===platform &&
    /^project-hub-staging-\d{8}-[a-z0-9-]+$/.test(record.buildId) &&
    (!record.product || record.product==='project-hub-staging-only') &&
    record.buildId!==config.build.buildId && config.build.product!=='project-hub-staging-only';
}
function records(root,config,platform,adapter) {
  const original=files(root),home=path.join(root,'_hub/registration-release'),release=files(home);
  // Invalid/unknown records remain subject to the existing held-registration
  // path. Only an explicitly identified staging record can be set aside.
  let receipt,claim;
  try {receipt=read(original.receipt);claim=read(original.claim);}
  catch {return original;}
  const oldReceipt=staging(receipt?.value,config,platform)&&receipt.value.registered===true;
  const oldClaim=staging(claim?.value,config,platform)&&claim.value.status==='claimed-do-not-retry';
  // The original staging claim did not carry buildId/product. Associate it only
  // with its successful staging receipt, never with an orphan or formal claim.
  const paired=oldReceipt&&claim?.value.version===2&&claim.value.os===platform&&
    !Object.hasOwn(claim.value,'buildId')&&!Object.hasOwn(claim.value,'product')&&
    claim.value.status==='claimed-do-not-retry'&&Number.isFinite(Date.parse(claim.value.at))&&
    Date.parse(claim.value.at)<=Date.parse(receipt.value.at);
  const archived=Boolean((oldReceipt||oldClaim)&&(!receipt||oldReceipt)&&(!claim||oldClaim||paired));
  if(!archived) {
    // Never abandon a later formal registration if legacy evidence is changed.
    assert.ok(!Object.values(release).some(file=>{noLinks(file);return fs.existsSync(file);}), 'registration_records_conflict');
    return original;
  }
  const evidence={version:1,reason:'staging_registration_not_applicable_to_release',
    records:Object.fromEntries([[original.receipt,receipt],[original.claim,claim]].filter(([,r])=>r).map(([file,r])=>[path.basename(file),{sha256:sha(r.bytes),buildId:r.value.buildId||receipt.value.buildId}]))};
  const marker=path.join(root,'_hub/registration-staging-archive.json');noLinks(marker);noLinks(home);
  const previous=read(marker);
  if(previous)assert.deepEqual(previous.value,evidence,'registration_archive_changed');
  else {
    fs.mkdirSync(path.dirname(marker),{recursive:true,mode:0o700});
    const fd=fs.openSync(marker,'wx',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(evidence)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    adapter?.persistence?.syncDirectory(path.dirname(marker));
  }
  // No receipt, proof, device, recovery record or native secret is changed.
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  for(const file of Object.values(release))noLinks(file);
  return {...release,archived:true};
}
function assertSource(root,config,platform,adapter,device) {
  const selected=records(root,config,platform,adapter),receipt=read(selected.receipt),claim=read(selected.claim);
  if(!receipt&&!claim)return;
  // A claim without a successful receipt cannot establish a source identity.
  assert.ok(receipt?.value.registered===true&&[1,2].includes(receipt.value.version),'registration_receipt_unavailable');
  const identity=receipt.value.fingerprints?.identity;
  assert.match(identity||'',/^[a-f0-9]{64}$/,'registration_identity_unavailable');
  assert.equal(identity,sha(device.dev),'registration_identity_mismatch');
}
module.exports={records,assertSource};
