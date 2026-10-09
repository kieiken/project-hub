"use strict";
const fs = require('fs'), path = require('path'), os = require('os');
const { createHash } = require('crypto');
const { parseDoc } = require('./frontmatter');
class Skills {
  constructor(root) { this.file = path.join(root, '_hub', 'skills.json'); }
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw Error('無法讀取 Skill 設定，請檢查 skills.json。'); }
    return { roots: [path.join(os.homedir(), '.codex', 'skills')], projects: {} };
  }
  write(data) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(this.file + '.tmp', this.file); }
  scan(roots = this.read().roots) {
    const items = [], warnings = [], seen = new Set(), directories = new Set(); let visited = 0;
    const walk = (dir, source, depth) => {
      const realDir = fs.realpathSync(dir);
      if (directories.has(realDir)) return; directories.add(realDir);
      if (++visited > 5000) throw Error('掃描範圍太大，請選擇更精確的技能資料夾。');
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        const stat = entry.isSymbolicLink() ? fs.statSync(file) : entry;
        if (stat.isDirectory() && depth < 8 && !['node_modules', '.git'].includes(entry.name)) walk(file, source, depth + 1);
        else if (stat.isFile() && entry.name === 'SKILL.md') {
          const real = fs.realpathSync(file), key = process.platform === 'win32' ? real.toLowerCase() : real;
          if (seen.has(key)) continue; seen.add(key);
          if (fs.statSync(real).size > 256 * 1024) { warnings.push('略過過大的技能檔案：' + real); continue; }
          const parsed = parseDoc(fs.readFileSync(real, 'utf8'));
          const meta = parsed.data || {};
          items.push({ id: createHash('sha256').update(key).digest('hex'), path: real, source,
            name: String(meta.name || path.basename(path.dirname(real))), description: String(meta.description || '未提供說明'),
            compatibility: /[\\/]\.claude[\\/]/i.test(real) ? 'Claude 來源：使用前需確認工具相容性' : '依技能內容與目前 AI 工具能力執行' });
        }
      }
    };
    for (const root of roots) { try { walk(root, root, 0); } catch(e) { warnings.push(root + '：' + e.message); } }
    return { items, warnings };
  }
  saveRoots(roots) {
    if (!Array.isArray(roots) || roots.length > 12 || roots.some(x => typeof x !== 'string' || !path.isAbsolute(x))) throw Error('請填寫完整資料夾路徑，最多 12 個。');
    const normalized = [...new Set(roots.map(x => fs.realpathSync(x)))];
    if (normalized.some(x => !fs.statSync(x).isDirectory())) throw Error('技能來源必須是資料夾。');
    const data = this.read(); data.roots = normalized; this.write(data); return this.status();
  }
  status() { const data = this.read(); return { ...data, ...this.scan(data.roots) }; }
  select(project, ids) {
    if (!Array.isArray(ids) || ids.length > 30 || ids.some(x => typeof x !== 'string')) throw Error('每個專案最多選擇 30 個技能。');
    const available = new Set(this.scan().items.map(x => x.id));
    if (ids.some(x => !available.has(x))) throw Error('部分技能已不存在，請重新掃描。');
    const data = this.read(); data.projects[project] = [...new Set(ids)]; this.write(data);
  }
  prompt(project) {
    const ids = this.read().projects[project] || []; if (!ids.length) return '';
    const items = this.scan().items;
    const picked = ids.map(id => items.find(x => x.id === id));
    if (picked.some(x => !x)) throw Error('專案選用的 Skill 已遺失或無法讀取，請到設定 → Skill 管理重新選擇。');
    return '【使用者為本專案選用的 Skills】\n先讀取下列 SKILL.md，再依本次需求使用適用的步驟。技能原檔與其參考檔案僅供讀取，不要修改。使用者本次指示與工具權限優先；若工具不相容或路徑無權讀取，請明確回報，不得假裝已執行。\n' + picked.map(x => JSON.stringify({ name: x.name, file: x.path })).join('\n');
  }
}
module.exports = { Skills };
