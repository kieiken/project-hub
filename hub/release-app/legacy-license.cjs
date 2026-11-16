'use strict';
// One-way local adoption; the account secret remains in its existing OS store.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { LicenseStore, noLinks } = require('../lib/license/storage');
const { License } = require('../lib/license');
const { verifyEnvelope, validateProof, scopeMatches } = require('../lib/license/codec');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value == null ? null : {device:value.device,state:value.state})).digest('hex');
const fail = () => { throw Object.assign(Error('legacy_license_unavailable'), { code: 'legacy_license_unavailable' }); };
function snapshot(root, platform, adapter) {
  const home = path.join(root, '_hub/license'); noLinks(home);
  if (!fs.existsSync(home)) return null;
  const names = fs.readdirSync(home);
  if (!names.length) return null;
  if (platform === 'win32') {
    // Active WAL/shared-memory databases cannot provide a strictly unchanged snapshot.
    if (names.length !== 1 || names[0] !== 'license.sqlite') fail();
    const binding = adapter.licenseDirectory(home);
    for (const name of names) { const p = path.join(home,name); noLinks(p); const s=fs.lstatSync(p); if (!s.isFile() || s.nlink !== 1) fail(); }
    // Read-only SQLite never changes source journal settings or creates its DB.
    const { DatabaseSync } = require('node:sqlite');
    let db;
    try {
      db = new DatabaseSync(path.join(home,'license.sqlite'), { readOnly:true });
      if (db.prepare('PRAGMA application_id').get().application_id !== 0x50484c31 || db.prepare('PRAGMA user_version').get().user_version !== 1) fail();
      const rows=db.prepare('SELECT name,value FROM documents').all();
      if (rows.some(r=>!['device','state'].includes(r.name))) fail();
      const result=Object.fromEntries(rows.map(r=>[r.name,JSON.parse(r.value)]));
      if(adapter.licenseDirectory(home,binding)!==binding) fail();
      return result;
    } finally { db?.close(); }
  }
  if (names.some(n=>!['device.json','state.json'].includes(n))) fail();
  const store=new LicenseStore(root,adapter);
  return { device:store.read('device'), state:store.read('state') };
}
function validate(data, options) {
  if (!data?.device || !data.state || !Array.isArray(data.state.proofs) || !data.state.proofs.length) fail();
  const copy=structuredClone(data);
  const store={read:n=>structuredClone(copy[n]),write:(n,v)=>{copy[n]=structuredClone(v);}};
  const license=new License({...options,store,owner:false,fetcher:()=>fail(),extensions:{state:()=>({included:[]}),create:()=>({features:()=>[]})}});
  const status=license.status();
  const proofs=data.state.proofs.map(envelope=>validateProof(verifyEnvelope(envelope,options.config.trustedKeys,'proof')));
  if(status.invalid?.length || license.loadError || !license.identity || !license.clock?.valid ||
      proofs.some(p=>!['trial','purchase'].includes(p.kind) || p.dev!==license.identity.dev || !scopeMatches(p.scope,options.config.build) || p.iat>data.state.lastSeenAt) ||
      license.wall()<data.state.lastSeenAt-300 ||
      !(status.purchased || ['active','expired'].includes(status.trial.state))) fail();
  return data;
}
function adopt({sourceRoot,targetRoot,platform=process.platform,config,adapter=require('../lib/platform').forPlatform(platform),secret,machineHint,elapsed,wall}) {
  try {
    if(!['darwin','win32'].includes(platform) || !config || path.resolve(sourceRoot)===path.resolve(targetRoot)) fail();
    let options;
    const validateSnapshot=data=>{
      options ||= {platform,config,secret:secret || adapter.secretStore(),machineHint,elapsed,wall};
      return validate(data,options);
    };
    const journal=path.join(targetRoot,'_hub/license-adoption.json'); noLinks(journal);
    const target=snapshot(targetRoot,platform,adapter);
    if(fs.existsSync(journal)) {
      const lines=fs.readFileSync(journal,'utf8').trim().split('\n');
      const record=JSON.parse(lines[0]);
      if(lines.length!==2 || JSON.parse(lines[1]).complete!==true || record.v!==1 || record.platform!==platform || record.deviceDigest!==digest({device:target?.device})) fail();
      validateSnapshot(target); return {status:'existing'};
    }
    if(target) { validateSnapshot(target); return {status:'existing'}; }
    const source=snapshot(sourceRoot,platform,adapter);
    if(!source) return {status:'none'};
    validateSnapshot(source);
    const checkRegistration=()=>{
      try {require('./registration.cjs').assertSource(targetRoot,config,platform,adapter,source.device);}
      catch {throw Object.assign(Error('legacy_registration_mismatch'),{code:'legacy_registration_mismatch'});}
    };
    checkRegistration();
    const parent=path.dirname(journal); noLinks(parent); fs.mkdirSync(parent,{recursive:true,mode:0o700});
    // Exclusive durable intent precedes every target identity/proof write. A partial
    // adoption is intentionally never retried or repaired by this module.
    const fd=fs.openSync(journal,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify({v:1,platform,source:path.resolve(sourceRoot),digest:digest(source),deviceDigest:digest({device:source.device})})+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    adapter.persistence.syncDirectory(parent);
    if(snapshot(targetRoot,platform,adapter)) fail();
    checkRegistration();
    const store=new LicenseStore(targetRoot,adapter);
    store.write('device',source.device); store.write('state',source.state);
    const saved=snapshot(targetRoot,platform,adapter);
    if(digest(saved)!==digest(source)) fail();
    validateSnapshot(saved);
    const completed=fs.openSync(journal,'a');
    try { fs.writeFileSync(completed,JSON.stringify({complete:true})+'\n'); fs.fsyncSync(completed); } finally { fs.closeSync(completed); }
    return {status:'adopted'};
  } catch (error) { if(error.code==='legacy_registration_mismatch')throw error; fail(); }
}
module.exports={adopt};
