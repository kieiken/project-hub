'use strict';
const { lt } = require('./locale');
const fs = require('node:fs'), path = require('node:path');
const order = require('../public/model-order');
const launch = require('./launch'), { EFFORTS } = require('./roles');
const INITIAL_PICK = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' };
const validPhoneKey = key => key === 'chatgpt|app' || order.valid([key]);
const validPhoneName = name => typeof name === 'string' && name.length <= 24 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name);
class ModelView {
  constructor(file) { this.file = file; }
  read(strict = false) {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' || (!strict && e instanceof SyntaxError)) data = {}; else throw e; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { if (strict) throw Error(lt('モデルの表示設定の形式が違います')); return {}; }
    return data;
  }
  hidden(data = this.read()) {
    const h = data.hidden || {};
    return Object.fromEntries(order.ais.map(ai => [ai, [].concat(h[ai] || []).map(String)]));
  }
  saved(data = this.read()) { return order.clean(data.order); }
  phone(data = this.read()) {
    const p = data.phone;
    if (!p || !['short', 'full'].includes(p.labels) || !p.names || typeof p.names !== 'object' || Array.isArray(p.names)) return { labels: 'short', names: {} };
    const names = Object.fromEntries(Object.entries(p.names).filter(([key, name]) => validPhoneKey(key) && validPhoneName(name) && name.trim()).slice(0, 501).map(([key, name]) => [key, name.trim()]));
    return { labels: p.labels, names };
  }
  setPhone(spec, models) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { status: 400, error: lt('スマホの表示設定の形式が違います') };
    const keys = Object.keys(spec);
    const mode = keys.length === 1 && keys[0] === 'labels' && ['short', 'full'].includes(spec.labels);
    const name = keys.length === 2 && keys.includes('key') && keys.includes('name') && validPhoneKey(spec.key) && validPhoneName(spec.name)
      && (spec.key === 'chatgpt|app' || order.ordered(models).includes(spec.key));
    if (!mode && !name) return { status: 400, error: lt('名前は一覧のモデルを指定し、24字以内・改行なしで入力してください') };
    const data = this.read(true), phone = this.phone(data);
    if (mode) phone.labels = spec.labels;
    else if (spec.name.trim()) phone.names[spec.key] = spec.name.trim();
    else delete phone.names[spec.key];
    data.phone = phone; this.write(data);
    return { phoneLabels: phone };
  }
  initial(data = this.read()) {
    const s = data.initial;
    return s && ['claude', 'codex'].includes(s.ai) && typeof s.model === 'string' && s.model.trim() &&
      !/[\r\n]/.test(s.model) && EFFORTS.includes(s.effort)
      ? { ai: s.ai, model: s.model, effort: s.effort } : { ...INITIAL_PICK };
  }
  setInitial(spec, models, modelError = () => '') {
    if (!spec || !['claude', 'codex'].includes(spec.ai) || typeof spec.model !== 'string' || !EFFORTS.includes(spec.effort))
      return { status: 400, error: lt('初期AI・モデル・思考の形式が違います') };
    const model = launch.modelLabel(spec.ai, spec.model);
    if (!(models[launch.AI_KEY[spec.ai]] || []).includes(model)) return { status: 400, error: lt('このモデルは初期AIに選べません') };
    const error = modelError(spec.ai, model);
    if (error) return { status: 400, error };
    const data = this.read(true);
    data.initial = { ai: spec.ai, model, effort: spec.effort }; this.write(data);
    return { initialPick: this.initial(data) };
  }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  setHidden(ai, model, hide) {
    const data = this.read(true), h = this.hidden(data);
    h[ai] = hide ? [...new Set([...h[ai], model])] : h[ai].filter(m => m !== model);
    data.hidden = { ...data.hidden, ...h }; this.write(data);
    return { hiddenModels: h, modelOrder: this.saved(data) };
  }
  setOrder(next, before, models) {
    if (!order.valid(next) || !order.valid(before)) return { status: 400, error: lt('並び順の形式が違います（重複なし・500件まで）') };
    const data = this.read(true);
    if (JSON.stringify(before) !== JSON.stringify(order.ordered(models, data.order))) return { status: 409, error: lt('並びが変わりました。読み直してから並べ替えてください') };
    data.order = next.slice(); this.write(data);
    return { modelOrder: this.saved(data), hiddenModels: this.hidden(data) };
  }
}
module.exports = { ModelView };
