'use strict';
// Erasure deliberately bypasses writeFile: its immutable previous.json is a retention copy.
// The durable journal contains only ownership, IDs, paths and hashes, never item data.
const fs = require('node:fs'), path = require('node:path');
const U = require('./idea-utils'), order = require('./idea-order'), projection = require('./idea-projection');
const { noLinks } = require('./remove');
const journal = s => path.join(s.controlDir, 'erase-intent.json');
const exists = f => fs.existsSync(f);
function checked(file) {
  noLinks(file);
  if (!exists(file)) return null;
  const st=fs.lstatSync(file);
  U.check(st.isFile() && st.nlink===1,'erase-path','削除対象の保存先を照合できません',503);
  return fs.readFileSync(file);
}
function walk(dir) {
  noLinks(dir); if (!exists(dir)) return [];
  const out=[];
  for (const name of fs.readdirSync(dir)) {
    const file=path.join(dir,name),st=fs.lstatSync(file); noLinks(file);
    U.check(st.isDirectory() || st.isFile() && st.nlink===1,'erase-path','リンクや未知の保存形式があるため削除できません',503);
    if(st.isDirectory())out.push(...walk(file));else out.push(file);
  }
  return out;
}
function json(bytes) { try { return JSON.parse(bytes); } catch { throw U.fail('erase-format','保存控えの形式を照合できません。削除はまだ完了していません',503); } }
function references(value, ids) {
  if(Array.isArray(value))return value.some(v=>references(v,ids));
  if(value && typeof value==='object')return Object.entries(value).some(([k,v])=>ids.has(k)||references(v,ids));
  return typeof value==='string'&&ids.has(value);
}
function busy(ideas,project,d) {
  U.check(!ideas.eraseBusy?.(project,d),'erase-busy','アイデア台帳の起動時照合・結果保存・検証を待っています。完了後に削除できます');
  U.check(!Object.values(d.evidence).some(e=>e.type==='verification'&&!e.finished),'erase-busy','検証の終了と保存を待っています。終了後に削除できます');
  U.check(!Object.values(d.releases).some(r=>['applying','unknown'].includes(r.state)),'erase-busy','本体への反映結果を確認中です。反映先の作業で結果を確認してください');
}
function runsReady(ideas,project,d,c) {
  for(const r of Object.values(d.runs)) {
    const unresolved=r.needsReconcile&&(!r.reconcileRun||!d.runs[r.reconcileRun]?.closed||d.runs[r.reconcileRun]?.failure);
    if((r.closed||['not-sent','cancelled'].includes(r.delivery))&&!unresolved)continue;
    const related=c.runIds.includes(r.id),task=ideas.project(project).tasks?.find(t=>t.id===r.task);
    const route=task?`作業「${task.title||'本作業'}」の会話で終了記録を確認してください`:'依頼先の作業で終了記録を確認してください';
    // Stop generation is a permanent start fence, not evidence of success or
    // non-delivery. Retire only this withdrawn item's read-only organization,
    // with no retained execution/output and no shared targets or code effects.
    const stopped=task&&related&&r.id&&d.runs[r.id]===r&&!r.closed&&!unresolved&&!r.pendingResult&&!r.failure&&!r.continuationOf&&!r.reviewId&&!r.releaseId&&!(r.verificationRefs||[]).length&&r.purpose==='organize'&&r.readOnly===true&&r.delivery==='unknown'&&!(r.spoolIds||[]).length&&!(r.segments||[]).length&&r.targets?.length===1&&r.targets[0].itemId===c.id&&d.items[c.id]?.status==='withdrawn'&&!d.items[c.id].grant&&d.settings.manualPaused&&!d.settings.auto.enabled&&Number.isSafeInteger(r.stopGeneration)&&r.stopGeneration>=0&&r.stopGeneration<d.settings.stopGeneration;
    if(stopped) {
      const evidence=ideas.eraseRunState?.(project,r);
      if(evidence&&!evidence.error&&!evidence.resultPending&&!evidence.spools?.length&&['absent','unknown'].includes(evidence.state)) {
        (c.cancelledRuns||={})[r.id]={delivery:'cancelled',reason:'withdrawn-stopped-organization',stopGeneration:r.stopGeneration,cancelGeneration:d.settings.stopGeneration};
        continue;
      }
    }
    // This is an exclusion from this erasure's scope, never proof of completion.
    // Independent live runs and old stopped organization retain their own items.
    const independent=task&&typeof r.id==='string'&&d.runs[r.id]===r&&!related&&!unresolved&&!r.closed&&!r.pendingResult&&!r.failure&&!r.continuationOf&&!r.reviewId&&!r.releaseId&&!(r.verificationRefs||[]).length&&Array.isArray(r.targets)&&r.targets.length&&r.targets.every(t=>d.items[t.itemId]);
    const evidence=independent?ideas.eraseRunState?.(project,r):null;
    if(independent&&evidence&&!evidence.error&&!evidence.spools?.length) {
      // A positively identified, target-bound live run keeps its own prompt,
      // grants and results. Missing evidence alone never grants this exception.
      if(['organize','plan','build','fix'].includes(r.purpose)&&['running','accepted'].includes(r.delivery)&&['running','accepted'].includes(evidence.state))continue;
      if(r.purpose==='organize'&&r.readOnly===true&&r.delivery==='unknown'&&!(r.spoolIds||[]).length&&d.settings.manualPaused&&!d.settings.auto.enabled&&Number.isSafeInteger(r.stopGeneration)&&r.stopGeneration>=0&&Number.isSafeInteger(d.settings.stopGeneration)&&r.stopGeneration<d.settings.stopGeneration&&['absent','unknown'].includes(evidence.state))continue;
    }
    const reason=related?'この項目に関わる依頼が実行中・順番待ち、または結果未確認です（共有資料の使用を含みます）':'別の項目の実行結果や共有資料の使用範囲を安全に切り離せません';
    throw U.fail('erase-busy',reason+'。'+route);
  }
}
function preflight(ideas,project,s,d,id) {
  U.check(!Object.values(d.queueRetreats||{}).some(r=>r.itemId===id&&r.state!=='complete'),'queue-retreat','待ち指示の退避完了後に削除できます');
  U.check(d.items[id],'item','項目が見つかりません',404);busy(ideas,project,d);
  const dependents=Object.values(d.items).filter(i=>i.id!==id&&i.dependencies.some(dep=>dep.ideaId===id));
  U.check(!dependents.length,'erase-dependency','この項目を前提にする項目があるため、先にそちらを変更するか削除してください：'+dependents.map(i=>i.text.split('\n')[0].slice(0,60)||'画像の記録').join('、'));
  const entries=inventory(ideas,s),scope=context(entries,d,id);runsReady(ideas,project,d,scope.c);
  return {entries,...scope};
}
function availability(ideas,project,id) {
  try {
    U.opId(id);const s=ideas.resolve(project),d=ideas.read(project);U.check(s,'item','項目が見つかりません',404);
    const {entries,c,ledgers}=preflight(ideas,project,s,d,id),receipt={opId:U.uuid(),bodyHash:U.hash({preview:id}),at:new Date(ideas.clock()).toISOString(),result:{id,deleted:true,imageIds:c.imageIds}};
    const review=markdownReview(entries,c,ledgers,receipt,d);
    return review.documents.length?{id,allowed:false,code:'erase-markdown',message:'未照合の原文を確認すると削除できます',markdownReview:review}:{id,allowed:true};
  }
  catch(e){return {id,allowed:false,code:e.code||'storage',message:e.message};}
}
function controlKind(relative) {
  if (/^runs\/[a-f0-9-]+\.json$/.test(relative)) return 'run';
  if (/^reviews\/[a-f0-9-]+\/(bundle\.json|diff\.patch|history\.txt)$/.test(relative)) return 'review';
  if (/^verification\/[a-f0-9-]+\/(stdout|stderr)$/.test(relative)) return 'verification';
  if (/^images\/[a-f0-9]{64}\.(png|jpg|gif|webp|preview\.png)$/.test(relative)) return 'image';
  if (/^image-staging\/[a-f0-9-]+\/[a-f0-9-]+\.png$/.test(relative)) return 'staging';
  if (/^blobs\/[a-f0-9]{64}\.txt$/.test(relative)) return 'blob';
  if (/^imports\/[a-f0-9]{64}\.md$/.test(relative)) return 'import';
  if (/^writer\.owner(?:\.retired-[a-f0-9-]+)?$/.test(relative))return 'owner';
  throw U.fail('erase-format','未知の台帳用ファイルがあるため、削除前の照合が必要です',503);
}
function inventory(ideas,s) {
  const entries=new Map(),bindings=[s],backups=[],partialBackups=[];
  function add(file,kind,extra={}) {
    file=path.resolve(file); U.check(U.inside(ideas.control,file)||bindings.some(b=>file===path.join(b.dir,'ideas.json')||file===path.join(b.colocated?b.dir:b.realpath,'アイデア帳.md')),'erase-scope','台帳の管理範囲外には削除を広げません',503);
    ideas.outside(path.dirname(file)); checked(file);
    const prev=entries.get(file); U.check(!prev||prev.kind===kind,'erase-format','保存控えの所属が一致しません',503);
    entries.set(file,{file,kind,...extra});
  }
  // Registry transaction history is the authority for former bindings after relocation.
  for(const f of walk(path.join(ideas.control,'transactions',U.hash(ideas.registryFile)))) {
    if(!['candidate.json','previous.json'].includes(path.basename(f)))continue;
    const r=json(checked(f)); U.check(r.schema===1&&r.projects,'erase-format','登録履歴を照合できません',503);
    for(const e of Object.values(r.projects))if(e.projectUid===s.projectUid)bindings.push(e);
  }
  for(const file of walk(path.join(ideas.control,'backups',s.projectUid)).filter(f=>path.basename(f)==='backup.json')) {
    const b=json(checked(file)); U.check(b.schema===1&&b.projectUid===s.projectUid&&Array.isArray(b.files)&&b.entry?.projectUid===s.projectUid,'erase-backup','保管記録の所属を照合できません',503);
    bindings.push(b.entry);backups.push({file,b});
  }
  const backupRoot=path.join(ideas.control,'backups',s.projectUid);
  if(exists(backupRoot))for(const name of fs.readdirSync(backupRoot)) {
    U.opId(name);const base=path.join(backupRoot,name);noLinks(base);
    U.check(fs.statSync(base).isDirectory(),'erase-backup','保管場所の形式を照合できません',503);
    if(!exists(path.join(base,'backup.json')))partialBackups.push(base);
  }
  for(const b of bindings) {
    U.check(path.isAbsolute(b.dir)&&path.isAbsolute(b.realpath),'erase-scope','旧保存先の所属を照合できません',503);
    noLinks(b.dir);noLinks(b.realpath);
    const file=path.join(b.dir,'ideas.json');
    if(exists(file)){const d=json(checked(file));U.check(d.projectUid===s.projectUid,'erase-scope','旧保存先が別の台帳に変わっています',503);add(file,'ledger');}
    const md=path.join(b.colocated?b.dir:b.realpath,'アイデア帳.md');if(exists(md))add(md,'markdown');
    const preserved=path.join(b.dir,'preserved-markdown.json');if(exists(preserved))add(preserved,'wrapped-markdown');
  }
  for(const f of walk(s.controlDir)) {
    const relative=path.relative(s.controlDir,f).split(path.sep).join('/');
    if(relative==='erase-intent.json')continue;
    const tmp=relative.match(/^(.*)\.tmp$/),baseKind=controlKind(tmp?tmp[1]:relative),kind=tmp?'temporary':baseKind;if(baseKind!=='owner')add(f,kind,{relative});
  }
  for(const {file,b} of backups) {
    const base=path.dirname(file);add(file,'backup');
    const expected=new Set([file]);
    for(const row of b.files) {
      U.check(typeof row.path==='string'&&!path.isAbsolute(row.path)&&!row.path.split('/').includes('..'),'erase-backup','保管パスが不正です',503);
      const dest=path.join(base,row.path),kind=row.path==='ledger'?'ledger':row.path==='markdown'?'markdown':row.path.startsWith('control/')?controlKind(row.path.slice(8)):null;
      U.check(kind,'erase-backup','未知の保管形式です',503);const wrapper=json(checked(dest));U.check(typeof wrapper.base64==='string'&&U.hash(Buffer.from(wrapper.base64,'base64'))===row.hash,'erase-backup','保管内容が変更されています',503);
      add(dest,'wrapped-'+kind,{relative:row.path.replace(/^control\//,'')});expected.add(dest);
    }
    for(const f of walk(base))U.check(expected.has(f),'erase-backup','保管先に未登録のファイルがあります',503);
  }
  // A failed backup can stop before its index, or even before a wrapper's rename.
  // Its UID/op directory and typed paths still establish ownership; never restore it.
  const controlEntries=[...entries.values()].filter(e=>e.file.startsWith(s.controlDir+path.sep)&&e.kind!=='temporary');
  for(const base of partialBackups) {
    add(path.join(base,'backup.json'),'backup');
    const expected=new Map([['ledger','ledger'],['markdown','markdown'],...controlEntries.map(e=>['control/'+e.relative,e.kind])]);
    for(const f of walk(base)) {
      const rel=path.relative(base,f).split(path.sep).join('/').replace(/\.tmp$/,'');if(rel==='backup.json')continue;
      const kind=rel==='ledger'?'ledger':rel==='markdown'?'markdown':rel.startsWith('control/')?controlKind(rel.slice(8)):null;
      U.check(kind,'erase-backup','未完了の保管先に未知の資料があります',503);expected.set(rel,kind);
    }
    for(const [rel,kind] of expected)add(path.join(base,rel),'wrapped-'+kind,{relative:rel.replace(/^control\//,'')});
  }
  // All archives are addressed by the hash of an already established, owned target.
  for(const entry of [...entries.values()]) {
    const dir=path.join(ideas.control,'transactions',U.hash(entry.file));
    for(const f of walk(dir)) {
      const name=path.basename(f);
      U.check(['candidate.json','previous.json','pending-write.json'].includes(name)||name.endsWith('.tmp'),'erase-format','未知の保存途中ファイルがあります',503);
      if(name==='pending-write.json'){const p=json(checked(f));U.check(p.file===entry.file&&U.inside(dir,p.candidate)&&U.inside(dir,p.snapshot),'erase-scope','保存途中の所属が一致しません',503);}
      add(f,name==='pending-write.json'||name.endsWith('.tmp')?'temporary':entry.kind,{relative:entry.relative,archiveOf:entry.file});
    }
    if(exists(entry.file+'.tmp'))add(entry.file+'.tmp','temporary');
  }
  return [...entries.values()];
}
function unwrap(entry,bytes) {
  if(!entry.kind.startsWith('wrapped-'))return bytes;
  const v=json(bytes);U.check(typeof v.base64==='string','erase-format','保管形式を照合できません',503);return Buffer.from(v.base64,'base64');
}
function context(entries,d,id) {
  const c={id,uid:d.projectUid,imageIds:[],imageFiles:[],blobFiles:[],runIds:[],reviewIds:[],evidenceIds:[],releaseIds:[],imports:{},projections:{}};
  const imageIds=new Set(),images=new Map(),blobs=new Set(),runs=new Set(),reviews=new Set(),evidence=new Set();
  const keepIds=new Set(),keepFiles=new Set(),keepBlobs=new Set();
  function attachments(value,ids,files,blobset) {
    if(!value||typeof value!=='object')return;
    if(value.source?.blob?.file)blobset.add(value.source.blob.file);
    for(const im of value.images||[])if(im.hash&&im.ext){ids.add(im.id);files.add(im.hash+'.'+im.ext);files.add(im.hash+'.preview.png');}
    for(const h of value.revisionHistory||[])attachments(h.previous,ids,files,blobset);
  }
  for(const item of Object.values(d.items))if(item.id!==id)attachments(item,keepIds,keepFiles,keepBlobs);
  const ledgers=[];
  for(const e of entries)if(e.kind.replace(/^wrapped-/,'')==='ledger'&&checked(e.file)!==null) {
    const l=json(unwrap(e,checked(e.file)));require('./ideas').validate(l);U.check(l.projectUid===d.projectUid,'erase-scope','保管台帳の所属が一致しません',503);ledgers.push(l);
    const target=l.items[id];
    if(target){
      const collect=item=>{
        if(!item)return;
        attachments(item,imageIds,new Set(),blobs);for(const im of item.images||[])images.set(im.id,im);
        if(item.source?.capture==='legacy'){const src=item.source;(c.imports[src.hash]||=[]).push(src.line);}
        if(item.implementation?.verificationId)evidence.add(item.implementation.verificationId);
        for(const ev of item.evidence||[])if(ev.type==='verification')evidence.add(ev.id);else if(ev.type==='review')reviews.add(ev.id||ev.reviewId);
        for(const h of item.revisionHistory||[])collect(h.previous);
      };collect(target);
    }
    for(const r of Object.values(l.runs))if(references(r.targets,new Set([id])))runs.add(r.id);
    for(const r of Object.values(l.reviews))if(references(r.itemContentRevs,new Set([id])))reviews.add(r.id);
    // Older verification records have no target binding: those are shared project
    // material. New records bind the item set so unrelated later checks can stay.
    for(const e of Object.values(l.evidence))if(e.type==='verification'&&(e.itemIds?.includes(id)||!e.itemIds&&target))evidence.add(e.id);
  }
  const bundles=[];
  for(const e of entries)if(e.kind.replace(/^wrapped-/,'')==='run'&&checked(e.file)!==null){const r=json(unwrap(e,checked(e.file)));if(references(r.targets,new Set([id])))runs.add(r.runId);}
  for(const e of entries)if(e.kind.replace(/^wrapped-/,'')==='review'&&(e.relative||'').endsWith('/bundle.json')&&checked(e.file)!==null) {
    const bundle=json(unwrap(e,checked(e.file)));
    U.check(bundle.schema===1&&bundle.id&&Array.isArray(bundle.items),'erase-format','確認資料の形式を照合できません',503);
    bundles.push(bundle);if(bundle.items.some(i=>i.id===id))reviews.add(bundle.id);
  }
  const releases=new Set();let prior='';
  // A shared immutable review/test/run is removed as a whole, including dependent
  // fixed material. Unrelated item text and permissions never enter this closure.
  while(prior!==[runs.size,reviews.size,evidence.size,releases.size].join(':')) {
    prior=[runs.size,reviews.size,evidence.size,releases.size].join(':');
    const affected=new Set([id,...reviews,...evidence,...runs]);
    for(const l of ledgers) {
      for(const r of Object.values(l.releases))if(references(r,affected)||['preparing','reviewing','ready'].includes(r.state))releases.add(r.id);
      for(const r of Object.values(l.runs)) {
        if(reviews.has(r.reviewId)||runs.has(r.continuationOf)||releases.has(r.releaseId))runs.add(r.id);
        if(runs.has(r.id))for(const ev of r.verificationRefs||[])evidence.add(ev);
      }
      for(const r of Object.values(l.reviews)) {
        if((r.testEvidenceRefs||[]).some(id=>evidence.has(id)))reviews.add(r.id);
        if(reviews.has(r.id))for(const ev of r.testEvidenceRefs||[])evidence.add(ev);
      }
    }
    for(const b of bundles){if((b.testEvidence||[]).some(e=>evidence.has(e.id)))reviews.add(b.id);if(reviews.has(b.id))for(const e of b.testEvidence||[])evidence.add(e.id);}
  }
  for(const im of images.values())if(!keepIds.has(im.id)) {
    c.imageIds.push(im.id);
    for(const f of [im.hash+'.'+im.ext,im.hash+'.preview.png'])if(!keepFiles.has(f))c.imageFiles.push(f);
  }
  c.blobFiles=[...blobs].filter(f=>!keepBlobs.has(f));c.runIds=[...runs].filter(Boolean);c.reviewIds=[...reviews].filter(Boolean);c.evidenceIds=[...evidence].filter(Boolean);c.releaseIds=[...releases].filter(Boolean);
  for(const [hash,lines] of Object.entries(c.imports))c.imports[hash]=[...new Set(lines)];
  // Bind markdown bytes to a known projection, rather than searching/replacing user text.
  for(const l of ledgers)if(l.projection?.hash)c.projections[l.projection.hash]=U.hash(l);
  // A first-revision preservation (or its erasure-carried provenance) proves
  // these bytes predate Hub's projection. Never infer ownership from a missing
  // target alone, nor from existingHash, which also tracks later hand edits.
  const versions=[];
  function version(i){if(!i)return;versions.push(i);for(const h of i.revisionHistory||[])version(h.previous);}
  for(const l of ledgers)version(l.items[id]);
  c.preservedMarkdown=[];
  for(const l of ledgers) {
    const p=l.projection,h=p?.existingHash;
    if(!h||p.hash||!p.preserved||!(l.rev===1||p.preservedOrigin?.hash===h&&p.preservedOrigin.rev===1)||!versions.length||versions.some(i=>i.source?.capture!=='verified'))continue;
    for(const e of entries.filter(e=>e.kind.replace(/^wrapped-/,'')==='markdown')) {
      const raw=checked(e.file);if(raw===null)continue;const bytes=unwrap(e,raw);if(U.hash(bytes)!==h)continue;
      const text=bytes.toString('utf8').replace(/\r\n/g,'\n');
      const needles=[id,...versions.flatMap(i=>[i.text,i.text.split(/\r?\n/).find(line=>line.trim())?.trim(),...(i.images||[]).flatMap(im=>[im.id,im.hash,im.name])])].filter(Boolean);
      if(!needles.some(n=>text.includes(n.replace(/\r\n/g,'\n'))))c.preservedMarkdown.push(h);
    }
  }
  c.preservedMarkdown=[...new Set(c.preservedMarkdown)];
  return {c,ledgers};
}
function sanitizedLedger(input,c,receipt,reviewedProjection) {
  const d=U.clone(input);order.normalize(d);
  const already=d.erased?.[c.id]?.opId===receipt.opId;
  const changed=Boolean(d.items[c.id]);delete d.items[c.id];d.itemOrder=d.itemOrder.filter(id=>id!==c.id);if(changed)d.orderRev++;
  for(const r of Object.values(d.queueRetreats||{}))if(r.itemId===c.id){delete r.snapshot;delete r.images;r.state='complete';r.removed=true;}
  for(const id of c.imageIds)if(d.images)delete d.images[id];
  const affected=new Set([c.id,...c.imageIds,...c.runIds,...c.reviewIds,...c.evidenceIds,...c.releaseIds]);
  if(c.runIds.some(id=>d.runs[id]?.failure?.message===d.observed?.reason))d.observed={state:'idle'};
  for(const id of c.runIds)delete d.runs[id];for(const id of c.reviewIds)delete d.reviews[id];for(const id of c.evidenceIds)delete d.evidence[id];
  function invalidate(i) {
    // Shared fixed review material is invalidated, never silently redacted under an old pass.
    i.evidence=(i.evidence||[]).filter(e=>!references(e,new Set([...c.reviewIds,...c.evidenceIds])));
    if(i.implementation&&c.evidenceIds.includes(i.implementation.verificationId)) {i.implementation.verificationId=null;i.implementation.verificationInvalidated=true;}
    if(c.runIds.includes(i.organized?.runId)){i.organized=null;i.organizationRequested=true;}
    if(i.organizationHistory)i.organizationHistory=i.organizationHistory.filter(h=>!c.runIds.includes(h.runId));
    if(c.runIds.includes(i.failure?.runId))i.failure={blocked:true,invalidated:true,cause:'項目の削除により関連資料が失効しました'};
    if(c.runIds.includes(i.checkpoint?.runId))i.checkpoint=null;
    for(const h of i.revisionHistory||[])if(h.previous)invalidate(h.previous);
  }
  for(const i of Object.values(d.items))invalidate(i);
  for(const r of Object.values(d.releases))if(c.releaseIds.includes(r.id)||references(r,affected)||changed&&['preparing','reviewing','ready'].includes(r.state)) {
    const kept={id:r.id,rev:(r.rev||0)+(already?0:1),state:r.mergedEvidence?'merged':'stale',staleReason:'項目の削除により確認資料が失効しました',mergedEvidence:r.mergedEvidence||null};d.releases[r.id]=kept;
  }
  for(const r of Object.values(d.receipts))if(r.opId!==receipt.opId&&references(r.result,affected))r.result={removed:true,id:c.id};
  if(c.runIds.includes(d.observed?.runId))d.observed={state:'idle'};
  for(const h of Object.keys(c.imports))if(d.imports?.[h])d.imports[h].redacted=true;
  for(const [hash,lines] of Object.entries(c.importResolutions||{}))if(d.imports?.[hash]){d.imports[hash].redacted=true;d.imports[hash].unknown=(d.imports[hash].unknown||[]).filter(row=>!lines.includes(row.line));}
  // Complete journals prepared before import decisions had their own binding.
  if(!c.importResolutions)for(const r of c.markdownResolutions||[])if(d.imports?.[r.before]){d.imports[r.before].redacted=true;d.imports[r.before].unknown=(d.imports[r.before].unknown||[]).filter(row=>!r.removeLines.includes(row.line));}
  d.erased||={};d.erased[c.id]={opId:receipt.opId,imageIds:c.imageIds,runIds:c.runIds,...(c.cancelledRuns?{cancelledRuns:c.cancelledRuns}:{})};
  if(!d.receipts[receipt.opId]) {d.rev++; d.receipts[receipt.opId]={...receipt,ledgerRev:d.rev,result:{...receipt.result,rev:d.rev}};}
  const reviewed=c.markdownResolutions?.find(r=>r.before===reviewedProjection);
  if(reviewed)d.projection={preserved:true,existingHash:reviewed.after};
  else if(c.preservedMarkdown?.includes(d.projection?.existingHash)&&!d.projection.hash)d.projection={...d.projection,preservedOrigin:{hash:d.projection.existingHash,rev:1}};
  else d.projection={hash:U.hash(projection.render(d)),rev:d.rev};
  require('./ideas').validate(d);return d;
}
function outputs(entries,c,ledgers,receipt,unmatched) {
  const result=new Map(),rendered=new Map();
  for(const l of ledgers)if(l.projection?.hash) {
    const bytes=Buffer.from(projection.render(sanitizedLedger(l,c,receipt)));
    rendered.set(l.projection.hash,bytes);
    for(const [old,h] of Object.entries(c.projections))if(h===U.hash(bytes))rendered.set(old,bytes);
  }
  function transform(e,bytes) {
    if(bytes===null)return null;
    if(e.kind.startsWith('wrapped-')){const out=transform({...e,kind:e.kind.slice(8)},unwrap(e,bytes));return out===null?null:Buffer.from(U.bytes({base64:out.toString('base64')}));}
    const rel=e.relative||'',name=path.basename(e.archiveOf||e.file);
    if(e.kind==='temporary')return null;
    if(e.kind==='ledger')return Buffer.from(U.bytes(sanitizedLedger(json(bytes),c,receipt,e.reviewedProjection)));
    if(e.kind==='image')return c.imageFiles.includes(name)?null:bytes;
    if(e.kind==='staging')return c.imageIds.some(id=>rel.includes('/'+id+'/'))?null:bytes;
    if(e.kind==='blob')return c.blobFiles.some(f=>path.basename(f)===name)?null:bytes;
    if(e.kind==='run'){const r=json(bytes);U.check(r.schema===1&&r.runId,'erase-format','実行資料の形式を確認してください',503);return c.runIds.includes(r.runId)||references(r.targets,new Set([c.id]))?null:bytes;}
    if(e.kind==='review')return c.reviewIds.some(id=>rel.startsWith('reviews/'+id+'/'))?null:bytes;
    if(e.kind==='verification')return c.evidenceIds.some(id=>rel.startsWith('verification/'+id+'/'))?null:bytes;
    if(e.kind==='import') {
      if(e.reviewedImport){const r=e.reviewedImport,hash=U.hash(bytes);if(hash===r.after)return bytes;U.check(hash===r.before,'erase-recovery','確認した取り込み控えが変わっています',503);const out=blankLines(bytes,r.removeLines);U.check(U.hash(out)===r.after,'erase-recovery','確認した取り込み控えを再構成できません',503);return out;}
      // Legacy in-flight journals still reconstruct their original output.
      const reviewed=c.markdownResolutions?.find(r=>r.before===e.reviewedMarkdown);
      if(reviewed)return U.hash(bytes)===reviewed.after?bytes:removeLines(bytes,reviewed.removeLines);
      const lines=c.imports[name.replace(/\.md$/,'')];if(!lines)return bytes;
      return Buffer.from(bytes.toString().split('\n').map((line,i)=>lines.includes(i+1)?'':line).join('\n'));
    }
    if(e.kind==='markdown') {
      const hash=U.hash(bytes),reviewed=c.markdownResolutions?.find(r=>r.before===e.reviewedMarkdown);
      if(reviewed){if(hash===reviewed.after)return bytes;const out=removeLines(bytes,reviewed.removeLines);U.check(U.hash(out)===reviewed.after,'erase-recovery','確認した原文を再構成できません',503);return out;}
      const known=rendered.get(U.hash(bytes));if(known)return known;
      // A legacy import may be the still-preserved original projection.
      const lines=c.imports[U.hash(bytes)];if(lines)return Buffer.from(bytes.toString().split('\n').map((line,i)=>lines.includes(i+1)?'':line).join('\n'));
      if(c.preservedMarkdown?.includes(U.hash(bytes)))return bytes;
      if(!bytes.length)return bytes;
      if(unmatched&&bytes.length){unmatched.set(hash,bytes);return bytes;}
      U.check(!Object.keys(c.projections).length && !Object.keys(c.imports).length,'erase-markdown','手で変更されたアイデア帳の境界を確認してから削除してください',409);
      U.check(bytes.length===0,'erase-markdown','未照合のアイデア帳があるため削除できません',409);return bytes;
    }
    if(e.kind==='owner'||e.kind==='backup')return bytes;
    throw U.fail('erase-format','未知の保存形式です',503);
  }
  for(const e of entries)result.set(e.file,transform(e,checked(e.file)));
  // Recalculate every current and archived backup index against its sanitized files.
  for(const e of entries.filter(e=>e.kind==='backup'&&checked(e.file)!==null)) {
    const b=json(checked(e.file)),base=path.dirname(e.archiveOf||e.file);
    b.files=b.files.filter(row=>result.get(path.join(base,row.path))!==null).map(row=>{
      const wrapped=result.get(path.join(base,row.path));U.check(wrapped,'erase-backup','保管資料の対応がありません',503);return {...row,hash:U.hash(Buffer.from(json(wrapped).base64,'base64'))};
    });
    const ledger=result.get(path.join(base,'ledger'));U.check(ledger,'erase-backup','保管台帳がありません',503);b.ledgerHash=U.hash(Buffer.from(json(ledger).base64,'base64'));b.redacted=true;
    result.set(e.file,Buffer.from(U.bytes(b)));
  }
  return result;
}
function plannedOutputs(entries,c,ledgers,receipt,unmatched) {
  for(const l of ledgers)if(l.projection?.hash)c.projections[l.projection.hash]=U.hash(projection.render(sanitizedLedger(l,c,receipt)));
  return outputs(entries,c,ledgers,receipt,unmatched);
}
// Split with the original LF/CRLF bytes attached. Unselected lines are never
// normalized, searched/replaced, or regenerated from the structured ledger.
function rawLines(bytes){return bytes.toString('utf8').match(/[^\n]*\n|[^\n]+$/g)||[];}
function removeLines(bytes,lines){const removed=new Set(lines);return Buffer.from(rawLines(bytes).filter((_,n)=>!removed.has(n+1)).join(''));}
// Legacy source.line and imports.unknown address the original line numbers.
// Keep those slots (and their original line endings) in import retention copies.
function blankLines(bytes,lines){const removed=new Set(lines);return Buffer.from(rawLines(bytes).map((line,n)=>removed.has(n+1)?line.match(/\r?\n$/)?.[0]||'':line).join(''));}
function markdownReview(entries,c,ledgers,receipt,d) {
  const unmatched=new Map();plannedOutputs(entries,c,ledgers,receipt,unmatched);
  // Hand edits can separate the live original from its import retention copy.
  // A manual review must cover both; a live document's selection cannot safely
  // be applied to a different copy using its shifted or stale line numbers.
  if(unmatched.size)for(const e of entries.filter(e=>e.kind.replace(/^wrapped-/,'')==='import')){const raw=checked(e.file);if(raw===null)continue;const bytes=unwrap(e,raw);if(bytes.length)unmatched.set(U.hash(bytes),bytes);}
  const target=[],kept=[];
  function collect(item,out){if(!item)return;out.push(...[item.id,...item.text.split(/\r?\n/).map(x=>x.trim())].filter(Boolean));for(const im of item.images||[])out.push(...[im.id,im.hash,im.name].filter(Boolean));for(const h of item.revisionHistory||[])collect(h.previous,out);}
  for(const l of ledgers)for(const item of Object.values(l.items))collect(item,item.id===c.id?target:kept);
  const documents=[...unmatched].map(([hash,bytes])=>{
    U.check(Buffer.from(bytes.toString('utf8')).equals(bytes),'erase-markdown-encoding','原文の文字コードを照合できません。原文は保持しています',409);
    const lines=rawLines(bytes).map(x=>x.replace(/\r?\n$/,'')),protectedLines=[],targetLines=[];
    lines.forEach((line,n)=>{
      const hasKept=kept.some(t=>line.includes(t)),hasTarget=target.some(t=>line.includes(t));
      // A whole-line decision cannot erase the target while preserving another
      // item's original on that same line. Refuse before issuing a review token
      // or writing an intent, including when only a retained copy is mixed.
      U.check(!(hasKept&&hasTarget),'erase-markdown-mixed','削除対象と他の項目の原文が同じ行にあり、安全に分けられないため削除できません。原文は保持しています',409);
      if(hasKept)protectedLines.push(n+1);else if(hasTarget)targetLines.push(n+1);
    });
    return {hash,lines,protectedLines,targetLines,canRemoveAll:ledgers.some(l=>l.items[c.id]?.text.trim()===bytes.toString('utf8').trim())};
  }).sort((a,b)=>a.hash.localeCompare(b.hash));
  // Seal the complete inventory, not just the visible document. New archives,
  // other-item edits and relocation all require a fresh human confirmation.
  const token=U.hash({id:c.id,rev:d.rev,files:entries.map(e=>{const bytes=checked(e.file);return [e.file,e.kind,bytes===null?null:U.hash(bytes)];}).sort((a,b)=>a[0].localeCompare(b[0]))});
  return {token,documents};
}
function resolveMarkdown(entries,c,ledgers,receipt,d,s,confirmation) {
  const review=markdownReview(entries,c,ledgers,receipt,d);
  if(!review.documents.length){U.check(!confirmation,'erase-markdown-changed','保存内容が変わりました。原文を確認し直してください',409);return;}
  U.check(confirmation?.confirmed===true&&confirmation.token===review.token&&Array.isArray(confirmation.documents),'erase-markdown','未照合の原文を画面で確認してから削除してください',409);
  U.check(confirmation.documents.length===review.documents.length&&new Set(confirmation.documents.map(r=>r.hash)).size===review.documents.length,'erase-markdown-review','すべての原文を確認してください',409);
  const current=checked(s.md),currentMarkdownHash=current===null?null:U.hash(current);
  c.markdownResolutions=review.documents.map(doc=>{
    const selected=confirmation.documents.find(r=>r.hash===doc.hash)?.removeLines;
    U.check(Array.isArray(selected)&&new Set(selected).size===selected.length&&selected.every(n=>Number.isSafeInteger(n)&&n>0&&n<=doc.lines.length&&!doc.protectedLines.includes(n)),'erase-markdown-review','他の項目の原文は削除できません。選んだ行を確認してください',409);
    U.check(doc.targetLines.every(n=>selected.includes(n)),'erase-markdown-review','削除対象の記載が残っています。該当する行を確認してください',409);
    const entry=entries.find(e=>['markdown','import'].includes(e.kind.replace(/^wrapped-/,''))&&checked(e.file)!==null&&U.hash(unwrap(e,checked(e.file)))===doc.hash),bytes=unwrap(entry,checked(entry.file)),out=removeLines(bytes,selected);
    // An arbitrary unknown document may never be erased wholesale. Only a
    // document that is exactly one known target body can be wholly removed.
    U.check(!selected.length||out.toString('utf8').trim()||doc.canRemoveAll,'erase-markdown-review','対象不明の原文全体は削除できません。対象以外の行を残してください',409);
    return {before:doc.hash,after:U.hash(out),removeLines:[...selected].sort((a,b)=>a-b)};
  });
  // Bind each file to its original decision. One document's resulting bytes
  // can equal another document's input; content hash alone is then ambiguous.
  c.importResolutions={};
  for(const e of entries){
    const kind=e.kind.replace(/^wrapped-/,''),raw=checked(e.file);if(raw===null)continue;
    if(['markdown','import'].includes(kind)){
      const bytes=unwrap(e,raw),hash=U.hash(bytes),r=c.markdownResolutions.find(r=>r.before===hash);
      if(r&&kind==='markdown')e.reviewedMarkdown=hash;
      if(r&&kind==='import'){
        e.reviewedImport={before:hash,after:U.hash(blankLines(bytes,r.removeLines)),removeLines:r.removeLines};
        const key=path.basename(e.archiveOf||e.file).replace(/\.md$/,'');
        c.importResolutions[key]=[...new Set([...(c.importResolutions[key]||[]),...r.removeLines])];
      }
    }
    if(kind==='ledger'){
      const l=json(unwrap(e,raw)),hash=e.file===s.file?currentMarkdownHash:l.projection?.existingHash||l.projection?.hash;
      if(c.markdownResolutions.some(r=>r.before===hash))e.reviewedProjection=hash;
    }
  }
}
const prefix=(partial,bytes)=>partial.length<=bytes.length&&bytes.subarray(0,partial.length).equals(partial);
function execute(ideas,s,intent) {
  U.check(intent.schema===1&&intent.projectUid===s.projectUid&&Array.isArray(intent.files),'erase-intent','削除処理の記録を照合できません',503);
  // A private reentrancy guard; all public reads remain behind the durable journal.
  const map=new Map(intent.files.map(e=>[e.file,e])),current=new Map();
  U.check(map.size===intent.files.length,'erase-intent','削除記録の保存先が重複しています',503);
  for(const e of intent.files) {
    U.check(path.isAbsolute(e.file)&&path.resolve(e.file)===e.file&&(U.inside(ideas.control,e.file)||intent.external.includes(e.file)),'erase-scope','削除記録の保存範囲が一致しません',503);ideas.outside(path.dirname(e.file));
    const bytes=checked(e.file),h=bytes===null?null:U.hash(bytes);current.set(e.file,bytes);
    // A listed old temp can later be reused by this very erase. Check it below
    // against either its original hash or its parent's reconstructed output.
    if(e.kind!=='temporary')U.check(h===e.before||h===e.after,'erase-changed','削除中に保存内容が変わりました。結果の照合が必要です',503);
  }
  // Outputs can be rebuilt after any boundary; completed entries need no original payload.
  const unfinished=intent.files.filter(e=>{const b=current.get(e.file);return (b===null?null:U.hash(b))!==e.after;});
  const source=intent.files.filter(e=>e.kind.replace(/^wrapped-/,'')==='ledger'&&current.get(e.file)!==null).map(e=>json(unwrap(e,current.get(e.file))));
  const out=outputs(intent.files,intent.context,source,intent.receipt);
  const writes=intent.files.filter(e=>e.kind!=='temporary'&&e.after!==null&&e.before!==e.after);
  for(const e of intent.files) {
    const bytes=out.get(e.file);
    U.check(bytes===null&&e.after===null||bytes&&U.hash(bytes)===e.after,'erase-recovery','削除後の資料を再構成できません',503);
    if(e.kind==='temporary') {
      const b=current.get(e.file),h=b===null?null:U.hash(b),parent=writes.find(w=>w.file+'.tmp'===e.file);
      U.check(h===e.before||h===e.after||parent&&b!==null&&prefix(b,out.get(parent.file)),'erase-changed','削除中の一時保存が変わりました。結果の照合が必要です',503);
    }
  }
  // Only this intent's changed targets may own new safe-file scratch files.
  // Validate ALL paths/hashes/prefixes before removing even one partial write.
  const scratch=[];
  for(const e of writes) {
    const tmp=e.file+'.tmp',bytes=checked(tmp);if(bytes===null)continue;
    const listed=map.get(tmp);
    U.check(listed?.kind==='temporary'&&U.hash(bytes)===listed.before||prefix(bytes,out.get(e.file)),'erase-changed','削除中の一時保存を照合できません',503);
    scratch.push(tmp);
  }
  for(const tmp of scratch){fs.unlinkSync(tmp);ideas.atomicDirectory(tmp);}
  unfinished.sort((a,b)=>(a.kind==='temporary'?-1:b.kind==='temporary'?1:a.file===s.file?-1:b.file===s.file?1:0));
  for(const e of unfinished) {
    const bytes=e.after===null?null:out.get(e.file);
    U.check(bytes===null&&e.after===null||bytes&&U.hash(bytes)===e.after,'erase-recovery','削除後の資料を再構成できません',503);
    if(bytes===null){if(exists(e.file)){fs.unlinkSync(e.file);ideas.atomicDirectory(e.file);}}
    else {ideas.atomic.recoverAtomic(e.file,bytes);ideas.syncFile(e.file);ideas.atomicDirectory(e.file);}
    ideas.fault(e.kind==='markdown'?'erase-projection':'erase-file',{file:e.file,op:intent.opId});
  }
  for(const e of map.values()){const b=checked(e.file);U.check((b===null?null:U.hash(b))===e.after,'erase-verify','削除の全保存先を照合中です',503);}
  for(const e of writes)U.check(checked(e.file+'.tmp')===null,'erase-verify','削除中の一時保存を照合中です',503);
  ideas.fault('erase-final',{op:intent.opId});fs.unlinkSync(journal(s));ideas.atomicDirectory(journal(s));
}
function preparation(s) {
  const names=exists(s.controlDir)?fs.readdirSync(s.controlDir).filter(n=>n.startsWith('erase-intent.')&&n.endsWith('.preparing')):[];
  U.check(names.length<=1,'erase-intent','削除記録の準備状態を照合してください',503);
  if(!names.length)return null;
  const hash=names[0].match(/^erase-intent\.([a-f0-9]{64})\.preparing$/)?.[1],file=path.join(s.controlDir,names[0]);noLinks(file);
  U.check(hash&&fs.lstatSync(file).isDirectory()&&!fs.readdirSync(file).length,'erase-intent','削除記録の準備状態を照合してください',503);
  return {file,hash};
}
function prepare(ideas,s,intent) {
  const f=journal(s),bytes=U.bytes(intent),marker=path.join(s.controlDir,'erase-intent.'+U.hash(bytes)+'.preparing');
  U.check(checked(f)===null&&checked(f+'.tmp')===null&&!preparation(s),'erase-intent','削除記録の準備を照合してください',503);noLinks(marker);
  // mkdir is atomic: it binds this previously absent journal/tmp to its output
  // hash before the first fd write. No item mutation starts until it is retired.
  fs.mkdirSync(marker,{mode:0o700});ideas.atomicDirectory(marker);
  ideas.atomic.recoverAtomic(f,bytes);ideas.syncFile(f);ideas.atomicDirectory(f);
  fs.rmdirSync(marker);ideas.atomicDirectory(marker);
}
function recover(ideas,project,s) {
  const f=journal(s);if(!exists(f)&&!exists(f+'.tmp')&&!preparation(s))return;
  ideas.lock(path.join(s.controlDir,'writer.owner'));
  try {
    const marker=preparation(s),bytes=checked(f),tmp=checked(f+'.tmp');
    if(marker) {
      if(bytes!==null)U.check(U.hash(bytes)===marker.hash,'erase-changed','削除記録の内容が変わっています',503);
      else {
        let v;try{v=JSON.parse(tmp);}catch{}
        // A complete JSON prefix (e.g. just the final LF missing) is rebuildable.
        const rebuilt=v&&Buffer.from(U.bytes(v));
        if(rebuilt){U.check(U.hash(rebuilt)===marker.hash&&v.schema===1&&v.projectUid===s.projectUid&&prefix(tmp,rebuilt),'erase-intent','削除記録を照合してください',503);if(!tmp.equals(rebuilt)){fs.unlinkSync(f+'.tmp');ideas.atomicDirectory(f);}ideas.atomic.recoverAtomic(f,rebuilt);ideas.syncFile(f);ideas.atomicDirectory(f);}
        else {
          // No committed intent means no item was changed. Only this sealed,
          // exclusively owned pre-commit scratch may be abandoned, never sources.
          if(tmp!==null){fs.unlinkSync(f+'.tmp');ideas.atomicDirectory(f);}
          fs.rmdirSync(marker.file);ideas.atomicDirectory(marker.file);return;
        }
      }
      if(bytes!==null&&tmp!==null){U.check(prefix(tmp,bytes),'erase-changed','削除記録の一時保存が変わっています',503);fs.unlinkSync(f+'.tmp');ideas.atomicDirectory(f);}
      fs.rmdirSync(marker.file);ideas.atomicDirectory(marker.file);
    } else if(bytes===null&&tmp!==null) {
      // Legacy complete journals keep their exact-match recovery. An unsealed
      // ambiguous fragment is deliberately not discarded.
      const v=json(tmp);U.check(v.schema===1&&v.projectUid===s.projectUid,'erase-intent','削除記録を照合してください',503);ideas.atomic.recoverAtomic(f,tmp);ideas.syncFile(f);ideas.atomicDirectory(f);
    } else U.check(tmp===null,'erase-intent','削除記録の一時保存を照合してください',503);
    if(exists(f))execute(ideas,s,json(checked(f)));
  }catch(e){throw U.fail(e.code||'erase-pending','削除処理中です。完了の照合を待っています：'+e.message,503,'unknown');}
}
function erase(ideas,project,b) {
  U.opId(b.opId);U.opId(b.id);U.check(b.confirm===true,'erase-confirm','完全に削除する項目を確認してください',400);
  const s=ideas.resolve(project);U.check(s,'item','項目が見つかりません',404);ideas.lock(path.join(s.controlDir,'writer.owner'));
  recover(ideas,project,s);ideas.recoverFile(s.file);
  const d=ideas.read(project),payload={kind:'delete',...b},bodyHash=U.hash(payload),prior=d.receipts[b.opId];
  if(prior){U.check(prior.bodyHash===bodyHash,'op-conflict','同じ送信識別の内容が変わっています');return {saved:true,receipt:prior,...prior.result};}
  const item=d.items[b.id];U.check(item,'item','項目が見つかりません',404);U.check(item.contentRev===b.baseContentRev&&item.controlRev===b.baseControlRev,'item-revision','項目が更新されました。表示を読み直してください');
  const {entries,c,ledgers}=preflight(ideas,project,s,d,b.id),receipt={opId:b.opId,bodyHash,at:new Date(ideas.clock()).toISOString(),result:{id:b.id,deleted:true,imageIds:c.imageIds}};
  resolveMarkdown(entries,c,ledgers,receipt,d,s,b.markdownReview);
  const out=plannedOutputs(entries,c,ledgers,receipt);
  const files=entries.map(e=>{const bytes=checked(e.file);return {...e,before:bytes===null?null:U.hash(bytes),after:out.get(e.file)===null?null:U.hash(out.get(e.file))};});
  const intent={schema:1,projectUid:s.projectUid,opId:b.opId,context:c,receipt,external:files.filter(e=>!U.inside(ideas.control,e.file)).map(e=>e.file),files};
  ideas.fault('erase-staging',{op:b.opId});
  try {prepare(ideas,s,intent);ideas.fault('erase-intent',{op:b.opId});execute(ideas,s,intent);}catch(e){throw U.fail(e.code||'erase-pending','削除処理中です。完了の照合を待っています：'+e.message,503,'unknown');}
  return ideas.receipt(project,b.opId);
}
module.exports={erase,recover,availability};
