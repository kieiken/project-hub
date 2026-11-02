'use strict';
const platform = require('./platform');
const { lt } = require('./locale');
// Git の出し入れ：作業ごとの作業用コピー（worktree）を作る・本体に取り込む・片付ける
// Git の無いフォルダは、最初に保存を始める（作業用コピーは作らない）
const fs = require('./platform/file-io');
const path = require('path');
const { createHash } = require('node:crypto');
const { execFileSync, execFile } = require('child_process');

const read = require('./git-read');
const bookkeeping = require('./git-bookkeeping');

const MAX_FILES = 20000;          // これより多いフォルダは自動で保存を始めない
const MAX_BYTES = 1024 ** 3;      // 1GB
const MAX_GIT_OUTPUT = 16 * 1024 * 1024; // 日本語の長いパスや大量の保存待ちも、既定の1MiBで切らない

function git(dir, args, {readOnly=false}={}) {
  if(['add','commit','merge','checkout','switch','branch','worktree','config','init','update-ref','reset','clean','rm','remote','tag','gc'].includes(args[0])&&!args.includes('--get')&&!args.includes('--get-all')){
    const key=require('./resource-scope').commonGit(dir);
    if(key&&mergeMutex.has(key)&&gitOwner.getStore()!==key)throw Object.assign(Error('共有Gitの保存処理が進行中です'),{status:409,delivery:{state:'not-sent'}});
  }
  // 名前が未設定の Mac でも保存できるように、未設定の時だけ仮の名前を使う
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if(readOnly)env.GIT_OPTIONAL_LOCKS='0';
  if (!hasIdentity(dir)) Object.assign(env, { GIT_AUTHOR_NAME: 'Project Hub', GIT_AUTHOR_EMAIL: 'hub@localhost', GIT_COMMITTER_NAME: 'Project Hub', GIT_COMMITTER_EMAIL: 'hub@localhost' });
  return execFileSync('git', ['-C', dir, '-c', 'gc.auto=0', ...args], { env, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function blob(dir, ref, file) { return execFileSync('git',['-C',dir,'show',`${ref}:${file}`],{encoding:'utf8',maxBuffer:MAX_GIT_OUTPUT,stdio:['ignore','pipe','pipe']}); }
function tryGit(dir, args) { try { return git(dir, args); } catch (e) { return null; } }
// Only the display may reuse a successful HEAD read. Inspect repository/ref
// metadata on every call, with no TTL; actions continue to use savedHead.
const displayHeads=new Map();
function headStamp(dir,{directoryMetadata=true}={}){
  // Respect Git's environment-driven discovery by leaving unusual overrides
  // to Git. Do not guess a repository different from the command's target.
  if(['GIT_DIR','GIT_COMMON_DIR','GIT_WORK_TREE','GIT_NAMESPACE','GIT_CEILING_DIRECTORIES','GIT_DISCOVERY_ACROSS_FILESYSTEM'].some(k=>process.env[k]))return null;
  const mark=f=>{try{const st=fs.statSync(f);return [st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs,st.mode].join(':');}catch(e){if(e.code==='ENOENT')return '-';throw e;}};
  try{
    let base=path.resolve(dir),own;
    for(;;){const candidate=path.join(base,'.git');if(fs.existsSync(candidate)){own=candidate;break;}const parent=path.dirname(base);if(parent===base)return null;base=parent;}
    const directoryMark=f=>{const s=fs.statSync(f);return directoryMetadata?mark(f):[s.dev,s.ino,s.mode].join(':');};
    const parts=[own,directoryMark(own)];
    if(fs.statSync(own).isFile()){
      const text=fs.readFileSync(own,'utf8'),m=text.match(/^gitdir: (.+)\s*$/);if(!m)return null;
      own=path.resolve(base,m[1].trim());parts.push(own,directoryMark(own));
    }
    let common=own;const cf=path.join(own,'commondir');parts.push(mark(cf));
    if(fs.existsSync(cf))common=path.resolve(own,fs.readFileSync(cf,'utf8').trim());
    if(fs.existsSync(path.join(common,'reftable')))return null;
    parts.push(common,mark(path.join(common,'config')),mark(path.join(own,'config.worktree')),mark(path.join(common,'packed-refs')));
    let ref=path.join(own,'HEAD');const seen=new Set();
    for(let i=0;i<16;i++){
      if(seen.has(ref))return null;seen.add(ref);parts.push(ref,mark(ref));
      if(!fs.existsSync(ref))return JSON.stringify(parts);
      const text=fs.readFileSync(ref,'utf8').trim();parts.push(text);
      if(!text.startsWith('ref: '))return JSON.stringify(parts);
      const name=text.slice(5);if(!name.startsWith('refs/')||name.split('/').some(x=>!x||x==='.'||x==='..'))return null;
      // Per-worktree refs live in the private Git dir, ordinary refs in common.
      const local=/^refs\/(?:bisect|worktree|rewritten)\//.test(name);ref=path.join(local?own:common,name);
    }
  }catch{/* Failed discovery cannot justify reusing an old value. */}
  return null;
}
function savedHeadAsync(dir) {
  const stamp=headStamp(dir),old=displayHeads.get(dir);
  if(stamp!==null&&old?.stamp===stamp)return Promise.resolve(old.head);
  displayHeads.delete(dir);
  return new Promise(resolve => execFile('git', ['-C', dir, '-c', 'gc.auto=0', 'rev-parse', 'HEAD'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT,
  }, (error, stdout) => {
    const head=error?null:stdout.trim();
    // A ref changed while Git ran: serve its result, but never label it as the
    // earlier stamp or reuse it on the next request. Failures are not cached.
    if(head&&stamp!==null&&headStamp(dir)===stamp){if(displayHeads.size>=128)displayHeads.delete(displayHeads.keys().next().value);displayHeads.set(dir,{stamp,head});}
    resolve(head);
  }));
}

// git を呼ぶたびに確かめると起動回数が倍になるので、場所ごとの答えを1分覚えておく（名前を設定してから最長1分は仮の名前のまま）
const identityKnown = new Map();
function hasIdentity(dir) {
  const known = identityKnown.get(dir);
  if (known && Date.now() - known.at < 60000) return known.ok;
  let ok = false;
  try { ok = Boolean(execFileSync('git', ['-C', dir, 'config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (e) {}
  identityKnown.set(dir, { ok, at: Date.now() });
  return ok;
}

function available() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

function repoTop(dir) { return fs.existsSync(dir) ? tryGit(dir, ['rev-parse', '--show-toplevel']) : null; }

// 作業用コピーなら、本体のフォルダを返す
function mainOf(dir) {
  const common = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const own = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (!common || !own || common === own) return null;
  return path.dirname(common);
}

function dirty(dir) { return Boolean(tryGit(dir, ['status', '--porcelain'])); }

// ignore の無いプロジェクトでも、新しい秘密設定は自動保存に含めない。
// すでに追跡されているファイルは変更せず、例示用の .env は許容する。
function stageAll(dir) {
  require('./nested-git').assertNone(dir);
  git(dir, ['add', '-A']);
  const added = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', '-z'])
    .split('\0').filter(Boolean);
  const secrets = added.filter(f => {
    const name = path.posix.basename(f);
    if (name === '.env.example' || name === '.env.sample') return false;
    return LOCAL_FILES.test(name) || /(^|\/)\.claude\/settings\.local\.json$/.test(f);
  });
  for (let i = 0; i < secrets.length; i += 100) {
    git(dir, ['rm', '--cached', '-q', '--', ...secrets.slice(i, i + 100).map(f => `:(top,literal)${f}`)]);
  }
  try { git(dir, ['diff', '--cached', '--quiet']); return false; }
  catch (e) { if (e.status === 1) return true; throw e; }
}

// 変更があれば保存する
function save(dir, message) {
  if (!dirty(dir)) return false;
  if (!stageAll(dir)) return false;
  git(dir, ['commit', '-q', '--no-verify', '-m', message]);
  return true;
}

// 大きすぎないか数える（途中で上限を超えたら止める）
function tooBig(dir) {
  let files = 0, bytes = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return false; }
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(f)) return true; continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += fs.statSync(f).size; } catch (x) { /* 無視 */ }
      if (files > MAX_FILES || bytes > MAX_BYTES) return true;
    }
    return false;
  };
  return walk(dir);
}

// Git の無いフォルダで保存を始める。できなければ理由を返す
function init(dir) {
  if (tooBig(dir)) return { ok: false, reason: lt('ファイルが多すぎるため、Git の保存は始めませんでした') };
  git(dir, ['init', '-q']);
  stageAll(dir);
  git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', lt('Project Hub: 最初の保存')]);
  return { ok: true };
}

const real = p => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
// ブランチ名に使えない文字だけ置き換える（日本語はそのまま）
const branchName = s => 'hub/' + (String(s).replace(/[\s~^:?*[\\\x00-\x1f\x7f]+|\.\.|@\{/g, '-').replace(/^[-.]+|[-.]+$|\.lock$/g, '') || 'task');

// 作業を始める前の準備。作業する場所と、何をしたかを返す
//   base: 本体のフォルダ / workRoot: AI-Workspace/Work/<プロジェクト>
function prepare({ base, workRoot, taskId, direct, startRef, isolatedOnly }) {
  if (!available()) return { dir: base, note: lt('Git が無いため、本体で作業します') };
  let top = repoTop(base);
  if (isolatedOnly && (!top || direct || tryGit(top, ['config', 'hub.mode']) === 'direct')) return { dir: base, note: lt('専用の作業用コピーを作れません') };
  // 台帳のフォルダが別の Git の中にある時は、台帳だけの保存を始める
  if (top && direct && real(top) !== real(base)) top = null;
  if (!top) {
    const r = init(base);
    if (!r.ok) return { dir: base, note: r.reason };
    git(base, ['config', 'hub.mode', 'direct']);
    return { dir: base, note: lt('Git の保存を始めました（本体で作業します）'), inited: true };
  }
  // 元々 Git の無かったフォルダ・台帳のフォルダは、本体で作業する（始める前に保存だけする）
  if (direct || tryGit(top, ['config', 'hub.mode']) === 'direct') {
    save(top, lt('作業前の保存'));
    return { dir: base, note: lt('作業前に保存しました') };
  }
  // まだ一度も保存していない Git なら、まず保存する
  if (!tryGit(top, ['rev-parse', '--verify', 'HEAD'])) { stageAll(top); git(top, ['commit', '-q', '--no-verify', '--allow-empty', '-m', lt('Project Hub: 最初の保存')]); }
  const wt = path.join(workRoot, taskId);
  const rel = path.relative(top, base);
  if (fs.existsSync(wt)) return { dir: path.join(wt, rel), worktree: wt };
  fs.mkdirSync(workRoot, { recursive: true });
  const branch = branchName(taskId);
  const exists = tryGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  git(top, exists ? ['worktree', 'add', '-q', wt, branch] : ['worktree', 'add', '-q', '-b', branch, wt, startRef || 'HEAD']);
  const copied = copyLocalFiles(top, wt);
  return { dir: path.join(wt, rel), worktree: wt, created: true, branch, copied, note: lt`この作業専用の作業用コピーを作りました${copied.length ? lt`（${copied.join('・')} も写しました）` : ''}` };
}

// Git に入っていない手元の設定（.env など）を作業用コピーにも写す。無いと AI のテストが動かないため
const LOCAL_FILES = /^(\.env(\..*)?|\.dev\.vars(\..*)?|\.npmrc)$/;
function copyLocalFiles(top, wt) {
  const copied = [];
  const cands = [];
  try { for (const n of fs.readdirSync(top)) if (LOCAL_FILES.test(n)) cands.push(n); } catch (e) { return copied; }
  for (const f of ['.claude/settings.local.json']) if (fs.existsSync(path.join(top, f))) cands.push(f);
  for (const rel of cands) {
    const src = path.join(top, rel), dst = path.join(wt, rel);
    try {
      if (!fs.statSync(src).isFile() || fs.existsSync(dst)) continue;
      if (tryGit(top, ['ls-files', '--error-unmatch', rel]) !== null) continue; // Git に入っている物は写さない
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
    } catch (e) { /* 写せない物は飛ばす */ }
  }
  return copied;
}

// 取り込む前の見通し：変わったファイルの数・行数、本体とぶつかりそうか（本体は触らない）
function preview({ dir, workRoot, target, from, targetGuard }) {
  const wt = repoTop(dir);
  const main = target ? repoTop(target) : wt && mainOf(wt);
  if (!wt || !main) return null;
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const mainHead = tryGit(main, ['rev-parse', 'HEAD']);
  const mergeBase = mainHead && tryGit(wt, ['merge-base', mainHead, 'HEAD']);
  const base = from && /^[a-f0-9]{40,64}$/.test(from) && isAncestor(wt, from) ? from : mergeBase;
  if (!base) return null;
  const stat = tryGit(wt, ['diff', '--shortstat', base]) || '';
  const num = re => Number((stat.match(re) || [0, 0])[1]);
  const untracked = (tryGit(wt, ['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean).length;
  const files = num(/(\d+) files? changed/) + untracked;
  let conflict = false, conflictPaths = [], conflictKind = 'none';
  // 保存済みの変更どうしで試しに合わせてみる（git 2.38 以上。使えなければ判定しない）
  if (tryGit(wt, ['rev-parse', 'HEAD']) !== base) {
    try { git(main,['merge-tree','--write-tree','--name-only','--no-messages','-z',mainHead,git(wt,['rev-parse','HEAD'])]); }
    catch(e) {
      conflict=e.status===1;
      if(conflict) {
        const parts=String(e.stdout||'').split('\0'),tree=parts.shift();conflictPaths=parts.filter(Boolean);
        const plan=bookkeeping.plan({read:(ref,f)=>blob(main,ref,f),paths:conflictPaths,base:mergeBase,ours:mainHead,theirs:git(wt,['rev-parse','HEAD']),merged:tree,title:'確認'});
        conflictKind=plan?'bookkeeping':'content';
      }
    }
  }
  const sourceHead=tryGit(wt,['rev-parse','HEAD']),sourceDirty=dirty(wt),mainDirty=targetGuard?Boolean(targetGuard(main).status):dirty(main);
  const sameHistory=isAncestor(wt,mainHead)||isAncestor(main,sourceHead);
  const noChanges=files===0&&!conflict&&!sourceDirty&&!mainDirty&&!merging(wt)&&!merging(main)&&sameHistory&&tryGit(wt,['rev-parse','HEAD^{tree}'])===tryGit(main,['rev-parse','HEAD^{tree}']);
  return { files, added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/), conflict, conflictPaths, conflictKind, mainDirty, sourceDirty, sourceHead, targetHead:mainHead, noChanges, paths: (tryGit(wt, ['diff', '--name-only', '-z', base]) || '').split('\0').filter(Boolean) };
}

// Display previews can run many synchronous Git commands. Keep them off the
// HTTP/event-stream loop, including a preview already started by another view.
// Completed display results are keyed by both repositories' full live Git
// inputs. Actions never use this cache and retain their own fresh checks.
const previewReads = new Map(),previewResults=new Map();
async function previewFingerprint(dirs){
  const values=await Promise.all(dirs.map(async dir=>{
    const before=read.stamp(dir);if(!before)return null;
    const [head,status,diff]=await Promise.all([
      read.command(dir,['rev-parse','HEAD']),
      read.command(dir,['status','--porcelain=v1','-z','--untracked-files=all'],{trim:false}),
      read.command(dir,['diff','--no-ext-diff','--no-textconv','--binary','HEAD','--'],{encoding:null})
    ]);
    const untracked=[];
    for(const entry of status.split('\0'))if(entry.startsWith('?? ')){
      const file=path.join(dir,entry.slice(3)),st=await fs.promises.lstat(file);
      untracked.push([entry,st.mode,st.size,st.mtimeMs,st.ctimeMs,st.ino]);
    }
    const after=read.stamp(dir);if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Git state changed');
    return [dir,before,head,status,require('node:crypto').createHash('sha256').update(diff).digest('hex'),untracked];
  }));
  return values.some(v=>v===null)?null:JSON.stringify(values);
}
function previewAsync({dir,workRoot,root,target,from}){
  if(![dir,workRoot].every(v=>typeof v==='string'&&path.isAbsolute(v))||root!==undefined&&!path.isAbsolute(root))return Promise.reject(Error('invalid preview paths'));
  const key=JSON.stringify([dir,workRoot,root,target,from]);if(previewReads.has(key))return previewReads.get(key).then(structuredClone);
  const pending=(async()=>{
    const main=target||await read.mainOf(dir),dirs=[dir,main].filter(Boolean);
    const before=await previewFingerprint(dirs),old=previewResults.get(key);
    if(before!==null&&old?.fingerprint===before)return structuredClone(old.value);
    previewResults.delete(key);
    const value=await require('./integration-read-worker').run('git.preview',{dir,workRoot,root,target:main,from},{dirs});
    const after=await previewFingerprint(dirs);
    if(before!==null&&after!==null&&before!==after)throw Error('確認中にGitの状態が変わりました。最新の記録を確認してください');
    if(value&&before!==null&&after!==null){while(previewResults.size>=32)previewResults.delete(previewResults.keys().next().value);previewResults.set(key,{fingerprint:after,value:structuredClone(value)});}
    return value;
  })().finally(()=>previewReads.delete(key));previewReads.set(key,pending);return pending;
}

// ゴミ箱へ移す（完全には消さない）
function toTrash(dir, trash) {
  const dest = trashPath(dir, trash);
  fs.renameSync(dir, dest);
  return dest;
}
function trashPath(dir, trash) {
  const bin = trash || process.env.HUB_TRASH || platform.trashDir();
  fs.mkdirSync(bin, { recursive: true });
  let dest = path.join(bin, path.basename(dir));
  if (fs.existsSync(dest)) dest += ' ' + new Date().toISOString().replace(/[:.]/g, '-');
  return dest;
}

// 作業用コピーを本体に取り込み、片付ける。ぶつかったら何も変えずに conflict を返す
const mergeMutex=new Set();
const gitOwner=new (require('node:async_hooks').AsyncLocalStorage)();
function mergeLocks(dir){
 const own=git(dir,['rev-parse','--absolute-git-dir']),common=git(dir,['rev-parse','--path-format=absolute','--git-common-dir']),ref=tryGit(dir,['symbolic-ref','-q','HEAD']);
 return [...new Set([path.join(own,'index.lock'),path.join(own,'HEAD.lock'),path.join(common,'packed-refs.lock'),...(ref?[path.join(common,ref+'.lock')]:[])])].filter(f=>fs.existsSync(f));
}
function withCommonGit(dir,fn){
 const key=require('./resource-scope').commonGit(dir)||fs.realpathSync(dir);
 if(mergeMutex.has(key))throw Object.assign(Error('共有Gitの保存処理が進行中です'),{status:409,delivery:{state:'not-sent'}});
 mergeMutex.add(key);try{const value=gitOwner.run(key,fn);if(value&&typeof value.then==='function')return value.finally(()=>mergeMutex.delete(key));mergeMutex.delete(key);return value;}catch(e){mergeMutex.delete(key);throw e;}
}
function mergeTargetProblem(dir){
 const own=git(dir,['rev-parse','--absolute-git-dir']);
 if(['BISECT_LOG','BISECT_START'].some(n=>fs.existsSync(path.join(own,n))))return 'bisect';
 return tryGit(dir,['symbolic-ref','-q','HEAD'])?null:'detached';
}
function assertMergeTarget(dir){
 const problem=mergeTargetProblem(dir);
 if(problem)throw Object.assign(Error(problem==='bisect'?'本体でGitの原因調査が途中です。調査を終えてから確認してください':'本体のブランチが選ばれていません。保存先のブランチを確認してください'),{delivery:{state:'not-sent'}});
}
function merge(options){
 try{return withCommonGit(options.target||mainOf(options.dir)||options.dir,()=>{assertMergeTarget(options.target||mainOf(options.dir)||options.dir);return options.strictFrozen?require('./idea-frozen-merge').mergeFrozen(options):mergeUnlocked(options);});}
 catch(e){return {ok:false,error:e.message,delivery:e.delivery||{state:'unknown'}};}
}
function mergeUnlocked({ dir, workRoot, title, target, cleanup = true, sourceHead, targetGuard }) {
  const wt = repoTop(dir);
  if (!wt) return { ok: false, error: lt('作業用コピーが見つかりません') };
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: lt('Work フォルダの作業用コピーではありません') };
  const origin = mainOf(wt);
  const main = target ? repoTop(target) : origin;
  if (!main) return { ok: false, error: lt('Git の作業用コピーではありません') };
  if (!origin || main === wt || git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) return { ok: false, error: lt('統合先は同じ本体の別の作業用コピーにしてください') };
  const mergeError = lt('統合先で取り込みが途中です。解消して保存してください');
  // 他の取り込みは、子の保存やno-op判定より前に拒否してそのまま残す。
  if (merging(main)) return { ok: false, error: mergeError };
  const locks=mergeLocks(main);if(locks.length)return {ok:false,error:'Gitの保存処理が進行中です：'+locks.join('、'),delivery:{state:'not-sent'}};
  const preflightGuard=()=>{try{return targetGuard?.(main);}catch(e){throw Object.assign(e,{delivery:{state:'not-sent'}});}};
  const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // 途中受領の再開は確認済みの保存だけを取り込む。子の後続commitは次回へ残す。
  if (sourceHead && (!/^[a-f0-9]{40}$/.test(sourceHead) || !isAncestor(wt, sourceHead))) return { ok: false, error: lt('確認した子の保存が履歴にありません') };
  if (sourceHead && cleanup) return { ok: false, error: lt('途中の保存の取り込みでは子のコピーを片付けられません') };
  if (sourceHead && (dirty(wt) || (targetGuard?preflightGuard().status:dirty(main)) || merging(wt))) return { ok: false, error: lt('途中の成果を渡す前に、子の変更を保存してください') };
  save(wt, lt`${title}（作業の保存）`);
  if (merging(main)) return { ok: false, error: mergeError };
  if(targetGuard)preflightGuard();else save(main, lt('取り込み前の保存')); // approved integration never commits Hub records or unrelated work
  if (merging(main)) return { ok: false, error: mergeError };
  const before = git(main, ['rev-parse', 'HEAD']);
  // Local settings excluded from saving may remain untracked. Verify their
  // exact before/after content too, rather than requiring a blank status.
  const baseline = targetGuard ? null : inspect(main, {readOnly:true});
  const targetChanged = () => {
    if(targetGuard)return Boolean(targetGuard(main).status);
    const now=inspect(main,{readOnly:true});
    return !now || now.branch!==baseline.branch || now.status!==baseline.status || now.content!==baseline.content;
  };
  const source = sourceHead || git(wt, ['rev-parse', 'HEAD']), already = isAncestor(main, source);
  let autoResolved, startedMerge = false;
  const ownMerge = () => startedMerge && tryGit(main, ['rev-parse', '--verify', 'MERGE_HEAD']) === source;
  try {
    if (!already) {
      if (merging(main)) return { ok: false, error: mergeError };
      assertMergeTarget(main);
      if(targetGuard)preflightGuard();
      startedMerge = true;
      git(main, ['merge', '--no-ff', '--no-edit', '-m', lt`取り込み: ${title}`, sourceHead || branch]);
    }
  } catch (e) {
    // 自分のmergeと確認できない失敗では、解消・abortを一切行わない。
    if (!ownMerge()) return { ok: false, error: merging(main) ? mergeError : lt('取り込みを開始できません：') + e.message,delivery:{state:e.delivery?.state==='not-sent'?'not-sent':!merging(main)&&git(main,['rev-parse','HEAD'])===before&&!targetChanged()?'not-sent':'unknown'} };
    const conflictPaths=(tryGit(main,['diff','--name-only','--diff-filter=U','-z'])||'').split('\0').filter(Boolean);
    const base=tryGit(main,['merge-base',before,source]);
    const plan=bookkeeping.plan({read:(ref,f)=>ref==='work'?fs.readFileSync(path.join(main,f),'utf8'):blob(main,ref,f),paths:conflictPaths,base,ours:before,theirs:source,merged:'work',title});
    let resolved=false;
    if(plan)try {
      for(const [f,text] of Object.entries(plan.output))fs.writeFileSync(path.join(main,f),text);
      git(main,['add','--',...Object.keys(plan.output)]);
      if(git(main,['diff','--name-only','--diff-filter=U']))throw Error(lt('衝突が残っています'));
      git(main,['diff','--cached','--check']);
      git(main,['commit','--no-edit','-m',lt`取り込み: ${title}（版・履歴を自動で合わせた）`]);
      autoResolved=plan.autoResolved;resolved=true;
    } catch { /* 解消・検証・保存のどの失敗も取り込みを取り消す */ }
    if(!resolved) {
      if(merging(main)) {
        if (!ownMerge()) return { ok: false, error: mergeError };
        git(main,['merge','--abort']);
      }
      if(git(main,['rev-parse','HEAD'])!==before||targetChanged())throw Error(lt('取り込みの中止結果を確認できません'));
      return { ok: false, conflict: true, conflictKind:'content', conflictPaths, delivery:{state:'aborted',sourceHead:source,targetHead:before}, error: lt('コードがぶつかったため、取り込みを中止して元の状態に戻しました') };
    }
  }
  const commit = git(main, ['rev-parse', 'HEAD']);
  if(!isAncestor(main,source)||!(tryGit(main,['rev-parse','HEAD^{tree}']))||targetChanged())return {ok:false,error:'取り込み後の本体を確認できません',delivery:{state:'unknown'}};
  const files = (tryGit(main, ['diff', '--name-only', '-z', before, commit]) || '').split('\0').filter(Boolean);
  const sourceSnapshot = inspect(wt);
  const trashed = cleanup ? cleanupCopy({ dir: wt, workRoot, target: main, expectedSnapshot:sourceSnapshot }).trashed : null;
  return { ok: true, main, trashed, commit, files, already, branch, ...(autoResolved?{autoResolved}:{}) };
}
function isAncestor(dir, commit, descendant='HEAD') { return /^[a-f0-9]{40,64}$/.test(commit || '') && (descendant==='HEAD'||/^[a-f0-9]{40,64}$/.test(descendant||'')) && tryGit(dir, ['merge-base', '--is-ancestor', commit, descendant]) !== null; }
function commitsSince(dir, head) { return isAncestor(dir, head) ? Number(git(dir, ['rev-list', '--count', head + '..HEAD'])) : null; }
function inspect(dir, {readOnly=false,ignore=[]}={}) {
  const scope=ignore.length?['--','.',...ignore.map(f=>':(top,exclude,literal)'+f)]:[];
  const wt = repoTop(dir); if (!wt) return null;
  const allUntracked = execFileSync('git',['-C',wt,'ls-files','--others','--exclude-standard','-z'],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',maxBuffer:MAX_GIT_OUTPUT,stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean);
  require('./nested-git').assertNone(wt,allUntracked);
  const untracked=allUntracked.filter(f=>!ignore.includes(f));
  // porcelainの同じ変更マークでも、中身・ステージ・未追跡ファイルが変われば拒否する。
  const digest = createHash('sha256');
  for (const args of [['diff','--binary','--no-ext-diff','--no-textconv','HEAD'], ['diff','--cached','--binary','--no-ext-diff','--no-textconv']]) {
    // diffのstat更新はGIT_OPTIONAL_LOCKS=0でも起こる。内容検査にindexの更新は不要。
    const data = execFileSync('git', ['-C',wt,'-c','diff.autoRefreshIndex=false',...args,...scope], {maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
    digest.update(String(data.length)+':').update(data);
  }
  // 保存から除外するローカル設定も、確認後に変わったなら片付けない。
  const local=fs.readdirSync(wt).filter(n=>LOCAL_FILES.test(n));
  if(fs.existsSync(path.join(wt,'.claude/settings.local.json')))local.push('.claude/settings.local.json');
  const files = [...new Set([...untracked,...local.filter(f=>!ignore.includes(f))])].sort();
  let bytes=0;if(files.length>MAX_FILES)throw require('./nested-git').error('INSPECT_FILE_LIMIT',lt('未追跡ファイルが多すぎて照合できません'));
  for (const f of files) {
    const file=path.join(wt,f),st=fs.lstatSync(file);
    if(!st.isFile()&&!st.isSymbolicLink())throw require('./nested-git').error('INSPECT_FILE_TYPE',lt('照合できない種類の未追跡項目があります'));
    if((bytes+=st.size)>256*1024*1024)throw require('./nested-git').error('INSPECT_BYTE_LIMIT',lt('未追跡ファイルが大きすぎて照合できません'));
    const data=st.isSymbolicLink()?Buffer.from(fs.readlinkSync(file)):fs.readFileSync(file);
    digest.update(JSON.stringify([f,st.mode,data.length])).update(data);
  }
  return { head: git(wt, ['rev-parse', 'HEAD']), branch: git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), status: git(wt, ['-c','core.quotepath=false','status', '--porcelain',...scope],{readOnly}), content: digest.digest('hex') };
}
async function inspectAsync(dir, {ignore=[]}={}) {
  return read.consistent([dir],async()=>{
  const scope=ignore.length?['--','.',...ignore.map(f=>':(top,exclude,literal)'+f)]:[];
  const wt = await read.repoTop(dir); if (!wt) return null;
  const allUntracked = (await read.command(wt,['ls-files','--others','--exclude-standard','-z'],{encoding:null,maxBuffer:MAX_GIT_OUTPUT})).toString().split('\0').filter(Boolean);
  require('./nested-git').assertNone(wt,allUntracked);
  const untracked=allUntracked.filter(f=>!ignore.includes(f));
  // porcelainの同じ変更マークでも、中身・ステージ・未追跡ファイルが変われば拒否する。
  const digest = createHash('sha256');
  for (const args of [['diff','--binary','--no-ext-diff','--no-textconv','HEAD'], ['diff','--cached','--binary','--no-ext-diff','--no-textconv']]) {
    // diffのstat更新はGIT_OPTIONAL_LOCKS=0でも起こる。内容検査にindexの更新は不要。
    const data = await read.command(wt,[...args,...scope],{encoding:null});
    digest.update(String(data.length)+':').update(data);
  }
  // 保存から除外するローカル設定も、確認後に変わったなら片付けない。
  const local=fs.readdirSync(wt).filter(n=>LOCAL_FILES.test(n));
  if(fs.existsSync(path.join(wt,'.claude/settings.local.json')))local.push('.claude/settings.local.json');
  const files = [...new Set([...untracked,...local.filter(f=>!ignore.includes(f))])].sort();
  let bytes=0;if(files.length>MAX_FILES)throw require('./nested-git').error('INSPECT_FILE_LIMIT',lt('未追跡ファイルが多すぎて照合できません'));
  for (const f of files) {
    const file=path.join(wt,f),st=fs.lstatSync(file);
    if(!st.isFile()&&!st.isSymbolicLink())throw require('./nested-git').error('INSPECT_FILE_TYPE',lt('照合できない種類の未追跡項目があります'));
    if((bytes+=st.size)>256*1024*1024)throw require('./nested-git').error('INSPECT_BYTE_LIMIT',lt('未追跡ファイルが大きすぎて照合できません'));
    const data=st.isSymbolicLink()?Buffer.from(fs.readlinkSync(file)):fs.readFileSync(file);
    digest.update(JSON.stringify([f,st.mode,data.length])).update(data);
  }
  return { head: await read.command(wt, ['rev-parse', 'HEAD']), branch: await read.command(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), status: await read.command(wt, ['-c','core.quotepath=false','status', '--porcelain',...scope]), content: digest.digest('hex') };
  });
}
// 復旧先は同じリポジトリの保存済みの場所だけ。確認自体では保存しない。
// Include every paused Git operation; state belongs to this worktree, not the
// shared Git directory. Record-only saves use this same predicate.
function merging(dir) {
  const own=tryGit(dir,['rev-parse','--absolute-git-dir']);
  return own!==null&&['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'].some(name=>fs.existsSync(path.join(own,name)));
}
function recoveryTarget(dir, base, { clean = true, allowMerge = false } = {}) {
  const common = p => tryGit(p, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const expected = common(base), actual = common(dir), state = inspect(dir);
  if (!expected || !actual || real(expected) !== real(actual) || !state) throw Error(lt('統合先は同じ本体のリポジトリにしてください'));
  if (!allowMerge && merging(dir)) throw Error(lt('統合先で取り込みが途中です。解消して保存してください'));
  if (clean && state.status) throw Error(lt('統合先に未保存の変更があります。保存してから復旧してください'));
  return state;
}
function cleanupCopy({ dir, workRoot, target, expectedSnapshot, beforeMove = () => {} }) {
  const wt = repoTop(dir), rel = wt && path.relative(workRoot, wt);
  if (!wt || !rel || rel.startsWith('..') || path.isAbsolute(rel) || !mainOf(wt)) throw Error(lt('片付ける作業用コピーの場所が不正です'));
  const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!isAncestor(target, git(wt, ['rev-parse', 'HEAD'])) || tryGit(wt, ['diff', '--quiet', 'HEAD']) === null) throw Error(lt('未統合の変更があるため作業用コピーを残します'));
  if (expectedSnapshot ? JSON.stringify(inspect(wt)) !== JSON.stringify(expectedSnapshot) : Boolean(git(wt,['ls-files','--others','--exclude-standard','-z']))) throw Error(lt('片付け前に未統合のファイルが変わりました。作業用コピーを残します'));
  const sourceHead = git(wt, ['rev-parse', 'HEAD']), trashed = trashPath(wt);
  beforeMove({trashed, branch, sourceHead});
  fs.renameSync(wt, trashed);
  finishCleanupCopy({target, branch, sourceHead});
  return { trashed, branch };
}
function finishCleanupCopy({ target, branch, sourceHead }) {
  if (!isAncestor(target, sourceHead)) throw Error(lt('統合済みのコミットを確認できません'));
  git(target, ['worktree', 'prune']);
  const head = tryGit(target, ['rev-parse', '--verify', 'refs/heads/' + branch]);
  if (head && head !== sourceHead) throw Error(lt('片付け途中でブランチが変わりました。登録は残します'));
  if (head) git(target, ['branch', '-D', branch]);
}

// Work/<プロジェクト>/ に残っている作業用コピーの数
function countCopies(workRoot) {
  try { return fs.readdirSync(workRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).length; } catch (e) { return 0; }
}

// GitHub などの場所：origin の URL をブラウザで開ける https の形に直す（直せない物は空）
function webUrl(raw) {
  let s = String(raw || '').trim();
  let m;
  if ((m = s.match(/^[\w.-]+@([^:/]+):(.+)$/))) s = `https://${m[1]}/${m[2]}`; // git@github.com:o/r.git
  else if ((m = s.match(/^(?:ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/))) s = `https://${m[1]}/${m[2]}`;
  if (!/^https?:\/\//.test(s)) return '';
  try { const u = new URL(s); u.username = ''; u.password = ''; s = u.origin + u.pathname; } catch (e) { return ''; } // 合言葉入りの URL は外す
  return s.replace(/\/+$/, '').replace(/\.git$/, '');
}
// { url, branch } か null。一覧は15秒ごとに来るので、場所ごとに120秒覚えておく（fresh で読み直す）
const REMOTE_TTL = 120000;
const remoteInfoCache = new Map(); // dir → { at, value }
function remoteInfo(dir, { fresh } = {}) {
  const hit = remoteInfoCache.get(dir);
  if (!fresh && hit && Date.now() - hit.at < REMOTE_TTL) return hit.value;
  let value = null, hasOrigin = false;
  if (dir && fs.existsSync(dir)) {
    const raw = tryGit(dir, ['config', '--get', 'remote.origin.url']);
    hasOrigin = raw !== null;
    const url = webUrl(raw);
    if (url) {
      const b = tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '';
      value = { url, branch: b === 'HEAD' ? '' : b };
    }
  }
  remoteInfoCache.set(dir, { at: Date.now(), value, hasOrigin });
  return value;
}

// 一覧は同期gitを呼ばず、保持値を返して裏で更新する。GitHubへの通信は行わない。
const remotePending = new Map();
function remoteSummary(dir) {
  const hit=remoteInfoCache.get(dir);
  if((!hit||Date.now()-hit.at>=REMOTE_TTL)&&!remotePending.has(dir)) {
    const run=args=>new Promise(resolve=>execFile('git',['-C',dir,...args],{env:{...process.env,GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',timeout:5000,maxBuffer:MAX_GIT_OUTPUT},(error,stdout)=>resolve(error?null:stdout.trim())));
    const pending=(async()=>{
      let value=null,hasOrigin=false;
      if(dir&&fs.existsSync(dir)) {
        const raw=await run(['config','--get','remote.origin.url']);hasOrigin=raw!==null;
        const url=webUrl(raw);
        if(url){const branch=await run(['rev-parse','--abbrev-ref','HEAD'])||'';value={url,branch:branch==='HEAD'?'':branch};}
      }
      // 操作のfresh検査が先に更新した場合、その新しい値を上書きしない。
      if(remoteInfoCache.get(dir)===hit)remoteInfoCache.set(dir,{at:Date.now(),value,hasOrigin});
    })();
    remotePending.set(dir,pending);pending.finally(()=>remotePending.delete(dir));
  }
  return hit||{value:null,hasOrigin:false};
}

function hasOrigin(dir) { remoteInfo(dir); return Boolean(remoteInfoCache.get(dir)?.hasOrigin); }

function integrationReceipt(dir, record, task) {
  // 旧版の成功ログにはこの3項目が無い。名前と時刻が一意に合う本体履歴だけで補う。
  if (record?.ok === true && !['main', 'commit', 'files'].some(k => Object.hasOwn(record, k))) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || !task?.id || typeof task.title !== 'string' || !task.title || record.task !== task.id) return null;
    const subject = lt`取り込み: ${task.id} ${task.title}`;
    const log = tryGit(dir, ['log', '--merges', '--format=%H%x09%cI%x09%P%x09%s', 'HEAD']);
    if (log === null) return null;
    const matches = log.split('\n').map(line => line.split('\t')).filter(row =>
      row.length === 4 && row[3] === subject && row[2].split(' ').length === 2 &&
      Math.abs(Date.parse(row[1]) - at) <= 10000);
    if (matches.length !== 1) return null;
    const commit = matches[0][0];
    if (tryGit(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']) === null) return null;
    const files = tryGit(dir, ['diff', '--name-only', '-z', `${commit}^1`, commit]);
    if (files === null) return null;
    return {dir, commit, files:files.split('\0').filter(Boolean), github:remoteInfo(dir), recovered:true};
  }
  if (!record?.commit || !record.main || !Array.isArray(record.files) || path.resolve(dir) !== path.resolve(record.main)) return null;
  if (tryGit(dir, ['merge-base', '--is-ancestor', record.commit, 'HEAD']) === null) return null;
  return {dir, commit:record.commit, files:record.files, github:remoteInfo(dir)};
}
function changedBetween(dir, from, to) { return git(dir,["diff","--name-only","-z",from,to]).split("\0").filter(Boolean); }
module.exports = {headStamp, inspectAsync, repoTopAsync:read.repoTop, mainOfAsync:read.mainOf, isAncestorAsync:(...a)=>read.consistent([a[0]],()=>read.isAncestor(...a)), mergingAsync:dir=>read.consistent([dir],()=>read.merging(dir)), dirtyAsync:dir=>read.consistent([dir],async()=>Boolean(await read.attempt(dir,['status','--porcelain']))), mergeTargetProblemAsync:read.mergeTargetProblem, readAsync:read.command, mergeTargetProblem, savedHeadAsync, savedHead:dir=>tryGit(dir,['rev-parse','HEAD']), mergeLocks, withCommonGit, remoteSummary, changedBetween, hasOrigin, tooBig, integrationReceipt, available, repoTop, mainOf, save, init, prepare, merge, preview, previewAsync, toTrash, cleanupCopy, finishCleanupCopy, inspect, merging, recoveryTarget, isAncestor, commitsSince, countCopies, dirty, copyLocalFiles, remoteInfo, remoteInfoCache, webUrl };
