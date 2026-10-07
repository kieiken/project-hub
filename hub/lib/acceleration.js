'use strict';
const { lt } = require('./locale');
const fs = require('node:fs');
const path = require('node:path');

// Hub専用の設定。CLIのconfig.tomlや認証は変更しない。
class Acceleration {
  constructor(file) {
    this.file = file;
    this.value = { codexAllowed: false };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.value.codexAllowed = saved?.codexAllowed === true || (!Object.hasOwn(saved || {}, 'codexAllowed') && saved?.codexFast === true);
    } catch { /* 未保存・読取不能なら加速を有効にしない */ }
  }
  settings() { return { ...this.value }; }
  save(body) {
    if (!body || typeof body.codexAllowed !== 'boolean' || Object.keys(body).some(k => k !== 'codexAllowed')) {
      const e = Error(lt('Codex の加速はオン・オフで指定してください')); e.status = 400; throw e;
    }
    const value = { codexAllowed: body.codexAllowed };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } finally { try { fs.unlinkSync(tmp); } catch { /* 置換済み */ } }
    this.value = value;
    return this.settings();
  }
}
module.exports = { Acceleration };
