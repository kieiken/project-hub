'use strict';
const { lt } = require('./locale');
// roles.yaml の読み書き。roles: の中だけを書き換え、それ以外の行（コメントを含む）は残す
const fs = require('fs');
const { parseYaml } = require('./frontmatter');
const { MODEL_FLAG, AGY_MODEL, flagFor } = require('./launch');

const EFFORTS = ['中', '高', '極高', 'MAX', 'Ultra'];
const AIS = ['claude-code', 'codex', 'agy', 'grok', '人'];
let discovered = { 'claude-code': [], codex: [], agy: [], grok: [] };
function setModelCatalog(catalog) {
  discovered = { grok: catalog.grok?.models || [], 'claude-code': catalog.claude?.models || [], codex: catalog.codex?.models || [], agy: (catalog.agy?.models || []).filter(x => x.id === AGY_MODEL.id) };
}

const cliOf = ai => (ai === 'claude-code' ? 'claude' : ai);
function delegateSlot(data, name) {
  const s = data.roles.find(r => r.name === name)?.main;
  return s && s.ai !== '人' && s.model ? { ai: cliOf(s.ai), model: flagFor(cliOf(s.ai), s.model) || s.model, effort: s.effort } : null;
}
const idOf = (ai, name) => MODEL_FLAG[cliOf(ai)]?.[name] || name;
// 今の一覧での名前（古い呼び名が同じモデルを指していれば、今の名前に）
function currentName(ai, name) {
  const list = discovered[ai];
  if (!name || !list || !list.length || list.some(x => x.label === name)) return name;
  const hit = list.find(x => x.id === idOf(ai, name));
  return hit ? hit.label : name;
}
// 画面で使いやすい形にする
function normalize(raw) {
  const source = raw.models || {};
  const models = { ...source, 'claude-code': [...(source['claude-code'] || [])], codex: [...(source.codex || [])], agy: discovered.agy.map(x => x.label), grok: discovered.grok.map(x => x.label) };
  for (const [ai, cli] of [['claude-code', 'claude'], ['codex', 'codex']]) {
    // CLI から今のモデル一覧が取れている時は、それだけを並べる（古い呼び名は出さない）。
    // roles.yaml の名前が同じモデルを指していれば、その名前を使う（役割の設定がそのまま通るように）
    if (discovered[ai].length) { models[ai] = [...new Set(discovered[ai].map(x => x.label))]; continue; }
    const ids = new Set(models[ai].map(name => MODEL_FLAG[cli]?.[name] || name));
    for (const { id, label } of discovered[ai]) {
      if (!ids.has(id) && !models[ai].includes(label)) { models[ai].push(label); ids.add(id); }
    }
  }
  const roles = [];
  for (const [name, r] of Object.entries(raw.roles || {})) {
    const main = Array.isArray(r.main) ? r.main : [r.main];
    const backup = Array.isArray(r.backup) ? r.backup : [r.backup];
    roles.push({
      name,
      job: r.job || '',
      main: { ai: main[0] || '人', model: main[1] || '', effort: main[2] || '' },
      backup: { ai: backup[0] || '人', model: backup[1] || '', effort: backup[2] || '' },
    });
  }
  // Discord のエージェント。設定がなければ担当の名前を補わない。
  const agents = Array.isArray(raw.agents) ? raw.agents.filter(Boolean).map(String) : [];
  // 古い呼び名（6sol など）でも、今の一覧のモデルを指していれば、その名前で見せる
  for (const r of roles) for (const s of [r.main, r.backup]) s.model = currentName(s.ai, s.model);
  // 以前選んだモデルは、一覧から消えても役割の選択値を保つ。
  for (const r of roles) for (const s of [r.main, r.backup]) {
    if (models[s.ai] && s.model && !models[s.ai].includes(s.model)) models[s.ai].push(s.model);
  }
  return { models, roles, agents, permissions: raw.permissions || {}, switch: raw.switch || {} };
}

function fmtSlot(s) {
  if (!s || s.ai === '人' || !s.ai) return '[人]';
  const parts = [s.ai, s.model, s.effort].filter(v => v !== '' && v != null);
  return `[${parts.join(', ')}]`;
}

