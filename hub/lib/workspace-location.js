'use strict';
const fs = require('fs');
const path = require('path');
function canonical(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync(abs);
  return path.join(canonical(path.dirname(abs)), path.basename(abs));
}
function within(a, b) {
  const rel = path.relative(a, b);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function prepare({ root, target, mode, configFile, appDir }) {
  if (!['copy', 'empty'].includes(mode)) throw Error('請選擇資料處理方式。');
  if (typeof target !== 'string' || !path.isAbsolute(target.trim())) throw Error('請輸入完整的資料夾路徑。');
  root = canonical(root); target = canonical(target.trim());
  if (within(root, target) || within(target, root)) throw Error('新位置不可與原位置相同，也不可互為上下層資料夾。');
  if (within(canonical(appDir), target) || within(target, canonical(appDir))) throw Error('請選擇程式安裝目錄以外的資料夾。');
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) throw Error('請選擇空白資料夾，避免覆蓋既有檔案。');
  const previous = fs.readFileSync(configFile, 'utf8');
  const config = JSON.parse(previous.replace(/^\uFEFF/, ''));
  if (canonical(config.root).toLowerCase() !== root.toLowerCase()) throw Error('啟動設定與目前工作區不一致，請先重新啟動。');
  // Validate before copying: linked directories and Git worktrees need a dedicated migration.
  function check(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('工作區含有連結資料夾，請改用空白工作區或先手動整理。');
      if (item.name === '.git' && item.isFile()) throw Error('工作區含有 Git 工作副本，請改用空白工作區並保留原始路徑。');
      if (item.isDirectory()) check(file);
    }
  }
  if (mode === 'copy') check(root);
  fs.mkdirSync(target, { recursive: true });
  if (mode === 'copy') fs.cpSync(root, target, { recursive: true, errorOnExist: true, force: false,
    filter: file => !/^server-(out|error)\.log$/.test(path.basename(file)) });
  for (const name of ['_hub', 'Product', 'Work']) fs.mkdirSync(path.join(target, name), { recursive: true });
  if (mode === 'empty') fs.copyFileSync(path.join(root, '_hub', 'roles.yaml'), path.join(target, '_hub', 'roles.yaml'));
  const next = JSON.stringify({ ...config, root: target }, null, 2) + '\n';
  return { target, commit() { const temp = configFile + '.pending'; fs.writeFileSync(temp, next); fs.renameSync(temp, configFile); },
    rollback() { fs.writeFileSync(configFile, previous); } };
}
module.exports = { prepare };
