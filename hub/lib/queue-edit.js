'use strict';
// 本文と添付の境界を保存する。参照の除外だけを扱い、実ファイルは変更しない。
const path = require('node:path'), fs = require('node:fs');
const start = require('./start'), { lt } = require('./locale');
function format(text, attachments) {
  const files = attachments.some(x => x.kind === 'file');
  return attachments.length ? (text.trim() || lt(files ? '添付ファイルを確認してください。' : '添付画像を確認してください。'))
    + lt(files ? '\n\n参照ファイル・画像（絶対パス）：\n' : '\n\n参照画像（絶対パス）：\n')
    + attachments.map(x => (x.referencePaths || [x.path]).join('\n') + (x.message ? '\n' + x.message : '')).join('\n') : text.trim();
}
function normalize(p, task, attachments, ft, projects) {
  if (!Array.isArray(attachments) || attachments.length > 50) throw Error('添付情報を確認してください');
  const ids = new Set();
  return attachments.map(x => {
    if (!x || typeof x.id !== 'string' || ids.has(x.id)) throw Error('添付情報を確認してください');
    ids.add(x.id);
    if (p.kind === 'freetalk') return ft.descriptor(task, x.id);
    if (/^[a-f\d-]{36}$/i.test(x.id)) return projects.forProject(p).descriptor(task,x.id);
    if (x.kind === 'file') {
      if (!x.id.startsWith('file:') || typeof x.path !== 'string' || !path.isAbsolute(x.path)) throw Error('添付情報を確認してください');
      return { id: x.id, kind: 'file', path: x.path, name: path.basename(x.path), ...(x.status === 'unreadable' && require('./video-frames').VIDEO.test(x.path) ? { status:'unreadable', message:lt('動画の場所だけを渡します。内容は確認できません。') } : {}) };
    }
    const file = start.imageFile(p, x.id, true);
    if (!fs.existsSync(file) || x.path !== file) throw Error('添付画像を確認してください');
    return { id: x.id, path: file, name: path.basename(x.name || x.id), url: '/api/start/image?' + new URLSearchParams({ project: p.id, id: x.id }) };
  });
}
function accept(p, task, raw, text, ft, projects) {
  if (!raw) return undefined; // 古いクライアントの本文送信も保持する。
  if (typeof raw.text !== 'string') throw Error('添付情報を確認してください');
  const attachments = normalize(p, task, raw.attachments, ft, projects);
  if (format(raw.text, attachments) !== text) throw Error('本文と添付情報が一致しません');
  return { text: raw.text, attachments };
}
function draft(p, task, item, ft, projects) {
  if (item.attachmentDraft) {
    // 切替による本文合流などで境界が変わった場合は推定して削除しない。
    const d = item.attachmentDraft;
    if (format(d.text, d.attachments) === item.text) return { text: d.text, attachments: d.attachments };
  }
  const header = lt('\n\n参照画像（絶対パス）：\n'), at = item.text.lastIndexOf(header);
  if (at >= 0) {
    try {
      const attachments = item.text.slice(at + header.length).split('\n').map(file => {
        const id = p.kind === 'freetalk' ? file.match(/(?:^|\/)([a-f\d-]{36})(?:[-/])/i)?.[1]
          : path.basename(file).replace(/(\.(?:gif|webp|heic))\.png$/i, '$1');
        return { id, path: file, name: path.basename(file) };
      });
      const checked = normalize(p, task, attachments, ft, projects);
      if (format(item.text.slice(0, at), checked) === item.text) return { text: item.text.slice(0, at), attachments: checked };
    } catch { /* 任意の本文パスは編集対象の添付へ変換しない。 */ }
  }
  return { text: item.text, attachments: [] };
}
function imagePaths(attachments) {
  if(attachments.filter(a=>a.kind!=='file').length>10)throw Error(lt('画像は1回10枚までです'));
  const images=[...new Set(attachments.flatMap(a=>a.imagePaths || (a.imagePath?[a.imagePath]:a.kind!=='file'?[a.path]:[])))];
  if(images.length>20)throw Error(lt('動画から抜き出した場面を含め、画像は1回20枚までです。添付を減らして送ってください'));
  return images;
}
module.exports = { format, normalize, accept, draft, imagePaths };
