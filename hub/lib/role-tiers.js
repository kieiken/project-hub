'use strict';
// Optional lower tiers. The hard tier always comes from roles.yaml.
const fs = require('./platform/file-io');
const path = require('node:path');
const crypto = require('node:crypto');
const launch = require('./launch');
const { lt } = require('./locale');
const KEYS = ['light', 'standard', 'hard'];
const LABELS = ['軽い', '標準', '難しい'];
const cli = ai => ai === 'claude-code' ? 'claude' : ai;
const fail = message => { throw Object.assign(Error(message), { status: 409 }); };
const empty = () => ({ version: 1, roles: {}, stops: [], redo: {}, catalogSeen: null, proposal: null });
const revision = text => crypto.createHash('sha256').update(text).digest('hex');
const oldModel = id => /^(?:gpt-[1-5](?:[.-]|$)|claude-(?:opus|sonnet|haiku)-[1-4](?:[.-]|$))/.test(id);
function read(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { data: empty(), revision: revision(''), exists: false }; throw e; }
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !data.roles || typeof data.roles !== 'object' || Array.isArray(data.roles) || !data.redo || typeof data.redo !== 'object' || Array.isArray(data.redo) || !Array.isArray(data.stops)) fail(lt('段の保存内容を読めません。設定を確認してください'));
  for (const r of Object.values(data.roles)) {
    if (!r || typeof r !== 'object' || !['on', 'stopped'].includes(r.routing)) fail(lt('段の振り分け設定が不正です'));
    for (const key of ['light', 'standard']) if (r[key] != null && (!slot(r[key]) || typeof r[key].effort !== 'string' || r[key].effort === 'Ultra')) fail(lt('段の担当の保存内容が不正です'));
  }
  return { data, revision: revision(text), exists: true };
}
function write(file, data, expected) {
  if (expected !== undefined && read(file).revision !== expected) fail(lt('段の設定が変わりました。読み直してください'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    require('./integration-writes').write(file, () => fs.renameSync(tmp, file));
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return read(file);
}
function slot(s) { const ai = cli(s?.ai); return s && launch.AIS.includes(ai) && s.model ? { ai, model: launch.flagFor(ai, s.model) || s.model, effort: s.effort || '高' } : null; }
function draft() {
  return {
    'コーディング': { routing: 'on', light: { ai: 'codex', model: 'gpt-6-luna', effort: '極高' }, standard: { ai: 'codex', model: 'gpt-6.1-terra', effort: '極高' } },
    '調査': { routing: 'on', light: { ai: 'claude', model: 'claude-haiku-5-5', effort: '極高' }, standard: { ai: 'claude', model: 'claude-sonnet-5-5', effort: '極高' } },
  };
}
function validate(rows, roles, catalogs) {
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) fail(lt('段の形式が違います'));
  for (const [name, r] of Object.entries(rows)) {
    const base = roles.find(x => x.name === name);
    if (!base || !r || !['on', 'stopped'].includes(r.routing) || Object.keys(r).some(k => !['routing', 'light', 'standard'].includes(k))) fail(lt('役割または振り分けの形式が違います'));
    for (const key of ['light', 'standard']) {
      const s = r[key]; if (s == null) continue;
      if (Object.keys(s).sort().join(',') !== 'ai,effort,model') fail(lt('段の担当の形式が違います'));
      const ai = cli(s.ai), model = catalogs[ai]?.models?.find(m => m.id === s.model);
      if (!model || oldModel(s.model) || s.effort === 'Ultra' || !launch.effortsFor(ai, s.model, catalogs[ai].models).includes(s.effort)) fail(lt`${name}：今の一覧のモデルと思考（Ultra以外）を選んでください`);
      if (ai === 'agy' && ![base.main, base.backup].some(s => cli(s.ai) === 'agy')) fail(lt('Agy は人が割り当てた役割だけで使えます'));
      const hard = slot(base.main);
      if (hard && hard.ai === ai && hard.model === s.model) fail(lt('下の段には、難しい段と違うモデルを選んでください'));
    }
    if (r.light && r.standard && cli(r.light.ai) === cli(r.standard.ai) && r.light.model === r.standard.model) fail(lt('軽いと標準には違うモデルを選んでください'));
  }
  return structuredClone(rows);
}
function snapshot(tools) {
  const all = { ...Object.fromEntries(Object.entries(tools.catalog()).map(([ai, c]) => [ai, c])), ...Object.fromEntries(Object.entries(tools.codexCatalogs?.() || {}).map(([id, c]) => ['codex:' + id, c])) };
  return Object.fromEntries(Object.entries(all).sort().map(([key, c]) => [key, (c.models || []).map(m => ({ id: m.id, efforts: m.efforts || [] })).sort((a, b) => a.id.localeCompare(b.id))]));
}
function catalogChanges(seen, now) {
  if (!seen) return [];
  return [...new Set([...Object.keys(seen), ...Object.keys(now)])].flatMap(key => {
    const before = seen[key] || [], after = now[key] || [];
    return [...new Set([...before.map(x => x.id), ...after.map(x => x.id)])].flatMap(id => {
      const a = before.find(x => x.id === id), b = after.find(x => x.id === id);
      return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ catalog: key, model: id, change: !a ? '追加' : !b ? 'なくなった' : '思考の変更' }];
    });
  });
}
class RoleTiers {
  constructor(o) { Object.assign(this, o); }
  read() { return read(this.file); }
  // Display and prompt generation may fall back; actions still use strict read().
  readSafe() {
    try { return this.read(); }
    catch { return { data: empty(), exists: false, error: lt('段の設定を読めません。段分けを使わずに続けます。保存内容は変更していません。') }; }
  }
  view({ safe = false } = {}) {
    const r = safe ? this.readSafe() : this.read(), catalogs = this.tools.catalog();
    return { ...r, draft: draft(), catalogs: Object.fromEntries(Object.entries(catalogs).map(([ai, c]) => [ai, { models: c.models || [], source: c.source || '', refreshedAt: c.refreshedAt || '' }])), changes: catalogChanges(r.data.catalogSeen, snapshot(this.tools)) };
  }
  save(rows, expected, { ui = false, resume = [] } = {}) {
    const r = this.read(); if (r.revision !== expected) fail(lt('段の設定が変わりました。読み直してください'));
    const next = validate(rows, this.roles().roles, this.tools.catalog());
    for (const [name, before] of Object.entries(r.data.roles)) {
      if (before.routing === 'stopped' && (!next[name] || next[name].routing === 'on')) {
        if (!ui || !resume.includes(name)) fail(lt('停止した振り分けの再開は設定画面で確認してください'));
        for (const stop of r.data.stops.filter(x => x.role === name && !x.resumedAt)) { stop.resumedAt = new Date().toISOString(); stop.resumedBy = '人'; }
        for (const [key, item] of Object.entries(r.data.redo)) if (item.role === name) delete r.data.redo[key];
      }
    }
    for (const [name, row] of Object.entries(next)) if (row.routing === 'stopped' && r.data.roles[name]?.routing !== 'stopped') {
      r.data.stops.push({ role:name, reason:'設定画面で人が停止しました', by:'人', at:new Date().toISOString() });
    }
    r.data.roles = next; r.data.catalogSeen = snapshot(this.tools);
    write(this.file, r.data, expected); return this.view();
  }
  stop({ role, reason, project = '', task = '' }, by = 'ai') {
    const r = this.read();
    if (!r.data.roles[role] || typeof reason !== 'string' || !reason.trim() || reason.length > 500) fail(lt('振り分け中の役割と、停止の理由を指定してください'));
    if (r.data.roles[role].routing === 'stopped') return this.view();
    r.data.roles[role].routing = 'stopped';
    r.data.stops.push({ role, reason: reason.trim(), project, task, by, at: new Date().toISOString() });
    write(this.file, r.data, r.revision); this.notice?.({ role, reason, project, task }); return this.view();
  }
  // Pure preparation: invalid/unsent requests never consume redo counters.
  resolve(b, { project, task, rows = [] }) {
    const r = this.read(), base = this.roles().roles.find(x => x.name === b.role), config = r.data.roles[b.role];
    if (!config && b.tier === undefined && !b.redo) return null;
    if (!base) fail(lt('段を使う時は保存した役割を指定してください'));
    if (b.tier !== undefined && !LABELS.includes(b.tier)) fail(lt('tier は 軽い・標準・難しい です'));
    if (b.tier !== undefined && (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.trim().length > 80)) fail(lt('段を選んだ理由を1〜80字で指定してください'));
    if (b.redo !== undefined && typeof b.redo !== 'boolean') fail(lt('redo は真偽値で指定してください'));
    let index = config?.routing === 'on' && b.tier ? LABELS.indexOf(b.tier) : 2;
    const key = JSON.stringify([project, task, b.role]);
    const prior = [...rows].reverse().find(x => x.roleTier?.role === b.role && x.role !== 'assistant')?.roleTier;
    let first = index, cheapRedos = r.data.redo[key]?.cheapRedos || 0, stopReason = '';
    if (b.redo) {
      if (!prior) fail(lt('やり直し元の段の依頼が見つかりません'));
      first = prior.first; index = Math.min(prior.index + 1, 2);
      if (prior.index === 2 && first < 2) fail(lt('安い段から上がった仕事が一番上でも失敗しました。止めて人に報告してください'));
      if (prior.index < 2) cheapRedos++;
      if (config?.routing === 'on' && cheapRedos >= 2) { index = 2; stopReason = '同じ話題・作業で安い段のやり直しが2回になりました'; }
    }
    if (config?.routing !== 'on') index = 2;
    const requestedIndex = index;
    const candidates = KEYS.map(k => slot(k === 'hard' ? base.main : config?.[k]));
    let picked = null, note = config?.routing === 'stopped' ? '停止中のため一番上の段で受け付けました。' : '';
    const available = s => {
      if (!s || oldModel(s.model)) return false;
      const account = this.accountFor(project, task, s.ai);
      const c = s.ai === 'codex' ? this.tools.accountCatalog(s.ai, account) : this.tools.catalog()[s.ai];
      return Boolean(c?.models?.some(m => m.id === s.model)) && !this.modelError(s.ai, s.model, account);
    };
    // Validate explicit overrides against the requested tier, before any availability fallback.
    const intended = candidates[index] || candidates[2];
    if (b.model && (!intended || (launch.flagFor(intended.ai, b.model) || b.model) !== intended.model) || b.effort && b.effort !== intended?.effort) fail(lt('段の設定と model・effort が違います。段を使う時は model・effort を付けないでください'));
    for (; index < 3; index++) if (available(candidates[index])) { picked = candidates[index]; break; }
    let backup = false;
    if (!picked) { picked = slot(base.backup); if (!available(picked)) fail(lt('上の段にも「上限の時」の担当にも、使えるモデルがありません')); index = 2; backup = true; }
    if (index !== requestedIndex || backup) note += '指定した段のモデルがこのアカウントの一覧に無いため、' + (backup ? '「上限の時」の担当' : LABELS[index]) + 'へ回しました。';
    if (!b.redo) first = index;
    const roleTier = { role: b.role, tier: LABELS[index], index, first, requested: b.tier || '難しい', reason: b.reason?.trim() || '段の指定なし・固定担当', redo: b.redo === true, from: b.redo ? prior?.id : null, id: crypto.randomUUID(), backup, note, ...(stopReason ? { stopReason } : {}) };
    return { ...picked, roleTier, account: this.accountFor(project, task, picked.ai), ...(backup ? { limitSlot: 'backup' } : {}), ...(index < 2 ? { freshContext: true, contextMode: 'role-tier' } : {}),
      commit: () => {
        if (!config || !b.redo) return;
        const current = this.read(); if (current.revision !== r.revision) fail(lt('段の設定が変わりました。依頼はまだ開始していません'));
        current.data.redo[key] = { role: b.role, cheapRedos, since: current.data.redo[key]?.since || new Date().toISOString() };
        if (stopReason) { current.data.roles[b.role].routing = 'stopped'; current.data.stops.push({ role: b.role, reason: stopReason, project, task, by: 'auto', at: new Date().toISOString() }); }
        write(this.file, current.data, current.revision);
        if (stopReason) this.notice?.({ role: b.role, reason: stopReason, project, task });
      } };
  }
}
module.exports = { RoleTiers, read, write, validate, snapshot, catalogChanges, draft, slot, cli, oldModel, KEYS, LABELS };
