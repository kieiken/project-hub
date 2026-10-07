'use strict';
const { lt } = require('./locale');
// 作業ファイルの成果宣言を読む。本体保存済みはローカルGitの履歴だけで照合する。
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('./git');
const { noLinks, inside } = require('./remove');
function readResults(file) {
  noLinks(file);
  const rows = [], text = fs.readFileSync(file, 'utf8');
  let active = false, fenced = false, sections = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^##\s/.test(line)) { active = /^##\s+成果\s*$/.test(line); if (active) sections++; continue; }
    if (!active || !line.trim()) continue;
    const m = line.match(/^\s*[-*]\s+(ファイル|本体保存済み|なし)[：:]\s*(.+?)\s*$/);
    if (!m) throw Error(lt('「## 成果」はファイル・本体保存済み・なしの行で書いてください'));
    const description = m[2].match(/^(.*?)\s*[（(]([^（）()]*)[）)]$/);
    const value = (description ? description[1] : m[2]).trim();
    if (!value) throw Error(lt('「## 成果」の場所・理由を空にしないでください'));
    rows.push({ kind: m[1], value, description: description?.[2] || '' });
  }
  if (sections > 1) throw Error(lt('「## 成果」は1か所にまとめてください'));
  if (rows.some(r => r.kind === 'なし') && rows.length !== 1) throw Error(lt('「なし」と他の成果は同時に指定できません'));
  return rows;
}
function verifyResults(rows, p, base) {
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
    if (!git.isAncestor(dir, commit)) throw Error(lt('保存済みのコミットが現在の本体に含まれていません'));
    return { ...r, dir, commit };
  });
}
module.exports = { readResults, verifyResults };
