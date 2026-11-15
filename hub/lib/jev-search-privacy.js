'use strict';
const norm = s => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const grams = function* (s) { for (let i = 0; i <= s.length - 12; i++) yield s.slice(i, i + 12); };
function overlaps(s, human) { if (human.size) for (const g of grams(s)) if (human.has(g)) return true; return false; }
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{16,}|Bearer\s+\S+|(?:api[_ -]?key|password|passwd|secret|token|パスワード|秘密鍵)\s*[:=：]|[A-Za-z0-9_+/-]{32,}={0,2})/i;
function queryAllowed(query) {
  return typeof query === 'string' && query.length <= 200 && !SECRET.test(query) &&
    !/https?:|data:|!\[|<img\b|(?:\/Users\/|\/home\/|[A-Za-z]:\\)|[\w.+-]+@[\w.-]+/i.test(query);
}
// Inherit the evaluated line/quote/code/address exclusions, before truncation.
// Only AI visible text is passed here. Human 12-character overlaps are removed
// even when they are unmarked quotations. Nothing from this module is persisted.
function sanitize(text, { human = new Set(), titles = [] } = {}) {
  if (SECRET.test(text) || /data:image\/|<previous_conversation>|参照画像（絶対パス）/i.test(text)) return '';
  let s = text.replace(/```[\s\S]*?(?:```|$)/g, '[省略]')
    .replace(/!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi, '[省略]')
    .replace(/https?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[省略]')
    .replace(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/private\/|\/tmp\/|~\/|(?:\.\.?\/))[^\s`'"<>）)\]]+/g, '[省略]')
    .replace(/\+?\d[\d ()-]{7,}\d/g, '[省略]')
    .replace(/[「『“"][^\n」』”"]*(?:[」』”"]|$)|`[^`\n]*`/g, '[省略]');
  s = s.split('\n').filter(line => {
    const n = norm(line);
    return !/^\s*>/.test(line) && !SECRET.test(line) && !titles.some(t => norm(t).length >= 2 && n.includes(norm(t))) &&
      !overlaps(n, human) &&
      !/(?:あなた|本人|ユーザー|人が|人の).*(?:言っ|発言|依頼|回答|希望)|(?:依頼|質問|回答)原文|【(?:人|ユーザー)】/.test(line) &&
      !/(?:\b[\w.-]+\.(?:com|ai|jp|net|org)\b|(?:\/[\w.-]+){2,}|[\w.-]+\.(?:png|jpe?g|gif|webp|pdf)\b)/i.test(line);
  }).join('\n').replace(/(?:\[省略\]\s*)+/g, ' ').trim();
  let clipped = '', count = 0; for (const c of s) { if (count++ >= 600) break; clipped += c; } s = clipped;
  return norm(s).length >= 30 ? s : '';
}
module.exports = { norm, grams, SECRET, queryAllowed, sanitize };
