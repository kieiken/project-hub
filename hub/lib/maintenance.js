'use strict';
// 選択式の整理、ゴミ箱への退避・復元、ローカル検証。
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {spawn}=require('./platform');
const {parseDoc}=require('./frontmatter');
const digest=x=>createHash('sha256').update(x).digest('hex');
const inside=(base,file)=>{base=base.normalize('NFC');file=file.normalize('NFC');return file===base || file.startsWith(base+path.sep);};
const DAY=86400000;
function noLinks(file) {
 let cur=path.resolve(file);
 while(true) {try {if(fs.lstatSync(cur).isSymbolicLink())throw Error('リンクを含む場所は整理できません');}catch(e){if(e.code!=='ENOENT')throw e;}const up=path.dirname(cur);if(up===cur)break;cur=up;}
}
function inventory(file) {
 noLinks(file);let count=0,bytes=0,newest=0,rows=[];
 function visit(f,depth) {
  if(++count>5000 || depth>6)throw Error('多すぎるため候補から除外しました');
  if(path.basename(f)==='.git')throw Error('Git履歴を含むため除外しました');
  const st=fs.lstatSync(f);if(st.isSymbolicLink() || !st.isDirectory() && !st.isFile())throw Error('通常のファイルではありません');
  newest=Math.max(newest,st.mtimeMs);bytes+=st.isFile()?st.size:0;
  if(bytes>64*1024*1024 || st.isFile() && st.size>16*1024*1024)throw Error('安全に照合するサイズの上限を超えました');
  rows.push([path.relative(file,f),st.size,st.mtimeMs,st.ino,st.isFile()?digest(fs.readFileSync(f)):'']);
  if(st.isDirectory())for(const n of fs.readdirSync(f).sort())visit(path.join(f,n),depth+1);
 }
 visit(file,0);return {fingerprint:digest(JSON.stringify(rows)),bytes,newest,files:rows.map(r=>path.join(file,r[0]))};
}
function scriptsAt(base) {
 const file=path.join(base,'package.json');let pkg;try {noLinks(file);pkg=JSON.parse(fs.readFileSync(file,'utf8'));} catch(e) {return [];}
 return ['test','lint','check','build'].filter(k=>typeof pkg.scripts?.[k]==='string').map(name=>{
  const command=pkg.scripts[name], allowed=/^(?:node|vitest|jest|eslint|tsc|biome|vite)(?:\s|$)/.test(command.trim()) && !/[;&|`\r\n]|\$\(|\b(?:claude|codex|agy|gemini|curl|wget|fetch|install|deploy|publish|delete|rm)\b/i.test(command);
  return {name,command,allowed,hash:digest(fs.readFileSync(file))};
 });
}
class Maintenance {
 constructor({store,baseOf,busy=()=>false,trash=process.env.HUB_TRASH || path.join(os.homedir(),'.Trash'),timeout=60000}) {
  Object.assign(this,{store,baseOf,busy,trash,timeout});this.previews=new Map();this.running=new Map();
  this.records=path.join(store.root,'_hub/cleanup');
 }
 project(id) {const p=this.store.readProject(id);if(!p)throw Error('プロジェクトがありません');return p;}
 bases(p) {return [...new Set([p.dir,this.baseOf(p)].map(d=>path.resolve(d)))];}
 locked(id) {const p=this.project(id);return [...this.running.keys()].some(k=>this.bases(this.project(k)).some(d=>this.bases(p).includes(d)));}
 idle(id) {if(this.busy(id) || this.locked(id))throw Error('同じプロジェクト・本体でAIまたは検証が動いています。終わってから実行してください');}
 targets(p) {
  const out=[{dir:path.join(p.dir,'.ai/work'),label:'一時ファイル',days:7}];
  for(const base of this.bases(p))for(const d of ['一時','過去版','履歴','tmp','temp','versions','backups','archive'])out.push({dir:path.join(base,'作業',d),label:'過去版・一時ファイル',days:30});
  return out;
 }
 preview(id) {
  const p=this.project(id), candidates=[], excluded=[], ownBases=this.bases(p),all=this.store.listProjects();
  const shared=all.filter(q=>this.bases(q).some(b=>ownBases.some(d=>b.normalize('NFC')===d.normalize('NFC'))) || require('./work-context').family(p,all).some(x=>x.id===q.id)).map(q=>q.dir);
  const roots=[...new Set([...ownBases,...shared])], refs=[], tracked=[];
  let scanned=0, scanPath="", scanSize=0;
  // 参照元を読み切れない場合は候補を出さない。原資料・成果物は走査対象にも整理対象にもしない。
  try {
   for(const base of roots) {
    noLinks(base);
    let top='';try {top=execFileSync('git',['-C',base,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch(e){/* Gitなし */}
    if(top) {const names=execFileSync('git',['-C',top,'ls-files','-z'],{encoding:'utf8',maxBuffer:2*1024*1024});tracked.push(...names.split('\0').filter(Boolean).map(n=>path.join(top,n)));}
    const walk=(d,depth)=>{scanPath=d;scanSize=0;
     if(depth>6)throw Error('参照の走査範囲を超えました');
     for(const ent of fs.readdirSync(d,{withFileTypes:true})) {
      if(++scanned>5000)throw Error('参照が多すぎるため、整理候補を出していません');
      if(['.git','node_modules','資料','成果物','.ai/work','vendor','dist','build'].includes(ent.name) || ent.isSymbolicLink())continue;
      const f=path.join(d,ent.name);scanPath=f;scanSize=0;
      if(this.targets(p).some(x=>inside(x.dir,f)) || f===path.join(p.dir,'.ai/chat'))continue;
      if(ent.isDirectory())walk(f,depth+1);
      else if(/\.(md|json|ya?ml|[cm]?js|tsx?|py|html|css|sh|txt)$/i.test(ent.name)) {const st=fs.statSync(f);scanSize=st.size;if(st.size>1024*1024)throw Error('大きい参照ファイルがあるため、整理候補を出していません');refs.push(fs.readFileSync(f,'utf8').normalize('NFC'));}
     }
    };walk(base,0);
   }
  } catch(e) {return {token:'',candidates:[],excluded:[{reason:e.message}],stopped:{reason:e.message,path:scanPath,size:scanSize},busy:this.busy(id)||this.locked(id),scripts:scriptsAt(this.baseOf(p)),history:this.history(id)};}
  const add=(files,label,days,chatTask)=>{
   try {
    const list=files.map(f=>({file:path.resolve(f),...inventory(f)}));
    if(list.some(x=>Date.now()-x.newest<days*DAY))throw Error(`${days}日以内に更新されました`);
    for(const x of list) {
     if(tracked.some(f=>inside(x.file,f)))throw Error('Gitで追跡されています');
     if(x.files.some(f=>refs.some(text=>text.includes(f.normalize('NFC')) || text.includes(path.relative(p.dir,f).normalize('NFC')) || (!chatTask && text.includes(path.basename(f).normalize('NFC'))))))throw Error('台帳・コード・記録から参照されています');
    }
    candidates.push({id:randomUUID(),label,paths:list.map(x=>x.file),bytes:list.reduce((n,x)=>n+x.bytes,0),fingerprint:digest(JSON.stringify(list.map(x=>[x.file,x.fingerprint]))),chatTask});
   } catch(e) {excluded.push({path:files[0],reason:e.message});}
  };
  for(const target of this.targets(p)) {
   if(!fs.existsSync(target.dir))continue;
   try {noLinks(target.dir);for(const name of fs.readdirSync(target.dir))add([path.join(target.dir,name)],target.label,target.days);} catch(e) {excluded.push({path:target.dir,reason:e.message});}
  }
  for(const task of p.tasks.filter(t=>t.state==='完了')) {
   const dir=path.join(p.dir,'.ai/chat'), names=[task.id+'.jsonl',task.id+'.json',task.id+'.queue.json'],files=names.map(n=>path.join(dir,n)).filter(f=>fs.existsSync(f));
   if(!files.length)continue;
   const q=path.join(dir,task.id+'.queue.json');let queued=false;
   try {if(fs.existsSync(q)) {const v=JSON.parse(fs.readFileSync(q,'utf8'));queued=!Array.isArray(v) || v.length>0;}} catch(e) {queued=true;}
   if(queued) {excluded.push({path:q,reason:'順番待ちの依頼があります'});continue;}
   add(files,`完了作業の会話履歴：${task.title}（再開は新しい会話）`,30,task.id);
  }
  const token=randomUUID();this.previews.set(token,{id,at:Date.now(),candidates});
  for(const [k,v] of this.previews)if(Date.now()-v.at>10*60000)this.previews.delete(k);
  return {token,candidates,excluded,busy:this.busy(id)||this.locked(id),scripts:scriptsAt(this.baseOf(p)),history:this.history(id)};
 }
 save(record) {noLinks(this.records);fs.mkdirSync(this.records,{recursive:true});const file=path.join(this.records,record.id+'.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(record,null,2));fs.renameSync(tmp,file);}
 history(id) {try{return fs.readdirSync(this.records).filter(n=>/^[\w-]+\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(this.records,n),'utf8'))).filter(r=>r.project===id).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,20).map(r=>({id:r.id,at:r.at,count:r.entries.length,restored:r.entries.every(e=>e.restored),error:r.error}));}catch(e){return [];}}
 apply(id,token,selected,confirm) {
  this.idle(id);const old=this.previews.get(token);
  if(confirm!==true || !old || old.id!==id || Date.now()-old.at>10*60000 || !Array.isArray(selected) || !selected.length || new Set(selected).size!==selected.length)throw Error('候補を確認して選び直してください');
  const picked=selected.map(key=>old.candidates.find(x=>x.id===key));if(picked.some(x=>!x))throw Error('候補が見つかりません');
  const fresh=this.preview(id).candidates;
  for(const c of picked)if(!fresh.some(x=>x.fingerprint===c.fingerprint && JSON.stringify(x.paths)===JSON.stringify(c.paths)))throw Error('候補または参照が変わりました。取得し直してください');
  noLinks(this.trash);fs.mkdirSync(this.trash,{recursive:true});
  const record={id:randomUUID(),project:id,at:new Date().toISOString(),entries:picked.flatMap(c=>c.paths.map(src=>({src,dest:path.join(this.trash,`${id}-${randomUUID()}-${path.basename(src)}`),fingerprint:inventory(src).fingerprint,restored:false}))),error:''};
  this.save(record);
  try {for(const e of record.entries) {fs.renameSync(e.src,e.dest);e.moved=true;this.save(record);}}
  catch(e) {record.error='一部を移せませんでした。記録から復元できます（'+e.code+'）';this.save(record);}
  this.previews.delete(token);return {ok:!record.error,id:record.id,moved:record.entries.filter(e=>e.moved).length,error:record.error};
 }
 restore(id,transaction,confirm) {
  this.idle(id);if(confirm!==true || !/^[0-9a-f-]{36}$/.test(transaction||''))throw Error('復元する記録を確認してください');
  const file=path.join(this.records,transaction+'.json');noLinks(file);const r=JSON.parse(fs.readFileSync(file,'utf8'));if(r.project!==id)throw Error('違うプロジェクトの記録です');
  const p=this.project(id),targets=this.targets(p).map(x=>x.dir),chatdir=path.join(p.dir,'.ai/chat');
  if(r.entries.some(e=>!e.restored && e.moved && !fs.existsSync(e.dest)))throw Error('ゴミ箱に復元用のファイルがありません');
  const entries=r.entries.filter(e=>!e.restored && fs.existsSync(e.dest));
  for(const e of entries) {
   if(typeof e.src!=='string' || path.resolve(e.src)!==e.src || typeof e.dest!=='string' || path.resolve(e.dest)!==e.dest)throw Error('復元先のパスが不正です');
   if(!targets.some(d=>inside(d,e.src) && d!==e.src) && !(path.dirname(e.src)===chatdir && p.tasks.some(t=>[t.id+'.jsonl',t.id+'.json',t.id+'.queue.json'].includes(path.basename(e.src)))))throw Error('復元先は許可された場所ではありません');
   if(path.dirname(e.dest)!==path.resolve(this.trash) || fs.existsSync(e.src))throw Error('復元先が存在するか、ゴミ箱の場所が違います。上書きはしません');
   noLinks(e.src);if(inventory(e.dest).fingerprint!==e.fingerprint)throw Error('ゴミ箱の中身が変わりました。自動で復元しません');
  }
  for(const e of r.entries.filter(e=>!e.restored && !e.moved && !fs.existsSync(e.dest) && fs.existsSync(e.src)))e.restored=true;
  this.save(r);
  for(const e of entries) {fs.mkdirSync(path.dirname(e.src),{recursive:true});fs.renameSync(e.dest,e.src);e.restored=true;this.save(r);}
  return {ok:true,restored:entries.length};
 }
 async verify(id,script,expectedHash,confirm) {
  this.idle(id);const p=this.project(id),base=this.baseOf(p),checks=[];
  const all=this.store.listProjects();
  const resolve=ref=>all.find(q=>q.id===ref) || (all.filter(q=>q.name===ref).length===1?all.find(q=>q.name===ref):null);
  const report=(name,ok,detail='')=>checks.push({name,ok,detail});
  for(const f of [path.join(p.dir,'PROJECT.md'),...p.tasks.map(t=>this.store.taskFile(id,t.id))]) {try {const text=fs.readFileSync(f,'utf8');report(path.basename(f),/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text),'先頭の台帳形式');}catch(e){report(path.basename(f),false,'読めません');}}
  if(p.parent) {let q=resolve(p.parent),seen=new Set([p.id]),ok=Boolean(q);while(q){if(seen.has(q.id)){ok=false;break;}seen.add(q.id);q=q.parent?resolve(q.parent):null;}report('プロジェクトの親',ok);}
  if(p.derivedFrom)report('分岐元プロジェクト',Boolean(resolve(p.derivedFrom)));
  for(const ref of p.related)report('関連プロジェクト：'+ref,Boolean(resolve(ref)));
  for(const f of p.folders.filter(x=>!/^参考/.test(x.label))) {
   const expanded=require('./store').expandHome(f.path);
   report(`フォルダ：${f.label}`,Boolean(expanded) && fs.existsSync(path.resolve(p.dir,expanded)),f.path);
  }
  for(const t of p.tasks) {
   if(t.workdir)report(`作業場所：${t.title}`,fs.existsSync(require('./store').expandHome(t.workdir)));
   if(t.parent)report(`親作業：${t.title}`,p.tasks.some(x=>x.id===t.parent));
   if(t.kind==='derived')report(`派生元：${t.title}`,Boolean(require('./work-context').sourceOf(p,t.derivedFrom,all)));
  }
  if(!script)return {ok:checks.every(c=>c.ok),checks,note:'構造確認のみです。実際のアプリの動作は未検証です。'};
  const choice=scriptsAt(base).find(x=>x.name===script);
  if(confirm!==true || !choice?.allowed || choice.hash!==expectedHash)throw Error('表示された検証コマンドを確認して選び直してください');
  this.running.set(id,true);
  try {
   const result=await new Promise(resolve=>{
    let output='',bytes=0,settled=false,child,timer,why='';
    const finish=(code)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({name:script,command:choice.command,ok:code===0&&!why,code,output,note:why});};
    const stop=reason=>{why=reason;try {process.kill(-child.pid,'SIGKILL');}catch(e) {child.kill('SIGKILL');}};
    try {child=spawn('npm',['--offline','--ignore-scripts','run',script],{cwd:base,env:process.env,detached:true,stdio:['ignore','pipe','pipe']});}
    catch(e){finish(null);return;}
    for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{bytes+=d.length;output=(output+d.toString()).slice(-20000);if(bytes>2*1024*1024)stop('出力が多いため停止しました');});
    child.on('error',e=>{why=e.message;finish(null);});child.on('close',finish);timer=setTimeout(()=>stop('時間内に終わらなかったため停止しました'),this.timeout);
   });
   return {ok:checks.every(c=>c.ok)&&result.ok,checks,result,note:'選んだ検証コマンドの結果です。画面の手動確認は別に行ってください。'};
  } finally {this.running.delete(id);}
 }
}
module.exports={Maintenance,inventory,scriptsAt};