// 入力を確かめる（画面からの値をそのまま信じない）
function validate(models, roles) {
  const errors = [];
  for (const r of roles) {
    if (!r.name || /[\n\r{}\[\]:#]/.test(r.name)) errors.push(lt`役割名が不正です: ${r.name}`);
    for (const k of ['main', 'backup']) {
      const s = r[k] || {};
      if (!AIS.includes(s.ai)) errors.push(lt`${r.name} の ${k}: AI が不正です`);
      if (s.ai !== '人') {
        const list = models[s.ai] || [];
        if (!list.includes(s.model)) errors.push(lt`${r.name} の ${k}: モデル「${s.model}」は ${s.ai} で選べません`);
        if (s.ai === 'agy' && (s.model !== AGY_MODEL.label || s.effort !== '高')) errors.push(lt`${r.name} の ${k}: Gemini は承認モデル・思考「高」に固定です`);
        if (!(s.ai === 'grok' ? EFFORTS.filter(x => x !== 'Ultra') : EFFORTS).includes(s.effort)) errors.push(lt`${r.name} の ${k}: 思考「${s.effort}」は選べません`);
      }
    }
    if (/[\n\r]/.test(r.job || '')) errors.push(lt`${r.name} の内容に改行は使えません`);
  }
  return errors;
}

function render(roles) {
  return roles.map(r => `  ${r.name}: { main: ${fmtSlot(r.main)}, backup: ${fmtSlot(r.backup)}, job: ${r.job} }`).join('\n');
}

// roles.yaml は1回の一覧で何度も読まれる。更新時刻と大きさが同じなら、前に読んで分けた物を使う
let last = null;
function read(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { last = null; return { text: '', data: normalize({}) }; }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (!last || last.key !== key) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { last = null; return { text: '', data: normalize({}) }; }
    last = { key, text, raw: parseYaml(text) };
  }
  return { text: last.text, data: normalize(last.raw) };
}

// roles: ブロックだけ差し替えて保存
function write(file, roles) {
  const { text, data } = read(file);
  const errors = validate(data.models, roles);
  if (errors.length) return { ok: false, errors };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^roles:\s*(#.*)?$/.test(l));
  const body = render(roles);
  let out;
  if (start < 0) {
    out = text.replace(/\s*$/, '') + `\n\nroles:\n${body}\n`;
  } else {
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
    // 末尾の空行はブロックの外に残す
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    out = [...lines.slice(0, start + 1), ...body.split('\n'), ...lines.slice(end)].join('\n');
  }
  fs.writeFileSync(file, out);
  return { ok: true, data: normalize(parseYaml(out)) };
}

// 最新に整理：役割で使っているモデルが今の一覧に無ければ、同じ系統（sol・opus など）の一番新しいモデルに置き換える。
// models: の行も今の一覧に書き換える。changes を返す（何も変えない時は空）
const FAMILY = /(opus|fable|sonnet|haiku|astra|sol|luna|terra|mini|nano|codex)/i;
function versionOf(s) { return (String(s).match(/\d+(?:[.-]\d+)*/g) || []).map(x => x.split(/[.-]/).map(Number)).sort((a, b) => cmp(b, a))[0] || []; }
function cmp(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }
function familyOf(name, id) { const m = String(id || '').match(FAMILY) || String(name || '').match(FAMILY); return m ? m[1].toLowerCase() : ''; }
function tidy(file) {
  const { text, data } = read(file); // data の役割は、今の名前に直したもの
  const changes = [];
  if (!text) return { ok: false, error: lt('roles.yaml がありません'), changes };
  if (!discovered['claude-code'].length && !discovered.codex.length) return { ok: false, error: lt('先に設定画面の「AI の更新」で［モデル一覧を取り直す］を押してください'), changes };
  const raw = parseYaml(text).roles || {};
  const roles = data.roles.map(r => ({ ...r, main: { ...r.main }, backup: { ...r.backup } }));
  for (const r of roles) {
    const before = raw[r.name] || {};
    for (const [k, slot, orig] of [[lt('いつもの担当'), r.main, before.main], [lt('上限の時'), r.backup, before.backup]]) {
      const was = Array.isArray(orig) ? orig[1] || '' : '';
      const list = discovered[slot.ai];
      if (list && list.length && slot.model && !list.some(x => x.label === slot.model)) {
        // 今の一覧に無い：同じ系統（sol・opus など）の一番新しいモデルへ
        const fam = familyOf(slot.model, idOf(slot.ai, slot.model));
        const to = list.filter(x => fam && familyOf(x.label, x.id) === fam).sort((x, y) => cmp(versionOf(y.id), versionOf(x.id)))[0];
        if (to) slot.model = to.label;
      }
      if (was && was !== slot.model) changes.push({ role: r.name, slot: k, from: was, to: slot.model });
    }
  }
  // models: の行を、今の一覧に書き換える（古い呼び名を消す）
  let out = text;
  for (const ai of ['claude-code', 'codex']) {
    if (!discovered[ai].length) continue;
    out = out.replace(new RegExp(`^(\\s+${ai}:\\s*)\\[[^\\]\\n]*\\]`, 'm'), (all, head) => `${head}[${data.models[ai].filter(n => discovered[ai].some(x => x.label === n)).join(', ')}]`);
  }
  if (out !== text) fs.writeFileSync(file, out);
  if (changes.length) { const w = write(file, roles); if (!w.ok) return { ok: false, error: w.errors.join(' / '), changes: [] }; }
  return { ok: true, changes };
}

module.exports = { read, write, validate, normalize, tidy, EFFORTS, AIS, setModelCatalog, delegateSlot };
