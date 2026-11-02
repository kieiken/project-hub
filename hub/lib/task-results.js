'use strict';
const { lt } = require('./locale');
// 成果宣言は本体の履歴、または所属する専用コピーの保存済み履歴で照合する。
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('./git');
const { noLinks, inside } = require('./remove');
function readResults(file) {
  noLinks(file);
  const rows = [], text = fs.readFileSync(file, 'utf8');
  let active = false, fenced = false, sections = 0;
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^##\s/.test(line)) { active = /^##\s+成果\s*$/.test(line); if (active) sections++; continue; }
    if (!active || !line.trim()) continue;
    const m = line.match(/^\s*[-*]\s+(ファイル|本体保存済み|なし)[：:]\s*(.+?)\s*$/);
    if (!m) {
      const label=line.match(/^\s*[-*]\s+([^：:]{1,40})[：:]/)?.[1];
      throw Object.assign(Error(lt('「## 成果」はファイル・本体保存済み・なしの行で書いてください')+'（'+(index+1)+'行目'+(label?'、未対応の種類「'+label+'」':'、行の形式が不正')+'）。例：- 本体保存済み：body:.@保存commit。専用コピーに保存した履歴も同じ種類で指定します'),{code:'TASK_RESULTS_FORMAT',line:index+1});
    }
    const description = m[2].match(/^(.*?)\s*[（(]([^（）()]*)[）)]$/);
    const value = (description ? description[1] : m[2]).trim();
    if (!value) throw Error(lt('「## 成果」の場所・理由を空にしないでください'));
    rows.push({ kind: m[1], value, description: description?.[2] || '' });
  }
  if (sections > 1) throw Error(lt('「## 成果」は1か所にまとめてください'));
  if (rows.some(r => r.kind === 'なし') && rows.length !== 1) throw Error(lt('「なし」と他の成果は同時に指定できません'));
  return rows;
}
function gitValue(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], maxBuffer: 16384 }).trim();
}
function savedInTaskCopy(dir, base, task, workRoot, commit) {
  if (!task?.workdir || !workRoot) return false;
  const wd = task.workdir.startsWith('~/') ? path.join(require('node:os').homedir(), task.workdir.slice(2)) : task.workdir;
  if (!task.id || /[\\/\0]/.test(task.id) || task.id.startsWith('.')) throw Error(lt('子の作業場所の記録が不正です'));
  const expected = path.resolve(workRoot, task.id), top = git.repoTop(base);
  if (!top || !inside(path.resolve(workRoot), expected)) throw Error(lt('子の作業場所の記録が不正です'));
  if (fs.realpathSync(dir) !== fs.realpathSync(top)) return false;
  noLinks(wd); noLinks(expected);
  // prepare() creates Work/<project>/<task> and preserves base's path within its repo.
  if (path.resolve(wd) !== path.resolve(expected, path.relative(top, base))) throw Error(lt('子の作業場所の記録が不正です'));
  const copyTop = git.repoTop(wd);
  if (!copyTop || fs.realpathSync(copyTop) !== fs.realpathSync(expected)) throw Error(lt('保存済みのリポジトリが見つかりません'));
  const common = d => fs.realpathSync(gitValue(d, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const own = fs.realpathSync(gitValue(copyTop, 'rev-parse', '--path-format=absolute', '--git-dir'));
  if (common(copyTop) !== common(top) || common(copyTop) === own)
    throw Error(lt('統合先は同じ本体のリポジトリにしてください'));
  const registration = path.join(own, 'gitdir'); noLinks(registration);
  if (fs.realpathSync(fs.readFileSync(registration, 'utf8').trim()) !== fs.realpathSync(path.join(expected, '.git')))
    throw Error(lt('子の作業場所の記録が不正です'));
  // Only the corresponding repo is eligible; a nested, independent repo is not.
  const copyDir = path.resolve(copyTop, path.relative(top, dir)); noLinks(copyDir);
  if (!git.repoTop(copyDir) || fs.realpathSync(git.repoTop(copyDir)) !== fs.realpathSync(copyDir)) return false;
  if (git.merging(copyDir)) throw Error(lt('保存済みのリポジトリで取り込みが途中です'));
  if (gitValue(copyDir, 'status', '--porcelain', '--untracked-files=all')) throw Error(lt('子の変更を保存してから確認してください'));
  return git.isAncestor(copyDir, commit);
}
function verifyResults(rows, p, base, { task, workRoot } = {}) {
  return rows.map(r => {
    if (r.kind !== '本体保存済み') return r;
    const m = r.value.match(/^(.+)@([a-f0-9]{7,64})$/);
    if (!m) throw Error(lt('本体保存済みは相対リポジトリ@コミットで書いてください'));
    const rel = m[1].replace(/^(body|project):/, ''), root = m[1].startsWith('project:') ? p.dir : base;
    if (rel !== '.' && (path.isAbsolute(rel) || rel.split(/[\\/]/).some(x => !x || x === '..' || x.startsWith('.')))) throw Error(lt('保存済みの場所は本体・台帳内の相対リポジトリにしてください'));
    const dir = path.resolve(root, rel); if (!inside(path.resolve(root), dir)) throw Error(lt('保存済みの場所が不正です')); noLinks(dir);
    if (!git.repoTop(dir) || fs.realpathSync(git.repoTop(dir)) !== fs.realpathSync(dir)) throw Error(lt('保存済みのリポジトリが見つかりません'));
    if (git.merging(dir)) throw Error(lt('保存済みのリポジトリで取り込みが途中です'));
    let commit;
    try { commit = execFileSync('git', ['-C', dir, 'rev-parse', '--verify', m[2] + '^{commit}'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], maxBuffer: 16384 }).trim(); } catch { throw Error(lt('保存済みのコミットが見つかりません')); }
    if (!git.isAncestor(dir, commit) && !(!m[1].startsWith('project:') && savedInTaskCopy(dir, base, task, workRoot, commit)))
      throw Error(lt('保存済みのコミットが現在の本体に含まれていません'));
    // Keep the declared repo location stable before and after integration/cleanup.
    return { ...r, dir, commit };
  });
}
module.exports = { readResults, verifyResults };
