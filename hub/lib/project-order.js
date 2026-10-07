'use strict';
const { lt } = require('./locale');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rules = require('../public/project-order');
const CHANGED = lt('並びが変わりました。読み直してから並べ替えてください');
class ProjectOrder {
  constructor(store) { this.store = store; this.file = path.join(store.root, '_hub', 'project-order.json'); }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!value.groups || typeof value.groups !== 'object' || Array.isArray(value.groups)) return {};
      for (const ids of Object.values(value.groups)) {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return {};
      }
      return value.groups;
    } catch (e) { if (e.code && e.code !== 'ENOENT') throw e; return {}; }
  }
  readPins() {
    try {
      const pins = JSON.parse(fs.readFileSync(path.join(this.store.root, '_hub', 'project-pins.json'), 'utf8'));
      return Array.isArray(pins) && pins.every(id => typeof id === 'string' && id) && new Set(pins).size === pins.length ? pins : [];
    } catch (e) { if (e.code && e.code !== 'ENOENT') throw e; return []; }
  }
  pin({ project, pinned, before }) {
    if (project === 'freetalk') throw Error(require('./freetalk').PROTECTED);
    const pins = this.readPins();
    if (!this.store.listProjects().some(p => p.id === project) || typeof pinned !== 'boolean' || typeof before !== 'boolean' || pins.includes(project) !== before) throw Error(lt('固定の状態が変わりました。読み直してから操作してください'));
    const next = pins.filter(id => id !== project);
    if (pinned) next.push(project);
    const file = path.join(this.store.root, '_hub', 'project-pins.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return { ok: true, projectPins: next };
  }
  save({ parent, before, order }) {
    if ([parent, ...(Array.isArray(before) ? before : []), ...(Array.isArray(order) ? order : [])].includes('freetalk')) throw Error(require('./freetalk').PROTECTED);
    const all = this.store.listProjects(), groups = this.read();
    const valid = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length;
    if (typeof parent !== 'string' || parent && !all.some(p => p.id === parent) || !valid(before) || !valid(order)) throw Error(CHANGED);
    const current = rules.siblings(all, parent, groups, this.readPins()).map(p => p.id);
    if (JSON.stringify(before) !== JSON.stringify(current) || order.length !== current.length || order.some(id => !current.includes(id))) throw Error(CHANGED);
    const pins = new Set(this.readPins());
    if (order.some((id, i) => pins.has(id) !== pins.has(current[i]))) throw Error(lt('固定したプロジェクトは上部に置いてください'));
    // 削除した ID の位置は残す。復元時にもその位置を使い、表示中の兄弟だけを入れ替える。
    const active = new Set(current), old = Object.hasOwn(groups, parent) ? groups[parent] : [];
    let i = 0;
    const merged = old.map(id => active.has(id) ? order[i++] : id);
    merged.push(...order.slice(i));
    const next = { ...groups, [parent]: merged };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify({ groups: next }, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, this.file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return { ok: true, projectOrder: next };
  }
}
module.exports = { ProjectOrder, ...rules };
