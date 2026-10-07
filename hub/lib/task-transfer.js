'use strict';
const { lt } = require('./locale');
// 成果の保存→短い受領通知→専用管理記録の退避。各段階を保存して再実行する。
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const chat = require('./chat'), git = require('./git');
const { readResults, verifyResults } = require('./task-results');
const { taskTarget, integrators, integrateBlock } = require('../public/project-order');
const { snapshot, noLinks, inside, exists } = require('./remove');
const hash = text => createHash('sha256').update(text).digest('hex');
const FINAL_CHECK = lt('成果を確認し、GitHubへの更新やソフト・ホームページの本番適用が必要な場合は、対象・変更内容・検証結果を整理して人に最終確認する。引渡しだけでpush・公開・本番適用は行わない。');
class TaskTransfer {
  constructor({ store, removal, baseOf = p => p.dir, integration = () => null, notify = () => {}, beforeCleanup = () => {} }) {
    Object.assign(this, { store, removal, baseOf, integration, notify, beforeCleanup }); this.tokens = new Map();
    this.dir = path.join(store.root, '_hub/task-handoffs');
  }
  file(project, task) { return path.join(this.dir, hash(project + '\0' + task) + '.json'); }
  read(project, task) { const f = this.file(project, task); noLinks(f); return exists(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
  save(r) { const f = this.file(r.project, r.task); noLinks(f); fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(r, null, 2)); fs.renameSync(f + '.tmp', f); }
  pending() {
    if (!exists(this.dir)) return []; noLinks(this.dir);
    return fs.readdirSync(this.dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).flatMap(n => {
      try { const f=path.join(this.dir,n); noLinks(f); const r=JSON.parse(fs.readFileSync(f,'utf8'));
        return r.complete || r.handedUp && !r.receiving || r.integrating ? [] : [{project:r.project,task:r.task,title:r.title,targetProject:r.targetProject,targetTask:r.targetTask}];
      } catch { return []; } // 壊れた記録は消さず、他の正常な引渡しの再開を妨げない。
    });
  }
  expectTitle(project, task, expected, receipt) {
    if (expected === undefined) return;
    const file = this.store.taskFile(project, task), title = file ? this.store.readTask(file).title : receipt?.title;
    if (title !== undefined && title !== expected) throw Error(lt`この結果の子作業はもうありません（同じ番号の別の作業「${title}」があります）`);
  }
  offers() {
    if(!exists(this.dir))return [];noLinks(this.dir);
    return fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).flatMap(n=>{try{const f=path.join(this.dir,n);noLinks(f);const r=JSON.parse(fs.readFileSync(f,'utf8'));return r.handedUp&&!r.complete?[{project:r.project,task:r.task,title:r.title,integrating:r.integrating}]:[];}catch{return [];}});
  }
  context(project, task, options = {}) {
    const all = this.store.listProjects(), p = all.find(x => x.id === project), t = p?.tasks.find(x => x.id === task);
    if (!t) throw Error(this.read(project,task)?.complete
      ? lt('この子作業はもう受け取って片付けてあります。受け取った成果は本作業の会話と［ファイルを見る］で確認できます。')
      : lt('この子作業は今はありません（片付けたか、名前を変えた可能性があります）'));
    const target = options.targetTask ? { project: all.find(x=>x.id===options.targetProject) } : options.offer ? integrators(p,t,all)[0] || taskTarget(p,t,all) : taskTarget(p, t, all);
    if (options.targetTask && target.project) target.task = target.project.tasks.find(x=>x.id===options.targetTask);
    if (!target?.task) throw Error(lt('この作業には本作業・派生元がありません'));
    if (options.integrating) { const reason = integrateBlock(target,p,t,all); if (reason) throw Error(reason); }
    if (t.kind === 'derived' && !require('./work-context').sourceOf(p,t.derivedFrom,all)) throw Error(lt('派生元が同じ大きなプロジェクト内にありません'));
    if (!options.integrating && !options.offer && target.task.state === '完了') throw Error(lt`本作業「${target.task.title}」を再開してから渡してください`);
    const d = this.removal.describe(project, task);
    if (options.integrating || options.offer) d.blockers = d.blockers.filter(x=>!x.startsWith(lt('作業用コピー')) && !(options.offer && x.startsWith(lt('下の作業や'))));
    if (this.removal.busy(target.project.id, target.task.id) || this.removal.locked(target.project.id)) d.blockers.push(lt('本作業でAI・整理・確認が動いています。終わってから渡してください'));
    if (!(t.state === '完了' || t.completionPending || t.steps.length && t.steps.every(x => x.done)) || t.question) d.blockers.push(lt('子作業の手順・質問が残っています。済ませてから渡してください'));
    if (!options.integrating && !options.offer && t.workdir && path.resolve(t.workdir) !== path.resolve(this.baseOf(p))) d.blockers.push(lt('作業場所の記録が残っています。先に［本体に取り込む］または［記録を片付ける］を行ってください'));
    if (!options.offer && all.some(q => q.tasks.some(x => !(q.id === p.id && x.id === t.id) && (() => { const src = taskTarget(q, x, all); return src?.project.id === p.id && src.task.id === t.id; })()))) d.blockers.push(lt('この作業に子作業・派生が残っています。先にそちらを渡してください'));
    if ((options.integrating || options.offer) && t.mergeExcluded) d.blockers.push(lt('取り込み対象から外されています'));
    return { p, t, target, d };
  }
  // 統合と完了確認は同じ成果宣言・候補・保存履歴を検査する。
  resultIssue(p, t) {
    const r = this.read(p.id, t.id);
    let rows, results = [], issue = null;
    try { rows = readResults(this.store.taskFile(p.id, t.id)); }
    catch (e) { issue = { code: 'format', reason: e.message }; }
    if (!issue) try { results = verifyResults(rows, p, this.baseOf(p)); }
    catch (e) { issue = { code: 'verify', reason: e.message }; }
    const candidates = r?.handedUp
      ? { files: r.files, selected: r.files.map(f => f.id), candidateError: null, skipped: { count: 0, bytes: 0 } }
      : this.candidates(p, t);
    const { files, candidateError } = candidates;
    if (!issue && candidateError) issue = { code: 'candidates', reason: candidateError };
    let fileError = candidateError;
    if (!fileError) try {
      for (const f of files) if (snapshot(f.path) !== f.fingerprint || f.mode !== undefined && (fs.statSync(f.path).mode & 0o777) !== f.mode)
        throw Error(lt('渡し済みの成果が変わっています。成果を渡し直してください'));
    } catch (e) { fileError = e.message; if (!issue) issue = { code: 'verify', reason: e.message }; }
    const wd = t.workdir?.startsWith('~/') ? path.join(require('node:os').homedir(), t.workdir.slice(2)) : t.workdir;
    const rel = wd && path.relative(this.removal.workRoot(p), wd);
    const copy = Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    const integrated = !copy ? this.integration(p, t) : null;
    const resultReady = results.some(r => r.kind === 'なし' || r.kind === '本体保存済み');
    const resultMissing = !issue && !files.length && !(copy && exists(wd) && git.inspect(wd)) && !integrated?.files?.length && !resultReady;
    if (resultMissing) issue = { code: 'missing', reason: lt('成果の記録がありません') };
    return { ok: !issue, ...issue, candidates, results, resultReady, resultMissing, integrated, fileError };
  }
  organizeRequest(p, t, reason = '') {
    return { project: p.id, task: t.id, title: lt('成果の記録を整理'), text: lt`目的：この作業の必要な成果をAIが整理し、人にファイル名で選ばせず統合できるようにする。
読む：この作業ファイルと必要な成果・本体の保存履歴。全文の「## 成果と保管」。
やる：所属・内容・重複・反映済みを確認し、この作業ファイルの「## 成果」にファイル／本体保存済み／なし（理由）の正しい記録と短い説明を書く。検出した理由：${reason}
条件：新しい作業・ZIPを作らない。既存成果を勝手に消さず、本体を旧版で上書きしない。人へファイル選別を求めない。実統合・公開はしない。未整理の成果を「なし」で隠さない。
出力：成果記録と照合根拠、実施済みの手順をこの会話へ返す。残件が無ければ完了条件を整える。
次：AI終了後、整った成果の完了確認を人へ返す。` };
  }
  artifactInfo(p, t, relative, location = 'project') {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => !x || x === '..' || x.startsWith('.')) || /[\0\r\n]/.test(relative)) throw Error(lt('成果ファイルはプロジェクト・本体内の相対パスで指定してください（隠しファイルは対象外）'));
    const parts = relative.split('/');
    if (['作業','成果物','attachments'].includes(parts[0]) && p.tasks.some(x => x.id !== t.id && x.id === parts[1])) throw Error(lt('他の作業の専用フォルダは渡せません'));
    const base = location === 'body' ? this.baseOf(p) : p.dir, f = path.resolve(base, relative);
    if (!inside(path.resolve(base), f)) throw Error(lt('成果ファイルの場所が不正です')); noLinks(f);
    const st = fs.statSync(f); if (!st.isFile()) throw Error(lt('成果はファイルごとに指定してください'));
    return { id: location + ':' + relative, path: f, relative, location, bytes: st.size, mode: st.mode & 0o777 };
  }
  artifacts(p, t, paths = []) {
    if (!Array.isArray(paths) || paths.length > 500) throw Error(lt('成果ファイルの指定を確認してください'));
    if (!paths.length) {
      const d = this.candidates(p, t); if (d.candidateError) throw Error(d.candidateError); return d.files;
    }
    const out = new Map(); let bytes = 0;
    // 明示指定はそのファイルだけを候補にする。過去の共有成果の量に左右されない。
    for (const input of paths) {
      if (typeof input !== 'string') throw Error(lt('成果ファイルのパスは文字列で指定してください'));
      const f = this.artifactInfo(p, t, input.replace(/^(body|project):/, ''), input.startsWith('body:') ? 'body' : 'project');
      if (out.has(f.id)) continue;
      bytes += f.bytes; if (out.size >= 500 || bytes > 64 * 1024 * 1024) throw Error(lt('成果の確認は500ファイル・64MB以内に分けてください'));
      out.set(f.id, { ...f, fingerprint: snapshot(f.path) });
    }
    return [...out.values()];
  }
  results(p, t) { return verifyResults(readResults(this.store.taskFile(p.id, t.id)), p, this.baseOf(p)); }
  candidates(p, t) {
    const files = [], selected = [], skipped = { count: 0, bytes: 0 }; let bytes = 0;
    const fits = f => files.length < 500 && bytes + f.bytes <= 64 * 1024 * 1024;
    const add = f => { files.push({ ...f, fingerprint: snapshot(f.path) }); bytes += f.bytes; };
    const walk = (dir, rel) => {
      if (!exists(dir)) return; noLinks(dir);
      for (const name of fs.readdirSync(dir).sort()) {
        if (name.startsWith('.')) continue;
        const next = path.join(dir, name), relative = rel + '/' + name; noLinks(next);
        if (fs.statSync(next).isDirectory()) { if (p.tasks.some(x => x.id !== t.id && x.id === name)) continue; walk(next, relative); }
        else {
          const f = this.artifactInfo(p, t, relative);
          if (!fits(f)) throw Error(lt('成果の確認は500ファイル・64MB以内に分けてください'));
          add(f); selected.push(f.id);
        }
      }
    };
    try {
      // 専用成果はすべて先に確保する。専用領域の超過は黙って省かない。
      for (const rel of ['作業','成果物','attachments']) walk(path.join(p.dir, rel, t.id), rel + '/' + t.id);
      const results = this.results(p, t);
      for (const r of results.filter(r => r.kind === 'ファイル')) {
        const f = this.artifactInfo(p, t, r.value.replace(/^(body|project):/, ''), r.value.startsWith('body:') ? 'body' : 'project');
        if (files.some(x => x.id === f.id)) { files.find(x => x.id === f.id).description = r.description; continue; }
        if (!fits(f)) throw Error(lt('成果の確認は500ファイル・64MB以内に分けてください'));
        add({ ...f, description: r.description }); selected.push(f.id);
      }
      return { files, selected, skipped, candidateError: null };
    } catch (e) {
      // 部分列挙を空成果や渡せる成果として扱わない。明示指定で再確認する。
      return { files: [], selected: [], skipped: { count: 0, bytes: 0 }, candidateError: e.message };
    }
  }
  filePreview(p, t, paths, blockers) {
    if (Array.isArray(paths) && !paths.length) {
      const d = this.candidates(p, t);
      if (d.candidateError) blockers.push(lt`自動候補を確認できませんでした：${d.candidateError}。子のAIに成果の整理を頼んでください`);
      return { ...d, fileError: Boolean(d.candidateError) };
    }
    try {
      const files = this.artifacts(p, t, paths);
      return { files, selected: files.map(f => f.id), skipped: { count: 0, bytes: 0 }, candidateError: null, fileError: false };
    } catch (e) {
      blockers.push(e.message);
      return { files: [], selected: [], skipped: { count: 0, bytes: 0 }, candidateError: null, fileError: true };
    }
  }
  preview(project, task, paths = [], expectTitle) {
    const pending = this.read(project, task);
    this.expectTitle(project,task,expectTitle,pending);
    if (pending && !pending.complete) return { token: this.token({ pending: pending.id, project, task }), title: pending.title, target: pending.targetName, files: pending.files, blockers: [], resume: true, destination: pending.destination, guidance: FINAL_CHECK };
    const { p, t, target, d } = this.context(project, task);
    if (pending?.complete) throw Error(lt('引渡し済みの作業が復元されています。受け取った成果を確認し、削除は［削除…］から行ってください'));
    const candidates = this.filePreview(p, t, paths, d.blockers), { files, fileError } = candidates;
    const integrated = this.integration(p, t);
    let results = []; try { results = this.results(p, t); } catch (e) { if (!fileError) d.blockers.push(e.message); }
    const resultReady = results.some(r => r.kind === 'なし' || r.kind === '本体保存済み');
    if (!fileError && !files.length && !integrated?.files?.length && !resultReady) d.blockers.push(lt('成果の記録がありません。子のAIに成果の整理を頼んでください'));
    const result = { project, task, title: t.title, target: `${target.project.name}／${target.task.title}`, targetProject: target.project.id, targetTask: target.task.id, taskHash: t.completionHash, targetHash: target.task.completionHash, files, results, resultReady, candidateError: candidates.candidateError, skipped: candidates.skipped, integrated, blockers: [...new Set(d.blockers)], move: d.move, keep: [...d.keep, ...d.optional].map(x => ({path:x.path, why:x.why || lt('成果の元ファイルは残します')})), guidance: FINAL_CHECK };
    return { ...result, token: this.token(result) };
  }
  token(value) { for (const [id, x] of this.tokens) if (Date.now() - x.at > 600000) this.tokens.delete(id); const token = randomUUID(); this.tokens.set(token, { at: Date.now(), value }); return token; }
  offerPreview(project, task, paths = [], expectTitle) {
    const r=this.read(project,task); this.expectTitle(project,task,expectTitle,r);
    if (r && !r.complete && !r.handedUp && !r.integrating) return this.preview(project,task,paths,expectTitle);
    if (r?.complete) return this.preview(project,task,paths,expectTitle);
    if (r?.integrating) throw Error(lt('祖先の統合が進行中です。祖先側で続きを行ってください'));
    const {p,t,target,d}=this.context(project,task,{offer:true});
    const candidates=this.filePreview(p,t,paths,d.blockers),{files,fileError}=candidates;
    const code=Boolean(t.workdir && path.resolve(t.workdir)!==path.resolve(this.baseOf(p))) || this.integration(p,t);
    let results = []; try { results = this.results(p, t); } catch (e) { if (!fileError) d.blockers.push(e.message); }
    const resultReady = results.some(r => r.kind === 'なし' || r.kind === '本体保存済み');
    if (!fileError && !files.length && !code && !resultReady) d.blockers.push(lt('成果の記録がありません。子のAIに成果の整理を頼んでください'));
    const value={project,task,title:t.title,taskHash:t.completionHash,targetProject:target.project.id,targetTask:target.task.id,target:`${target.project.name}／${target.task.title}`,files,results,resultReady,candidateError:candidates.candidateError,skipped:candidates.skipped,blockers:d.blockers,offer:true,hasCode:Boolean(code),selected:r?.files?.map(f=>f.id) || candidates.selected,guidance:FINAL_CHECK};
    return {...value,token:this.token(value)};
  }
  offer(b) {
    const x=this.tokens.get(b.token);
    if (!x?.value.offer) return this.apply(b); // 旧版で保存された途中の受領だけ再開。
    const d=x.value;
    if (Date.now()-x.at>600000 || b.confirm!==true || b.project!==d.project || b.task!==d.task) throw Error(lt('もう一度引渡し内容を確認してください'));
    this.expectTitle(b.project,b.task,b.expectTitle);
    if(d.blockers?.length)throw Error(d.blockers.join(' / '));
    const old=this.read(b.project,b.task);if(old?.integrating || old?.complete)throw Error(lt('統合・受領記録が変わりました'));
    const {p,t,target,d:now}=this.context(b.project,b.task,{offer:true});
    if(now.blockers.length)throw Error(now.blockers.join(' / '));
    if(d.results && JSON.stringify(this.results(p,t))!==JSON.stringify(d.results))throw Error(lt('確認中に成果の保存記録が変わりました'));
    if(t.completionHash!==d.taskHash || target.project.id!==d.targetProject || target.task.id!==d.targetTask)throw Error(lt('確認中に作業が変わりました'));
    const selected=b.selected || [];
    if(!Array.isArray(selected) || new Set(selected).size!==selected.length || selected.some(id=>!d.files.some(f=>f.id===id)))throw Error(lt('渡す成果ファイルを選び直してください'));
    const files=d.files.filter(f=>selected.includes(f.id));
    if(!files.length && !d.hasCode && !d.resultReady)throw Error(lt('成果ファイルを選んでください'));
    for(const f of files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))throw Error(lt('確認中に成果ファイルが変わりました'));
    const r={id:old?.id || randomUUID(),project:b.project,task:b.task,title:t.title,taskHash:t.completionHash,targetProject:target.project.id,targetTask:target.task.id,targetName:d.target,handedUp:true,files,results:d.results,resultReady:d.resultReady};this.save(r);
    if(!chat.read(target.project.dir,target.task.id).some(x=>x.offer===r.id))chat.append(target.project.dir,target.task.id,{role:'user',text:lt`子作業「${t.title}」の成果が渡されました。［統合…］で確認して統合できます。`,from:'subtask',child:b.task,childTitle:t.title,childProject:b.project,offer:r.id});
    this.notify(r.targetProject,r.targetTask,r.id);
    return {ok:true,handedUp:true,parent:r.targetTask,parentProject:r.targetProject,files:files.map(f=>f.path)};
  }
  // 同じlocation内の共通親を一式の境界とする。共有直下まで広がる場合は束ねない。
  bundleScopes(files) {
    const scopes=[];
    for(const location of new Set(files.map(f=>f.location))){
      const group=files.filter(f=>f.location===location);if(group.length<2)continue;
      let parts=path.dirname(group[0].relative).split(path.sep);
      for(const f of group)while(parts.length&&!inside(parts.join(path.sep),f.relative))parts.pop();
      const relative=parts.join(path.sep);
      if(!relative||relative==='.'||['作業','成果物','attachments'].includes(relative))continue;
      const rootOf=(f,key)=>path.resolve(f[key].slice(0,-path.relative(relative,f.relative).length));
      const source=rootOf(group[0],'path'),destination=rootOf(group[0],'to');
      if(group.some(f=>path.join(source,path.relative(relative,f.relative))!==f.path||path.join(destination,path.relative(relative,f.relative))!==f.to))throw Error(lt('旧受領の一式配置を確認できません。成果は保持しています'));
      const directory=rel=>{const q=path.join(source,rel);noLinks(q);return {path:rel,kind:'directory',mode:exists(q)?fs.statSync(q).mode & 0o777:fs.statSync(path.join(destination,rel)).mode & 0o777};};
      const entries=new Map([['',directory('')]]);
      for(const f of group){
        const rel=path.relative(relative,f.relative);
        entries.set(rel,{path:rel,kind:'file',digest:f.digest,mode:f.mode});
        for(let parent=path.dirname(rel);parent!=='.';parent=path.dirname(parent))entries.set(parent,directory(parent));
      }
      scopes.push({source,destination,expected:[...entries.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
    }
    return scopes;
  }
  bundleTree(root) {
    const rows=[];let count=0,bytes=0;
    const walk=q=>{
      noLinks(q);const st=fs.lstatSync(q);
      if(++count>20000||(bytes+=st.isFile()?st.size:0)>256*1024*1024)throw Error(lt('一式の照合対象が多すぎるか大きすぎます。AIに成果の整理を頼んでください'));
      if(!st.isFile()&&!st.isDirectory())throw Error(lt('一式に特殊なファイルがあります。成果は保持しています'));
      rows.push(st.isDirectory()?{path:path.relative(root,q),kind:'directory',mode:st.mode & 0o777}:{path:path.relative(root,q),kind:'file',digest:hash(fs.readFileSync(q)),mode:st.mode & 0o777});
      if(st.isDirectory())for(const name of fs.readdirSync(q).sort())walk(path.join(q,name));
    };
    if(exists(root))walk(root);
    return rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  }
  prepareBundles(r) {
    r.bundles=this.bundleScopes(r.files);
    for(const b of r.bundles)if(exists(b.source)){
      b.sourceTree=this.bundleTree(b.source);
      // 正本そのものが元なら、宣言外の内容もそこに保持して照合する。
      if(path.resolve(b.source)===path.resolve(b.destination))b.expected=b.sourceTree;
    }
  }
  checkBundles(r, partial=false) {
    for(const scope of r.bundles || []){
      const actual=this.bundleTree(scope.destination),expected=scope.expected;
      if(partial?actual.some(x=>!expected.some(e=>JSON.stringify(e)===JSON.stringify(x))):JSON.stringify(actual)!==JSON.stringify(expected))throw Error(lt('一式の未受領内容または保存先の一覧・内容・権限が変わりました。原物を保持します'));
      if(scope.sourceTree&&(!r.cleanup||exists(scope.source))&&JSON.stringify(this.bundleTree(scope.source))!==JSON.stringify(scope.sourceTree))throw Error(lt('一式の未受領内容または元の一覧・内容・権限が変わりました。原物を保持します'));
    }
  }
  receiptFiles(files, target, destination) {
    const prepared=files.map(f=>({...f,digest:hash(fs.readFileSync(f.path)),mode:fs.statSync(f.path).mode & 0o777}));
    const sizes=new Set(files.map(f=>f.bytes)), found=[];let count=0,bytes=0;
    const walk=dir=>{
      if(!exists(dir))return;noLinks(dir);
      for(const name of fs.readdirSync(dir).sort()){
        if(name.startsWith('.'))continue;
        const f=path.join(dir,name),st=fs.lstatSync(f);
        if(st.isSymbolicLink()||!st.isFile()&&!st.isDirectory())continue;
        if(++count>20000)throw Error(lt('重複の照合対象が多すぎます。AIに成果の整理を頼んでください'));
        if(st.isDirectory()){walk(f);continue;}
        if(!sizes.has(st.size))continue;
        if((bytes+=st.size)>256*1024*1024)throw Error(lt('重複の照合対象が大きすぎます。AIに成果の整理を頼んでください'));
        found.push({path:f,digest:hash(fs.readFileSync(f)),mode:st.mode & 0o777});
      }
    };
    if(files.length)walk(path.join(target.dir,'成果物'));
    const matches=(f,to)=>{
      noLinks(to);if(!exists(to))return false;
      const st=fs.statSync(to);return st.isFile()&&st.size===f.bytes&&(st.mode & 0o777)===f.mode&&hash(fs.readFileSync(to))===f.digest;
    };
    let destinations=null;
    // 正本内の一式は元の配置をそのまま使う。別々の場所の同内容を束ねない。
    if(prepared.length&&prepared.every(f=>inside(path.join(target.dir,'成果物'),f.path)&&matches(f,f.path)))destinations=prepared.map(f=>f.path);
    if(!destinations&&prepared.length===1){
      const f=prepared[0],same=found.find(x=>x.digest===f.digest&&x.mode===f.mode);
      if(same)destinations=[same.path];
    }
    if(!destinations&&prepared.length>1){
      // 再利用は全成果の相対配置・内容・権限が揃う既存の一式単位だけ。
      const first=prepared[0],suffix=path.join(first.location,first.relative);
      for(const x of found){
        if(!x.path.endsWith(path.sep+suffix))continue;
        const root=x.path.slice(0,-suffix.length),paths=prepared.map(f=>path.join(root,f.location,f.relative));
        if(!prepared.every((f,n)=>matches(f,paths[n])))continue;
        const scopes=this.bundleScopes(prepared.map((f,n)=>({...f,to:paths[n]})));
        if(!scopes.length||prepared.some(f=>prepared.filter(x=>x.location===f.location).length>1&&!scopes.some(b=>inside(b.source,f.path))))continue;
        // 隠しファイル・空フォルダも含む双方向照合。不明な旧一式は変更せず使わない。
        let identical=false;
        try{identical=scopes.every(b=>JSON.stringify(this.bundleTree(b.source))===JSON.stringify(b.expected)&&JSON.stringify(this.bundleTree(b.destination))===JSON.stringify(b.expected));}catch{continue;}
        if(identical){destinations=paths;break;}
      }
    }
    return prepared.map((f,n)=>({...f,to:destinations?.[n]||path.join(destination,f.location,f.relative),...(destinations?{existing:true}:{})}));
  }
  // 候補に現れない隠しファイル・空フォルダも含め、受領できない内容は残す。
  folderReceived(folder, files) {
    let count=0;const byPath=new Map(files.map(f=>[f.path,f]));
    const walk=q=>{
      noLinks(q);if(++count>20000)throw Error(lt('片付け対象が多すぎます。AIに成果の整理を頼んでください'));
      const st=fs.lstatSync(q);
      if(st.isDirectory()){const names=fs.readdirSync(q);return names.length>0&&names.every(n=>walk(path.join(q,n)));}
      if(!st.isFile())return false;
      const f=byPath.get(q);return Boolean(f&&snapshot(q)===f.fingerprint&&(f.mode===undefined||(st.mode & 0o777)===f.mode));
    };
    return walk(folder);
  }
  safeOptional(optional,files) { return optional.filter(m=>this.folderReceived(m.path,files)); }
  receiveIntegrated({project,task,targetProject,targetTask,integrating,files,integrated,results=[],optional=[]}) {
    let r=this.read(project,task);
    if(r?.complete){if(r.integrating!==integrating)throw Error(lt('別の統合で受領済みです'));return this.result(r,true);}
    if(r?.receiving){if(r.integrating!==integrating)throw Error(lt('別の祖先の統合中です'));this.continue(r);return this.result(r);}
    if(r?.integrating && r.integrating!==integrating)throw Error(lt('別の祖先の統合中です'));
    const {t,target,d}=this.context(project,task,{targetProject,targetTask,integrating});
    if(d.blockers.length)throw Error(d.blockers.join(' / '));
    if(!Array.isArray(optional) || optional.some(id=>!d.optional.some(f=>f.id===id)))throw Error(lt('片付ける専用フォルダを確認してください'));
    for(const f of files)if((snapshot(f.path)!==f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode))throw Error(lt('成果ファイルが変わりました。元の記録は残しています'));
    const id=randomUUID(),destination=path.join(target.project.dir,'成果物','受取',id);noLinks(destination);
    r={id,project,task,title:t.title,taskHash:t.completionHash,targetProject,targetTask,targetHash:target.task.completionHash,targetName:`${target.project.name}／${target.task.title}`,integrating,receiving:true,destination,files:this.receiptFiles(files,target.project,destination),integrated,results,move:[...d.move,...this.safeOptional(d.optional.filter(f=>optional.includes(f.id)),files)],optional,notified:false,complete:false};
    // 既存の正本として使う場所を片付け対象にしない。専用成果の元も照合後だけ片付ける。
    r.move=r.move.filter(m=>!r.files.some(f=>f.to===m.path||inside(m.path,f.to)));
    r.optional=r.optional.filter(id=>r.move.some(m=>path.relative(this.store.readProject(project).dir,m.path)===id));
    r.retainedFolders=d.optional.filter(m=>!r.move.some(x=>x.path===m.path)).map(m=>m.path);
    this.prepareBundles(r);this.save(r);this.continue(r);return this.result(r);
  }
  apply({ project, task, token, selected = [], confirm, expectTitle }) {
    const saved = this.tokens.get(token); if (!saved || Date.now() - saved.at > 600000 || confirm !== true || saved.value.project !== project || saved.value.task !== task) throw Error(lt('もう一度引渡し内容を確認してください'));
    const old = saved.value; let r = this.read(project, task);
    this.expectTitle(project,task,expectTitle,r);
    if (r && (old.pending ? old.pending !== r.id : old.taskHash !== r.taskHash || old.targetProject !== r.targetProject || old.targetTask !== r.targetTask)) throw Error(lt('受領記録が変わりました。内容を読み直してください'));
    if (r?.complete) {
      const file = this.store.taskFile(project, task);
      if (file && this.store.readTask(file).completionHash !== r.taskHash) throw Error(lt('引渡し後に作業が変わりました。内容を読み直してください'));
      return this.result(r, true);
    }
    if (!r) {
      if(old.blockers?.length) throw Error(old.blockers.join(' / '));
      const { p, t, target, d } = this.context(project, task);
      if (d.blockers.length) throw Error(d.blockers.join(' / '));
      if(old.results && JSON.stringify(this.results(p,t))!==JSON.stringify(old.results))throw Error(lt('確認中に成果の保存記録が変わりました'));
      if (t.completionHash !== old.taskHash || target.task.completionHash !== old.targetHash || target.project.id !== old.targetProject || target.task.id !== old.targetTask) throw Error(lt('確認中に作業・本作業が変わりました。内容を読み直してください'));
      if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(id => !old.files.some(x => x.id === id))) throw Error(lt('渡す成果ファイルを選び直してください'));
      const files = old.files.filter(x => selected.includes(x.id));
      if (!files.length && !old.integrated?.files?.length && !old.resultReady) throw Error(lt('成果ファイルを選んでください'));
      for (const f of files) if ((snapshot(f.path) !== f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode)) throw Error(lt('確認中に成果ファイルが変わりました'));
      if (JSON.stringify(this.integration(p, t)) !== JSON.stringify(old.integrated)) throw Error(lt('本体への取り込み記録が変わりました'));
      const id = randomUUID(), destination = path.join(target.project.dir, '成果物', '受取', id); noLinks(destination);
      r = { id, project, task, title: t.title, targetProject: target.project.id, targetTask: target.task.id, targetName: old.target, targetHash: old.targetHash, taskHash: t.completionHash, destination, files: this.receiptFiles(files,target.project,destination), integrated: old.integrated, results:old.results, move: d.move, cleanupVersion:2, notified: false, complete: false };
      this.prepareBundles(r);this.save(r);
    }
    if(old.pending && old.pending !== r.id) throw Error(lt('受領記録が変わりました。内容を読み直してください'));
    this.continue(r); return this.result(r);
  }
  continue(r) {
    if(r.files.length>1&&!r.files.every(f=>f.to===f.path)){
      const first=r.files[0],suffix=path.join(first.location,first.relative);
      const root=first.to.endsWith(path.sep+suffix)?first.to.slice(0,-suffix.length):null;
      if(!root||r.files.some(f=>f.to!==path.join(root,f.location,f.relative)))throw Error(lt('旧受領の一式配置を確認できません。成果を保持し、子のAIに成果の整理を頼んでください'));
    }
    if(!r.bundles){
      this.prepareBundles(r);
      this.save(r);
    }
    this.checkBundles(r,!r.notified&&!r.files.some(f=>f.existing));
    const target = this.store.readProject(r.targetProject), task = target?.tasks.find(x => x.id === r.targetTask);
    if (!task || !r.integrating && task.state === '完了' || this.removal.busy(r.project, r.task) || this.removal.busy(r.targetProject, r.targetTask) || this.removal.locked(r.project) || this.removal.locked(r.targetProject)) throw Error(lt('作業・本作業が稼働中、完了済み、または見つかりません。成果は保持しています'));
    if (r.cleanup && this.store.taskFile(r.project,r.task)) {
      const c=this.context(r.project,r.task,r.integrating ? r : {});
      if(c.d.blockers.length || c.t.completionHash!==r.taskHash || c.target.project.id!==r.targetProject || c.target.task.id!==r.targetTask) throw Error(lt('片付け途中で作業の状態が変わりました。成果は保持しています'));
    }
    if (!r.notified && task.completionHash !== r.targetHash && !chat.read(target.dir,r.targetTask).some(x=>x.handoff===r.id)) throw Error(lt('引渡し途中で本作業が変わりました。内容を確認してください'));
    if (!r.cleanup) {
      const c = this.context(r.project, r.task, r.integrating ? r : {}); if (c.d.blockers.length) throw Error(c.d.blockers.join(' / '));
      if(r.results && JSON.stringify(this.results(c.p,c.t))!==JSON.stringify(r.results))throw Error(lt('途中で成果の保存記録が変わりました。成果は保持しています'));
      if (!r.integrating && JSON.stringify(this.integration(c.p,c.t)) !== JSON.stringify(r.integrated)) throw Error(lt('本体への取り込み記録が変わりました。成果は保持しています'));
      if (c.t.completionHash !== r.taskHash || c.target.project.id !== r.targetProject || c.target.task.id !== r.targetTask) throw Error(lt('引渡し途中で元の作業が変わりました。成果は保持しています'));
      let moves=[...c.d.move,...this.safeOptional(c.d.optional.filter(f=>(r.optional || []).includes(f.id)),r.files)].filter(m=>!r.files.some(f=>f.to===m.path||inside(m.path,f.to)));
      // 旧版の途中受領は当時確認された片付け範囲を保つ。新版の追加物で再開を止めない。
      if(!r.integrating&&!r.cleanupVersion){const added=[path.join(c.p.dir,'.ai/work',r.task),path.join(c.p.dir,'.ai/chat',r.task+'.rules.md')];moves=moves.filter(f=>!added.includes(f.path)||r.move.some(x=>x.path===f.path));}
      if (JSON.stringify(moves) !== JSON.stringify(r.move)) throw Error(lt('引渡し途中で管理ファイルが変わりました。成果は保持しています'));
    }
    for (const f of r.files) {
      noLinks(f.to);
      if (exists(f.to)) { if (!fs.statSync(f.to).isFile() || hash(fs.readFileSync(f.to)) !== f.digest || f.mode!==undefined&&(fs.statSync(f.to).mode & 0o777)!==f.mode) throw Error(lt('受け取った成果が変更されています。上書きしません')); continue; }
      if (f.existing) throw Error(lt('保存済みの同内容成果が失われました。元の記録は保持しています'));
      if (r.notified || (snapshot(f.path) !== f.fingerprint || f.mode!==undefined&&(fs.statSync(f.path).mode & 0o777)!==f.mode)) throw Error(lt('成果ファイルが変わったか失われました。管理記録は保持しています'));
      const directories=(r.bundles || []).flatMap(b=>b.expected.filter(e=>e.kind==='directory').map(e=>({to:path.join(b.destination,e.path),mode:e.mode}))).filter(d=>inside(d.to,f.to)&&!exists(d.to));
      fs.mkdirSync(path.dirname(f.to), { recursive: true });
      for(const d of directories)fs.chmodSync(d.to,d.mode);
      const tmp = f.to + '.handoff-tmp'; noLinks(tmp); fs.copyFileSync(f.path, tmp); if(f.mode!==undefined)fs.chmodSync(tmp,f.mode); if (hash(fs.readFileSync(tmp)) !== f.digest) throw Error(lt('成果を正しく保存できませんでした')); fs.renameSync(tmp, f.to);
    }
    this.checkBundles(r);
    // 通知・本文は識別子で照合し、通知後の保存失敗でも二重にしない。
    const recovered = r.integrated?.recovered ? lt('（古い取り込み記録を本体の履歴と照合）') : '';
    const text = [lt`「${r.title}」から本作業「${r.targetName}」へ成果を受け取りました。`, ...(r.retainedFolders||[]).map(f=>lt`- 残す：${f}（未受領の内容または正本があるため自動で片付けません）`), ...r.files.map(f => `- ${f.to}${f.existing ? lt('（同じ内容を保存済み。重複コピーなし）') : ''}`), ...(r.results || []).filter(x=>x.kind!=='ファイル').map(x=>`- ${x.kind}：${x.value}${x.description ? '（'+x.description+'）' : ''}`), ...(r.integrated ? [`${r.integrating ? lt('統合先') : lt('本体への取り込み済み')}：${r.integrated.dir}（${r.integrated.commit}）${recovered}`, ...(r.integrated.github ? [lt`更新候補：${r.integrated.github.url}（ブランチ：${r.integrated.github.branch || lt('未指定')}）`] : []), ...r.integrated.files.map(f => `- ${f}`)] : []), FINAL_CHECK].join('\n');
    if (!chat.read(target.dir, r.targetTask).some(x => x.handoff === r.id)) chat.append(target.dir, r.targetTask, {role:'user',text,from:'subtask',child:r.task,childTitle:r.title,childProject:r.project,handoff:r.id,...(r.integrating?{integrating:r.integrating}:{})});
    const targetFile = this.store.taskFile(r.targetProject, r.targetTask); noLinks(targetFile);
    if (!fs.readFileSync(targetFile, 'utf8').includes(lt`受領記録：${r.id}`)) this.store.appendSection(r.targetProject, r.targetTask, 'やったこと', lt`- 「${r.title}」の成果${r.files.length}ファイルを受領：${r.destination}${r.integrated ? (r.integrating ? lt('／統合先への取り込み済み') : lt('／本体への取り込み済み')) + recovered : ''}。受領記録：${r.id}。${FINAL_CHECK}`);
    r.notified = true; this.save(r); this.notify(r.targetProject, r.targetTask, r.id);
    if(r.integrating)this.beforeCleanup(r);
    // コピー片付け処理などの後にも、保存先を照合してから原物を退避する。
    for(const f of r.files){
      noLinks(f.to);
      if(!exists(f.to)||!fs.statSync(f.to).isFile()||hash(fs.readFileSync(f.to))!==f.digest||f.mode!==undefined&&(fs.statSync(f.to).mode & 0o777)!==f.mode)throw Error(lt('受け取った成果が変更されています。元の記録を保持します'));
    }
    this.checkBundles(r);
    if (!r.cleanup) {
      const id = randomUUID(), dest = path.join(this.removal.trash, 'ProjectHub 引渡し ' + id);
      noLinks(dest);
      // taskファイルを最後に移す。途中失敗でも一覧から再実行できる。
      const taskFile=this.store.taskFile(r.project,r.task);
      const moves = r.move.slice().sort((a,b) => Number(a.path===taskFile) - Number(b.path===taskFile));
      const record = {id,at:new Date().toISOString(),kind:'task',project:r.project,task:r.task,title:r.title,entries:moves.map(x => ({from:x.path,to:path.join(dest,path.relative(this.store.root,x.path)),fingerprint:x.fingerprint,moved:false,restored:false})),error:''};
      this.removal.save(record); r.cleanup = id; this.save(r);
    }
    const file = path.join(this.removal.records, r.cleanup + '.json'); noLinks(file);
    const record = this.removal.recover(JSON.parse(fs.readFileSync(file, 'utf8')));
    // 専用領域の管理記録だけを退避。復元・変更された記録は消さない。
    const root = path.join(this.store.product, r.project);
    const allowed = [path.join(root,'.ai/tasks',r.task+'.md'),path.join(root,'.ai/work',r.task), ...['.jsonl','.json','.queue.json','.rules.md'].map(ext => path.join(root,'.ai/chat',r.task+ext)),...(r.optional || []).filter(x=>x==='作業/'+r.task || x==='attachments/'+r.task).map(x=>path.join(root,x))];
    for (const e of record.entries) {
      if (!(allowed.includes(e.from) || path.dirname(e.from) === path.join(root,'.ai/handoff') && path.basename(e.from).startsWith(r.task+'-') && /^\d{8}-\d{6}-(claude|codex|agy|grok)\.md$/.test(path.basename(e.from).slice(r.task.length+1))) || !inside(path.resolve(this.removal.trash), e.to) || e.restored) throw Error(lt('片付け記録の場所・復元状態を確認してください'));
      noLinks(e.from); noLinks(e.to);
      if (e.moved) { if (exists(e.from)) throw Error(lt('元の管理記録が復元されています。上書きしません')); continue; }
      if (e.from===path.join(root,'.ai/work',r.task) || (r.optional||[]).some(x=>e.from===path.join(root,x)) || path.dirname(e.from)===path.join(root,'.ai/handoff')) {
        const p=this.store.readProject(r.project),t=p?.tasks.find(x=>x.id===r.task);
        if(!t || this.removal.referenced(e.from,p,t,this.store.listProjects())) throw Error(lt('他の記録から参照されているため専用フォルダ・引継ぎ資料を残します'));
      }
      if ((r.optional||[]).some(x=>e.from===path.join(root,x))&&!this.folderReceived(e.from,r.files)) throw Error(lt('未受領の内容があるため専用フォルダを残します。子のAIに成果の整理を頼んでください'));
      if (!exists(e.from) || snapshot(e.from) !== e.fingerprint) throw Error(lt('片付ける管理記録が変わりました。成果は保持しています'));
      this.checkBundles(r);
      fs.mkdirSync(path.dirname(e.to), {recursive:true}); e.moving=true; this.removal.save(record);
      this.removal.rename(e.from,e.to); e.moved=true; e.moving=false; this.removal.save(record);
    }
    r.complete = true; this.save(r);
  }
  result(r, duplicate = false) { return {ok:true,parent:r.targetTask,parentProject:r.targetProject,record:r.cleanup,destination:r.destination,files:r.files.map(f=>f.to),duplicate}; }
}
module.exports = { TaskTransfer, FINAL_CHECK };
