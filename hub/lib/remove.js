'use strict';
const { lt } = require('./locale');
// 人が確認した対象だけをゴミ箱へ退避する。外の場所は明示選択と照合が必要。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash,createHmac,randomBytes}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {expandHome}=require('./store');
const gitw=require('./git');
const {trashRootFor,isTrashDestination}=require('./trash');
const hash=x=>createHash('sha256').update(x).digest('hex');
const inside=(a,b)=>b===a||b.startsWith(a+path.sep);
const exists=f=>{try{fs.lstatSync(f);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
// 保護対象や他プロジェクトの別名・リンク経由の同じ場所も照合する。
function canonical(f) {
 let q=path.resolve(f),tail=[];while(!exists(q)){tail.unshift(path.basename(q));const parent=path.dirname(q);if(parent===q)break;q=parent;}
 return path.resolve(fs.realpathSync(q),...tail).normalize('NFC');
}
// 不在の名前だけを比較する。既存の同一inodeでFSの別表記を確認し、実在別物は同一視しない。
function missingContains(a,b,witness,leafWitness=true) {
 let parent=path.dirname(a);while(!exists(parent))parent=path.dirname(parent);
 if(!inside(parent,b))return false;
 const left=path.relative(parent,a).split(path.sep),right=path.relative(parent,b).split(path.sep);
 if(left.length>right.length)return false;
 if(left.every((name,i)=>name===right[i]))return true;
 const device=fs.statSync(parent).dev;
 for(let q=parent;;q=path.dirname(q)){
  const st=fs.statSync(q);if(st.dev!==device)return false;
  const name=path.basename(q),alias=name.replace(/[A-Za-z]/,c=>c===c.toLowerCase()?c.toUpperCase():c.toLowerCase());
  if(alias!==name){const other=path.join(path.dirname(q),alias);if(!exists(other)||fs.lstatSync(other).isSymbolicLink())return false;const alt=fs.statSync(other);if(st.dev!==alt.dev||st.ino!==alt.ino)return false;
   // 葉は署名済み移動先、失われた親の名前は同じFS内の空の専用領域で照合する。
   // Unicodeの別表記を文字列変換で推測せず、既存資料は変更しない。
   if(witness&&exists(witness)){
    const actual=fs.statSync(witness),last=left.length-1;
    if(actual.dev!==device)return false;
    if(leafWitness){
     const otherName=path.join(path.dirname(witness),right[last]);
     if(!exists(otherName)||fs.lstatSync(otherName).isSymbolicLink())return false;
     const other=fs.statSync(otherName);if(actual.dev!==other.dev||actual.ino!==other.ino)return false;
    }
    let probe;
    try{
     for(let i=0;i<(leafWitness?last:left.length);i++)if(left[i]!==right[i]){
      probe??=fs.mkdtempSync(path.join(path.dirname(witness),'.name-check-'));
      const name=path.join(probe,left[i]),alias=path.join(probe,right[i]);
      fs.mkdirSync(name);
      try{if(!exists(alias)||fs.lstatSync(alias).isSymbolicLink())return false;
       const st=fs.statSync(name),alt=fs.statSync(alias);if(st.dev!==alt.dev||st.ino!==alt.ino)return false;
      }finally{fs.rmdirSync(name);}
     }
     return true;
    }finally{if(probe)fs.rmdirSync(probe);}
   }
   return left.every((name,i)=>name.toLowerCase()===right[i].toLowerCase());}
  if(q===path.dirname(q))return false;
 }
}
function containsPath(a,b,witness,leafWitness=true) {
 a=canonical(a);b=canonical(b);if(inside(a,b))return true;
 if(!exists(a))return missingContains(a,b,witness,leafWitness);const st=fs.statSync(a);
 for(let q=b;;q=path.dirname(q)){if(exists(q)){const other=fs.statSync(q);if(st.dev===other.dev&&st.ino===other.ino)return true;}if(q===path.dirname(q))break;}
 return false;
}
const overlaps=(a,b,witness)=>containsPath(a,b,witness)||containsPath(b,a,witness,false);
function noLinks(f) {for(let q=path.resolve(f);;q=path.dirname(q)){if(exists(q)&&fs.lstatSync(q).isSymbolicLink())throw Error(lt('リンクを含む場所は移せません'));if(q===path.dirname(q))break;}}
function copyContains(base,ref,dir=process.cwd()) {
 // .. はリンク先を辿った後に処理する。不在配下もリンク先の実在親で照合する。
 // 最終先が外でも、途中でコピーを通る参照は移動すると切れるため残す。
 const target=fs.statSync(base),parts=(path.isAbsolute(ref)?ref:dir+path.sep+ref).split(path.sep);
 let q=path.parse(base).root,links=0;
 while(parts.length){
  const part=parts.shift();if(!part||part==='.')continue;
  if(part==='..'){q=path.dirname(q);continue;}
  const next=path.join(q,part);let st;
  try{st=fs.lstatSync(next);}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;q=next;continue;}
  if(st.dev===target.dev&&st.ino===target.ino)return true;
  if(st.isSymbolicLink()){
   if(++links>40)throw Error(lt('共有参照のリンクを解決できません。作業用コピーを残します'));
   const to=fs.readlinkSync(next);if(path.isAbsolute(to))q=path.parse(to).root;
   parts.unshift(...to.split(path.sep));
  }else q=fs.realpathSync(next);
 }
 for(;;){
  try{const st=fs.statSync(q);if(st.dev===target.dev&&st.ino===target.ino)return true;}
  catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}
  const parent=path.dirname(q);if(parent===q)return false;q=parent;
 }
}
function externalShared(base,ref,dir,witness) {
 // 生の参照を実体順に辿る。途中依存と、移動済みの不在候補も保護する。
 // storeのexpandHomeは..を整理するため、ここでは残りをそのまま連結する。
 if(ref.startsWith('~'))ref=os.homedir()+path.sep+ref.slice(1);
 const parts=(path.isAbsolute(ref)?ref:dir+path.sep+ref).split(path.sep);
 let q=path.parse(base).root,links=0;
 while(parts.length){
  const part=parts.shift();if(!part||part==='.')continue;
  if(part==='..'){q=path.dirname(q);continue;}
  const next=path.join(q,part);let st;
  try{st=fs.lstatSync(next);}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}
  if(st?.isSymbolicLink()){
   if(++links>40)throw Error(lt('共有参照のリンクを解決できません。外の場所を残します'));
   const to=fs.readlinkSync(next);if(path.isAbsolute(to))q=path.parse(to).root;
   parts.unshift(...to.split(path.sep));
  }else{
   q=st?fs.realpathSync(next):next;
   if(containsPath(base,q,witness))return true;
  }
 }
 return overlaps(base,q,witness);
}
function snapshot(f,{contentOnly=false}={}) {
 noLinks(f);let n=0,bytes=0;const rows=[];
 const walk=q=>{if(++n>20000)throw Error(lt('ファイルが多すぎて照合できません'));const st=fs.lstatSync(q);if(st.isSymbolicLink()||!st.isFile()&&!st.isDirectory())throw Error(lt('リンクや特殊なファイルを含むため移せません'));bytes+=st.isFile()?st.size:0;if(bytes>256*1024*1024)throw Error(lt('照合できる大きさを超えています'));const rel=path.relative(f,q),digest=st.isFile()?hash(fs.readFileSync(q)):'';rows.push(contentOnly?[rel,st.mode,st.isFile()?st.size:0,digest]:[rel,st.ino,st.size,st.mtimeMs,digest]);if(st.isDirectory())for(const x of fs.readdirSync(q).sort())walk(path.join(q,x));};walk(f);return hash(JSON.stringify(rows));
}
function referenceTexts(text,file) {
 if(!/\.jsonl?$/.test(file))return [text];
 const out=[];
 for(const part of file.endsWith('.jsonl')?text.split('\n'):[text]){
  let value;try{value=JSON.parse(part);}catch{out.push(part);continue;}
  const pending=[value];while(pending.length){const v=pending.pop();if(typeof v==='string')out.push(v);else if(v&&typeof v==='object')for(const x of Object.values(v))pending.push(x);}
 }
 return out;
}
class Removal {
 constructor({store,busy=()=>false,locked=()=>false,reviewBusy=()=>false,trash=process.env.HUB_TRASH||path.join(os.homedir(),'.Trash'),rename=fs.renameSync}){Object.assign(this,{store,busy,locked,reviewBusy,trash,rename});this.tokens=new Map();this.records=path.join(store.root,'_hub/removed');}
 trashFor(source){return trashRootFor(source,this.trash);}
 trashDestination(source,destination){return isTrashDestination(source,destination,this.trash);}
 workRoot(p){return path.join(this.store.root,'Work',p.id);}
 copyInfo(p,dir,{removal=true}={}){
  noLinks(dir);
  const body=p.folders.find(f=>f.label==='本体'),base=body?path.resolve(p.dir,expandHome(body.path)):p.dir;
  noLinks(base);
  const main=gitw.repoTop(base),top=gitw.repoTop(dir),origin=gitw.mainOf(dir);
  if(!main||!top||!origin||fs.realpathSync(top)!==fs.realpathSync(dir)||fs.realpathSync(origin)!==fs.realpathSync(main))throw Error(lt('作業用コピーと本体の関係を確認できません。コピーを残します'));
  const state=gitw.inspect(dir);
  if(!removal){if(!state)throw Error(lt('作業用コピーの登録を確認できません'));return {main,head:state.head,branch:state.branch};}
  if(!state||state.status||gitw.merging(dir)||!gitw.isAncestor(main,state.head))throw Error(lt('未保存または未統合の変更があるため作業用コピーを残します'));
  // 表示設定で未追跡を隠せても削除では必ず検出。変更検出を省略するフラグは安全側で拒否する。
  const run=args=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
  if(run(['status','--porcelain=v1','--untracked-files=all']))throw Error(lt('未保存または未統合の変更があるため作業用コピーを残します'));
  if(run(['ls-files','-v','-z']).split('\0').some(row=>/^[a-zS] /.test(row)))throw Error(lt('Gitの変更検出を省略する設定があるため作業用コピーを残します'));
  // .envなどの保存対象外の追加・変更も保護。本体から写した同じ内容だけ許す。
  const ignored=execFileSync('git',['-C',dir,'ls-files','--others','--ignored','--exclude-standard','-z'],{encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean);
  let bytes=0;if(ignored.length>20000)throw Error(lt('保存対象外のファイルが多すぎるためコピーを残します'));
  for(const rel of ignored){const src=path.join(dir,rel),original=path.join(main,rel);noLinks(src);noLinks(original);const st=fs.lstatSync(src),other=exists(original)?fs.lstatSync(original):null;
   if((bytes+=st.size)>256*1024*1024||!st.isFile()||!other?.isFile()||st.size!==other.size||st.mode!==other.mode||hash(fs.readFileSync(src))!==hash(fs.readFileSync(original)))throw Error(lt('保存対象外のファイルに本体と異なる内容があります。作業用コピーを残します'));
  }
  return {main,head:state.head,branch:state.branch};
 }
 entryAllowed(r,e){
  const root=path.join(this.store.product,r.project);
  if(e.from!==path.resolve(e.from)||e.to!==path.resolve(e.to)||!this.trashDestination(e.from,e.to))return false;
  if(!e.copy)return inside(root,e.from);
  return r.kind==='task'&&/^[A-Za-z0-9_-]+$/.test(r.task)&&e.from===path.join(this.store.root,'Work',r.project,r.task);
 }
 moveEntry(r,e,restore=false){
  const from=restore?e.to:e.from,to=restore?e.from:e.to;
  if(!e.copy){this.rename(from,to);return;}
  const p=this.store.readProject(r.project);
  if(!p||JSON.stringify(this.copyInfo(p,from,{removal:!restore}))!==JSON.stringify(e.copy))throw Error(lt('作業用コピーの登録が変わりました。移動せず残します'));
  // Gitの登録も移動先へ合わせる。ブランチを残し、元に戻せる状態を保つ。
  execFileSync('git',['-C',e.copy.main,'worktree','move','--',from,to],{stdio:['ignore','pipe','pipe']});
 }
 describe(project,task,{removableCopy=false}={}) {
  const p=this.store.readProject(project);if(!p)throw Error(lt('プロジェクトがありません'));const t=task&&p.tasks.find(x=>x.id===task);if(task&&!t)throw Error(lt('作業がありません'));
  // applyはtokenだけで呼ばれるため、確認時と実行時の両方で実体を保護する。
  if(p.kind==='freetalk')throw Error(require('./freetalk').PROTECTED);
  const all=this.store.listProjects(),d={project:p.id,task:t?.id||'',title:t?t.title:p.name,move:[],optional:[],keep:[],blockers:[],warnings:[],typed:false};
  const ref=(q,x)=>x===p.id||x===p.name;
  const ext=f=>path.resolve(p.dir,expandHome(f));
  for(const f of p.folders)if(!inside(p.dir,ext(f.path))&&!d.keep.some(x=>x.path===ext(f.path)))d.keep.push(this.externalCandidate(ext(f.path),p,all,Boolean(t)));
  if(this.reviewBusy(p.id))d.blockers.push(lt('AIが共有を確認中です。終わってから操作してください'));
  if(!t)for(const id of p.related){const q=all.find(q=>q.id===id||q.name===id);d.keep.push({path:q?.dir||String(id),why:lt('参考・関連のプロジェクトなので残します。そのプロジェクトの削除から操作してください'),selectable:false});}
  if(!t&&this.busy(p.id))d.blockers.push(lt('AIが作業中です。終わってから操作してください'));
  if(this.locked(p.id))d.blockers.push(lt('整理・確認が実行中です。終わってから操作してください'));
  const queue=x=>{const f=path.join(p.dir,'.ai/chat',x.id+'.queue.json');if(!exists(f))return false;try{const v=JSON.parse(fs.readFileSync(f,'utf8'));return !Array.isArray(v)||v.length>0;}catch{return true;}};
  for(const x of t?[t]:p.tasks){if(this.busy(p.id,x.id))d.blockers.push(lt('AIが作業中です。終わってから操作してください'));if(queue(x))d.blockers.push(lt('順番待ちを取り消してから操作してください'));}
  const copies=t?path.join(this.workRoot(p),t.id):this.workRoot(p);
  if(removableCopy&&t&&exists(copies))try{
   if(t.workdir&&(!inside(copies,path.resolve(expandHome(t.workdir)))||gitw.repoTop(expandHome(t.workdir))!==gitw.repoTop(copies)))throw Error(lt('作業用コピーの記録と場所が一致しません。先に記録を確認してください'));
   if(all.some(q=>q.folders.some(f=>copyContains(copies,expandHome(f.path),q.dir))||q.tasks.some(x=>!(q.id===p.id&&x.id===t.id)&&x.workdir&&copyContains(copies,expandHome(x.workdir)))))throw Error(lt('他の記録でも使う作業用コピーなので残します'));
   const copy=this.copyInfo(p,copies);
   d.move.push({path:copies,what:lt('変更のない作業用コピー'),copy});
  }catch(e){d.blockers.push(e.message);}
  else if(exists(copies)&&(t||fs.readdirSync(copies).length))d.blockers.push(lt('作業用コピーが残っています。先に本体への取り込みかコピーの片付けをしてください'));
  if(t?.workdir&&inside(this.workRoot(p),path.resolve(expandHome(t.workdir)))&&!d.move.some(x=>x.copy))d.blockers.push(lt('作業用コピーの記録が残っています。先に記録を片付けてください'));
  if(t) {
   if(all.some(q=>q.tasks.some(x=>!(q.id===p.id&&x.id===t.id)&&((q.id===p.id&&x.parent===t.id)||x.derivedFrom===`${p.id}/${t.id}`||(q.id===p.id&&x.derivedFrom===t.id)))))d.blockers.push(lt('下の作業や、この作業から派生した作業があります。先に整理してください'));
   for(const f of [this.store.taskFile(p.id,t.id),...['.jsonl','.json','.queue.json','.rules.md'].map(ext=>path.join(p.dir,'.ai/chat',t.id+ext))])if(exists(f))d.move.push({path:f,what:lt('作業ファイル・会話')});
   const temp=path.join(p.dir,'.ai/work',t.id);
   if(exists(temp))try { snapshot(temp); if(this.referenced(temp,p,t,all))throw Error(lt('他の記録から参照されています'));d.move.push({path:temp,what:lt('この作業の専用一時フォルダ')}); }catch(e){d.keep.push({path:temp,why:e.message});}
   const hdir=path.join(p.dir,'.ai/handoff');
   if(exists(hdir)) {
    noLinks(hdir);
    for(const name of fs.readdirSync(hdir))if(name.startsWith(t.id+'-')&&/^\d{8}-\d{6}-(claude|codex|agy|grok)\.md$/.test(name.slice(t.id.length+1))) {
     const f=path.join(hdir,name);
     try {if(this.referenced(f,p,t,all))d.keep.push({path:f,why:lt('他の記録から参照される引継ぎ資料は残します')});else d.move.push({path:f,what:lt('この作業のAI交代引継ぎ記録')});}catch(e){d.keep.push({path:f,why:e.message});}
    }
   }
   for(const f of [path.join(p.dir,'attachments',t.id),path.join(p.dir,'作業',t.id)])if(exists(f)){
    try {snapshot(f);if(this.referenced(f,p,t,all))throw Error(lt('他の台帳・作業・会話から参照されています'));d.optional.push({id:path.relative(p.dir,f),path:f,why:lt('この作業の専用フォルダ。必要な場合だけ選んでください')});}catch(e){d.keep.push({path:f,why:e.message});}
   }
  } else {
   if(p.id==='Project Hub'||p.name==='Project Hub'||path.dirname(p.dir)!==path.resolve(this.store.product))d.blockers.push(lt('Project Hub自身やProductの外は削除できません'));
   if(all.some(q=>q.id!==p.id&&(ref(q,q.parent)||ref(q,q.derivedFrom))))d.blockers.push(lt('下に子プロジェクトや分岐があります。先に下のプロジェクトを整理してください'));
   for(const q of all.filter(q=>q.id!==p.id)){
    for(const f of q.folders){const resolved=path.resolve(q.dir,expandHome(f.path));if(inside(p.dir,resolved))d.blockers.push(lt`「${q.name}」がこのフォルダ内を使っています`);}
    if(q.related.some(x=>ref(q,x)))d.warnings.push(lt`「${q.name}」の関連の記載は残り、リンク切れになります`);
   }
   try {noLinks(p.dir);let top;try{top=execFileSync('git',['-C',p.dir,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch(e){if(e.status!==128)throw e;}
    if(top&&fs.realpathSync(top)!==fs.realpathSync(p.dir)) {const names=execFileSync('git',['-C',top,'ls-files','-z','--',p.dir],{encoding:'utf8'});if(names)d.blockers.push(lt('外側のGitで追跡されています'));}
   }catch(e){d.blockers.push(e.message);}
   d.move.push({path:p.dir,what:lt('このプロジェクトのフォルダ全体（台帳・資料・成果物を含む）')});
   d.typed=['資料','成果物'].some(n=>exists(path.join(p.dir,n))&&fs.readdirSync(path.join(p.dir,n)).length>0);
  }
  // Gitは移動時に.gitを同じ内容で書き直すため、コピーは配置・権限・内容で照合する。
  for(const x of [...d.move,...d.optional])try{x.fingerprint=snapshot(x.path,{contentOnly:Boolean(x.copy)});}catch(e){d.blockers.push(e.message);}
  d.blockers=[...new Set(d.blockers)];return d;
 }
 externalReason(f,p,all,witness) {
  const home=os.homedir(),root=path.resolve(this.store.root);
  const protectedPaths=[home,...['Documents','Desktop','Downloads'].map(n=>path.join(home,n)),
   path.join(home,'Documents/AI-Workspace'),root,this.store.product,path.join(root,'Work'),path.join(root,'System/ProjectHub'),this.trash,this.records];
  if([this.trash,this.records,path.join(root,'_hub'),path.join(root,'System/ProjectHub')].some(q=>containsPath(q,f)))return lt('Hubのシステム・記録・ゴミ箱の中は選べません');
  if(f===path.parse(f).root||protectedPaths.some(q=>containsPath(f,q)))return lt('大事な場所そのものやその親は選べません');
  if(containsPath(f,p.dir))return lt('プロジェクトの親は選べません');
  for(const q of all.filter(q=>q.id!==p.id)) {
   if(overlaps(f,q.dir))return lt`「${q.name}」のフォルダと重なります。そのプロジェクトの削除から操作してください`;
   for(const fld of q.folders)if(externalShared(f,fld.path,q.dir,witness))return lt`「${q.name}」もこの場所を使っています`;
  }
  return '';
 }
 externalCandidate(f,p,all,task) {
  const x={id:'external:'+hash(f),path:f,external:true,why:lt('プロジェクトの外の場所。他と共有していないか確認し、必要なら一緒にゴミ箱へ移せます'),selectable:false,unavailableWhy:''};
  try {
   const reason=this.externalReason(f,p,all);if(reason)throw Error(reason);
   if(task)throw Error(lt('外の場所はプロジェクトの削除から選んでください'));
   noLinks(f);if(!exists(f))throw Error(lt('この場所は見つかりません'));
   let trash=this.trash;while(!exists(trash))trash=path.dirname(trash);noLinks(trash);
   if(fs.statSync(f).dev!==fs.statSync(trash).dev)throw Error(lt('別ディスクのため選べません。Finderで手動でゴミ箱へ移してください'));
   x.fingerprint=snapshot(f);x.selectable=true;
  }catch(e){x.unavailableWhy=e.message;if(/多すぎ|大きさ|リンク|特殊|太多|過多|大小|連結/.test(e.message))x.unavailableWhy+=lt('。Finderで手動でゴミ箱へ移してください');}
  return x;
 }
 approval(r) {
  return JSON.stringify({id:r.id,project:r.project,kind:r.kind,external:r.confirmedExternal});
 }
 approvalKey(create=false) {
  const file=path.join(this.store.root,'_hub/removal-key');noLinks(file);
  if(create&&!exists(file)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});}
  return fs.readFileSync(file);
 }
 seal(r){return createHmac('sha256',this.approvalKey(true)).update(this.approval(r)).digest('hex');}
 validEntry(r,e,root) {
  if(e.from!==path.resolve(e.from)||e.to!==path.resolve(e.to)||!this.trashDestination(e.from,e.to))return false;
  if(!e.external)return this.entryAllowed(r,e);
  if(e.copy)return false;
  try {
   if(r.kind!=='project'||!Array.isArray(r.confirmedExternal)||!r.externalSeal)return false;
   const seal=createHmac('sha256',this.approvalKey()).update(this.approval(r)).digest('hex');
   return seal===r.externalSeal&&r.confirmedExternal.some(x=>x.from===e.from&&x.to===e.to&&x.fingerprint===e.fingerprint&&x.id===e.id)&&
    !this.externalReason(e.from,{id:r.project,dir:root},this.store.listProjects(),e.to);
  }catch{return false;}
 }
 referenced(f,p,t,all){
  // 持ち主が明確でも、共有や読み切れない参照があれば残す。
  const texts=[];let count=0,bytes=0;
  for(const q of all){for(const fld of q.folders)if(inside(f,path.resolve(q.dir,expandHome(fld.path))))return true;
   for(const base of [path.join(q.dir,'PROJECT.md'),path.join(q.dir,'.ai/tasks'),path.join(q.dir,'.ai/chat')])if(exists(base)){
    const walk=x=>{noLinks(x);const st=fs.lstatSync(x);if(st.isDirectory()){for(const n of fs.readdirSync(x))walk(path.join(x,n));return;}if(q.id===p.id&&(x===this.store.taskFile(p.id,t.id)||path.basename(x).startsWith(t.id+'.')))return;
     if(++count>5000||(bytes+=st.size)>16*1024*1024)throw Error(lt('参照を確認しきれないため専用フォルダを残します'));for(const text of referenceTexts(fs.readFileSync(x,'utf8'),x))texts.push({text:text.normalize('NFC'),dir:q.dir.normalize('NFC')});};walk(base);
   }
  }
  // パス全体を参照元のプロジェクトから解決する。../ を保護し、
  // 受領コピー先の途中に含まれる元の相対パスは共有参照と誤認しない。
  const needle=f.normalize('NFC');
  return texts.some(({text,dir})=>{
   // 空白を含む絶対パスも従来どおり保護する。
   if(text.includes(needle))return true;
   const refs=[],tokens=/[^\s"'`<>(){}\[\],;:：|\\*]+/gu,marks=/[。！？「」『』（）、，；【】〈〉《》〔〕［］｛｝]/gu;
   // 引用の内側も、既にパスの途中なら独立した参照にしない。
   let quoteEnd=0;
   for(const m of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|「([^」\n]+)」|『([^』\n]+)』|（([^）\n]+)）|【([^】\n]+)】|〈([^〉\n]+)〉|《([^》\n]+)》|〔([^〕\n]+)〕|［([^］\n]+)］|｛([^｝\n]+)｝/g)){
    const prefix=text.slice(quoteEnd,m.index).match(/[^\s"'`<>(){}\[\],;:：|\\*]*$/u)[0];
    if(!prefix.includes('/')){refs.push(m.slice(1).find(x=>x));quoteEnd=m.index+m[0].length;}
   }
   for(const m of text.matchAll(tokens)){
    const token=m[0],slash=token.indexOf('/');if(slash<0)continue;
    // 全体のパスも保持し、読点・句点で並ぶ独立した参照を順に読む。
    // 実在するディレクトリ構成要素内の区切り文字では分断しない。
    const parts=[token];let from=0;
    for(const mark of token.matchAll(/[。！？、，；]/gu)){
     const prefix=token.slice(from,mark.index),firstSlash=prefix.indexOf('/'),nextSlash=token.indexOf('/',mark.index+1);
     if(firstSlash>=0&&nextSlash>=0){
      const starts=[0,...[...prefix.slice(0,firstSlash).matchAll(marks)].map(x=>x.index+1)];
      if(starts.some(start=>{try{return fs.statSync(path.resolve(dir,expandHome(token.slice(from+start,nextSlash)))).isDirectory();}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return false;throw e;}}))continue;
     }
     parts.push(token.slice(from,mark.index));from=mark.index+1;
    }
    parts.push(token.slice(from));
    for(const part of parts){
     const firstSlash=part.indexOf('/');if(firstSlash<0)continue;
     const starts=[0,...[...part.slice(0,firstSlash).matchAll(marks)].map(x=>x.index+1)];
     for(const start of starts){const ref=part.slice(start);refs.push(ref,ref.replace(/[。！？「」『』（）、，；【】〈〉《》〔〕［］｛｝]+$/u,''));}
    }
   }
   return refs.some(ref=>ref.includes('/')&&inside(needle,path.resolve(dir,expandHome(ref))));
  });
 }
 preview(project,task){const d=this.describe(project,task,{removableCopy:true}),token=randomUUID();for(const [k,v] of this.tokens)if(Date.now()-v.at>600000)this.tokens.delete(k);this.tokens.set(token,{at:Date.now(),d});return {...d,token};}
 save(r){noLinks(this.records);fs.mkdirSync(this.records,{recursive:true});const f=path.join(this.records,r.id+'.json');fs.writeFileSync(f+'.tmp',JSON.stringify(r,null,2));fs.renameSync(f+'.tmp',f);}
 apply({token,optional=[],confirm,typed}){
  const old=this.tokens.get(token);if(confirm!==true||!old||Date.now()-old.at>600000)throw Error(lt('もう一度削除内容を確認してください'));
  const d=this.describe(old.d.project,old.d.task,{removableCopy:true});if(d.blockers.length)throw Error(d.blockers.join(' / '));if(JSON.stringify(d)!==JSON.stringify(old.d))throw Error(lt('確認中に変わりました。もう一度確認してください'));
  if(d.typed&&typed!==d.title)throw Error(lt('プロジェクト名をそのまま入力してください'));if(!Array.isArray(optional)||new Set(optional).size!==optional.length||optional.some(id=>![...d.optional,...d.keep.filter(x=>x.external&&x.selectable)].some(x=>x.id===id)))throw Error(lt('移すものを選び直してください'));
  this.tokens.delete(token);
  const id=randomUUID(),name=`ProjectHub 削除 ${new Date().toISOString().replace(/[:.]/g,'-')} ${id}`,selected=[...d.optional,...d.keep.filter(x=>x.external&&x.selectable)].filter(x=>optional.includes(x.id)),files=[...d.move,...selected.filter(x=>!selected.some(y=>y!==x&&containsPath(y.path,x.path)&&(!containsPath(x.path,y.path)||selected.indexOf(y)<selected.indexOf(x))))];
  const destinations=new Map(files.map((x,i)=>{const trash=this.trashFor(x.path);noLinks(trash);fs.mkdirSync(trash,{recursive:true,mode:0o700});return [x.path,x.external?path.join(trash,name,'external',String(i),path.basename(x.path)):path.join(trash,name,'workspace',path.relative(this.store.root,x.path))];}));
  const r={id,at:new Date().toISOString(),kind:d.task?'task':'project',project:d.project,task:d.task,title:d.title,entries:files.map(x=>({from:x.path,to:destinations.get(x.path),moved:false,restored:false,fingerprint:x.fingerprint,...(x.external?{external:true,id:x.id}:{}),...(x.copy?{copy:x.copy}:{})})),error:''};
  r.confirmedExternal=r.entries.filter(e=>e.external).map(e=>({id:e.id,from:e.from,to:e.to,fingerprint:e.fingerprint}));if(r.confirmedExternal.length)r.externalSeal=this.seal(r);
  this.save(r);const failed=[];
  for(const e of r.entries){try{noLinks(e.from);noLinks(e.to);fs.mkdirSync(path.dirname(e.to),{recursive:true});e.moving=true;this.save(r);this.moveEntry(r,e);e.moved=true;e.moving=false;this.save(r);}catch(err){r.error=err.code==='EXDEV'?lt('同じディスクにないため移せません'):err.message;failed.push({path:e.from,why:r.error});this.save(r);break;}}
  return {ok:!failed.length,record:r.id,moved:r.entries.filter(e=>e.moved).map(e=>e.from),failed};
 }
 recover(r){
  // rename後、完了記録の保存前に止まった場合も、確認済みの内容から復元できる。
  let changed=false;const root=path.join(this.store.product,r.project);
  if(path.dirname(root)!==path.resolve(this.store.product)||(r.project==='Project Hub'&&r.kind!=='task'))return r;
  for(const e of r.entries){if(!e.moving&&!e.restoring)continue;
   if(e.from!==path.resolve(e.from)||e.to!==path.resolve(e.to)||!this.validEntry(r,e,root))continue;
   noLinks(e.from);noLinks(e.to);
   if(e.moving&&!exists(e.from)&&exists(e.to)&&snapshot(e.to,{contentOnly:Boolean(e.copy)})===e.fingerprint){e.moved=true;e.moving=false;changed=true;}
   if(e.restoring&&!exists(e.to)&&exists(e.from)&&snapshot(e.from,{contentOnly:Boolean(e.copy)})===e.fingerprint){e.restored=true;e.restoring=false;changed=true;}
  }
  if(changed)this.save(r);return r;
 }
 history(){try{noLinks(this.records);return fs.readdirSync(this.records).filter(n=>/^[\da-f-]{36}\.json$/.test(n)).map(n=>this.recover(JSON.parse(fs.readFileSync(path.join(this.records,n),'utf8')))).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100).map(r=>({id:r.id,at:r.at,title:r.title,project:r.project,task:r.task,count:r.entries.filter(e=>e.moved).length,external:r.entries.filter(e=>e.external&&e.moved).map(e=>e.from),restored:r.entries.filter(e=>e.moved).every(e=>e.restored),error:r.error}));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 restore(id,confirm){
  if(confirm!==true||!/^[\da-f-]{36}$/.test(id))throw Error(lt('記録を確認してください'));const file=path.join(this.records,id+'.json');noLinks(file);const r=this.recover(JSON.parse(fs.readFileSync(file,'utf8')));
  if(this.locked(r.project)||this.busy(r.project))throw Error(lt('AI・整理・確認が動いています。終わってから元に戻してください'));
  const root=path.join(this.store.product,r.project);if(path.dirname(root)!==path.resolve(this.store.product)||(r.project==='Project Hub'&&r.kind!=='task'))throw Error(lt('復元先が不正です'));
  let restored=0;const skipped=[];
  for(const e of r.entries.filter(e=>e.moved&&!e.restored))try{
   if(!this.validEntry(r,e,root))throw Error(lt('記録の場所が不正です'));noLinks(e.from);noLinks(e.to);
   if(snapshot(e.to,{contentOnly:Boolean(e.copy)})!==e.fingerprint)throw Error(lt('ゴミ箱の中身が変わっています。自動では戻しません'));
   if(exists(e.from))throw Error(lt('同名のファイルがあるため上書きしません'));if(r.kind==='task'&&!exists(path.join(root,'PROJECT.md')))throw Error(lt('プロジェクトを先に元に戻してください'));
   fs.mkdirSync(path.dirname(e.from),{recursive:true});e.restoring=true;this.save(r);this.moveEntry(r,e,true);e.restored=true;e.restoring=false;restored++;this.save(r);
  }catch(err){skipped.push({path:e.from,why:err.message});}
  return {ok:!skipped.length,restored,skipped};
 }
}
module.exports={Removal,snapshot,noLinks,inside,exists};
