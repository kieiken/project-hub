'use strict';
// 始める欄の画像を手元に保存。元画像を残し、CLI用にPNGへ変換する。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;
const MAX = 50 * 1024 * 1024;
const dirOf = p => path.join(p.dir, '.ai', 'work', 'start-images');
const specFile = p => path.join(p.dir, '.ai', 'start-spec.json');
const specCache = new Map(); // 場所 → { key, value }（一覧のたびに読まないため）
function lastSpec(p) {
  const f = specFile(p);
  let st; try { st = fs.statSync(f); } catch { specCache.delete(f); return null; }
  const key = `${st.mtimeMs}:${st.size}`, hit = specCache.get(f);
  if (hit && hit.key === key) return hit.value;
  let value = null; try { value = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { value = null; }
  specCache.set(f, { key, value });
  return value;
}
function saveSpec(p, spec) { fs.mkdirSync(path.dirname(specFile(p)), { recursive: true }); fs.writeFileSync(specFile(p), JSON.stringify(spec)); }
function imageFile(p, id, preview = false) {
  if (!/^[a-f\d-]{36}\.(png|jpg|jpeg|webp|gif|heic)$/i.test(id)) throw Error('画像の指定が正しくありません');
  return path.join(dirOf(p), preview && !/\.(png|jpe?g)$/i.test(id) ? id + '.png' : id);
}
function saveImage(p, name, data) {
  if (!IMAGE.test(name)) throw Error('画像は png／jpg／jpeg／webp／gif／heic に対応しています');
  if (!data.length || data.length > MAX) throw Error('画像は1枚50MBまでです');
  const id = randomUUID() + path.extname(name).toLowerCase();
  const file = imageFile(p, id);
  fs.mkdirSync(dirOf(p), { recursive: true });
  fs.writeFileSync(file, data);
  if (!/\.(png|jpe?g)$/i.test(id)) {
    try { if (process.platform === 'win32') execFileSync(process.execPath, [path.join(__dirname, 'convert-image.js'), file, imageFile(p, id, true)], { timeout: 15000, stdio: 'pipe', windowsHide: true });
    else execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', imageFile(p, id, true)], { timeout: 15000, stdio: 'pipe' }); }
    catch {
      // 失敗した一時コピーだけを片付ける。利用者の元画像には触らない。
      for (const temp of [file, imageFile(p, id, true)]) { try { fs.unlinkSync(temp); } catch { /* 未作成 */ } }
      throw Error('画像をPNGに変換できませんでした。画像を書き出し直して追加してください');
    }
  }
  return { id, name: /^hub-paste-/i.test(path.basename(name)) ? '貼り付け画像.png' : path.basename(name), url: '/api/start/image?project=' + encodeURIComponent(p.id) + '&id=' + id, path: imageFile(p, id, true) };
}
function imageFromPath(p, raw) {
  const file = fs.realpathSync(String(raw));
  const allowed = [os.homedir(), os.tmpdir(), '/private/tmp'].filter(x => fs.existsSync(x)).map(x => fs.realpathSync(x));
  if (!allowed.some(x => file.startsWith(x + path.sep)) || !IMAGE.test(file)) throw Error('この場所の画像は追加できません');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX) throw Error('画像は1枚50MBまでです');
  return saveImage(p, path.basename(file), fs.readFileSync(file));
}
function copyImages(p, ids, dir, task) {
  if (!Array.isArray(ids) || ids.length > 10) throw Error('画像は1回10枚までです');
  const sources = ids.map(id => ({ id, file: imageFile(p, id), view: imageFile(p, id, true) }));
  for (const x of sources) if (!fs.existsSync(x.file) || !fs.existsSync(x.view)) throw Error('添付画像が見つかりません。追加し直してください');
  const dest = path.join(dir, 'attachments', task);
  if (ids.length) fs.mkdirSync(dest, { recursive: true });
  return sources.map(x => {
    const original = path.join(dest, x.id), image = x.file === x.view ? original : original + '.png';
    fs.copyFileSync(x.file, original);
    if (image !== original) fs.copyFileSync(x.view, image);
    return image;
  });
}
function imagePrompt(ai, text, images) {
  return images.length ? text + '\n\n参照画像（絶対パス）：\n' + images.join('\n') + '\n' + (ai === 'claude' ? 'これらの画像を Read で見てから始める。' : ai === 'agy' ? 'これらの画像を読み、内容を確認してから始める。' : '添付画像を確認してから始める。') : text;
}
module.exports = { IMAGE, MAX, lastSpec, saveSpec, imageFile, saveImage, imageFromPath, copyImages, imagePrompt };
