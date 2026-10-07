'use strict';
const { lt } = require('./locale');
// AIの完了報告と、人が一覧から完了へ移す判断を分ける。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
class Completion {
  constructor(root, seed) {
    this.file = path.join(root, '_hub', 'completion.json');
    const marker = path.join(root, '_hub', 'completion.migrated');
    this.data = { version: 1, tasks: {}, projects: {}, continued: {} }; this.warning = '';
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || ['tasks','projects','continued'].some(k => !data[k] || typeof data[k] !== 'object' || Array.isArray(data[k])) || Object.values(data.projects).some(p => !p || !p.phases || typeof p.phases !== 'object')) throw Error('invalid');
      this.data = data;
    } catch (e) {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      if (fs.existsSync(marker)) {
        this.warning = lt('完了承認の記録を読めないため、未確認の完了を一覧に戻しています。');
      }
    }
    if (!fs.existsSync(marker)) {
      if (!fs.existsSync(this.file)) seed(this); this.save(); fs.writeFileSync(marker, new Date().toISOString());
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2)); fs.renameSync(tmp, this.file);
  }
  task(key, raw, text, steps, pre) {
    // pre: 読み込みの使い回しで計算済みのハッシュ（同じファイルを何度も計算しないため）
    const fingerprint = pre?.fingerprint || hash(text), stepsHash = pre?.stepsHash || hash(JSON.stringify(steps));
    if (raw && raw !== '完了' && this.data.tasks[key]) { delete this.data.tasks[key]; this.save(); }
    const approved = raw === '完了' && this.data.tasks[key]?.hash === fingerprint;
    const pending = !approved && (raw === '完了' || steps.length > 0 && steps.every(s => s.done) && this.data.continued[key] !== stepsHash);
    return { state: raw === '完了' && !approved ? '完了確認待ち' : raw || '未着手', completionPending: pending, completionHash: fingerprint };
  }
  approveTask(key, text) { this.data.tasks[key] = { hash: hash(text), at: new Date().toISOString() }; delete this.data.continued[key]; this.save(); }
  continueTask(key, steps) { delete this.data.tasks[key]; this.data.continued[key] = hash(JSON.stringify(steps)); this.save(); }
  project(id, data) {
    const record = Object.hasOwn(this.data.projects, id) ? this.data.projects[id] : { phases: {} };
    let changed = false;
    if (data.status && data.status !== '完了' && record.status) { delete record.status; changed = true; }
    const phases = (Array.isArray(data.phases) ? data.phases : []).filter(ph => ph && typeof ph === 'object').map(ph => {
      if (ph.state !== '完了' && Object.hasOwn(record.phases, ph.name)) { delete record.phases[ph.name]; changed = true; }
      const pending = ph.state === '完了' && !Object.hasOwn(record.phases, ph.name);
      return { ...ph, state: pending ? '進行中' : ph.state, completionPending: pending };
    });
    if (changed) { this.data.projects[id] = record; this.save(); }
    const pending = data.status === '完了' && !record.status;
    return { status: pending ? '進行中' : data.status || '未着手', phases, completionPending: pending };
  }
  approveProject(id, data, choice = {}) {
    const record = Object.hasOwn(this.data.projects, id) ? this.data.projects[id] : { phases: {} };
    if (choice.status && data.status === '完了') record.status = new Date().toISOString();
    for (const ph of data.phases || []) if (ph.state === '完了' && ph.name === choice.phase) record.phases[ph.name] = new Date().toISOString();
    this.data.projects[id] = record; this.save();
  }
}
module.exports = { Completion, hash };
