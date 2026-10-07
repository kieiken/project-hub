'use strict';
const { lt } = require('./locale');
// 裏で動いている AI（codex / claude / agy / grok）の見張り。チャットの AI が nohup や & で別の CLI を起動して
// 自分の番を終えると、Hub では終わったように見えるため、ps で探して「裏で作業中」として出す
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { expandHome } = require('./store');

const AIS = ['codex', 'claude', 'agy', 'grok'];
const INTERVAL = 10000, TIMEOUT = 5000, WARN_EVERY = 5 * 60 * 1000;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// 外のコマンドを動かして出力を返す。終わり方が 0 以外でも出力があれば使う（lsof は一部の番号が無いと 1 で終わる）
function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (e, stdout) => {
      if (e && !(typeof e.code === 'number' && stdout)) return reject(e);
      resolve(String(stdout || ''));
    });
  });
}

function psArgs(platform) {
  return platform === 'darwin' ? ['-axo', 'pid=,ppid=,lstart=,command='] : ['-eo', 'pid=,ppid=,lstart=,args='];
}

// lstart（例 "Sun Oct  4 12:34:56 2026"）→ ISO。読めなければ ''
function parseLstart(s) {
  const m = String(s).trim().match(/^\S+\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!m || !(m[1] in MONTHS)) return '';
  const d = new Date(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
  return isNaN(d) ? '' : d.toISOString();
}

// ps の出力 → [{ pid, ppid, since, command }]。日付は曜日・月・日・時刻・年の5つ
function parsePs(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*\S)\s*$/);
    if (!m) continue;
    rows.push({ pid: +m[1], ppid: +m[2], since: parseLstart(m[3]), command: m[4] });
  }
  return rows;
}

// コマンドから AI の種類を見分ける（実行する物の名前が codex / claude / agy / grok の時だけ。引数に出てくるだけの物は除く）
const NAME = '(codex|claude|agy|grok)(?:\\.[cm]?js)?(?=\\s|$)';
const RE_FIRST = new RegExp(`^(?:\\S*/)?${NAME}`);
const RE_APP = new RegExp(`^/.*?\\.app/\\S*?/${NAME}`); // 空白のあるアプリの中の場所
const RE_INTERP = new RegExp(`^(?:\\S*/)?(?:node|nodejs|bun|deno)\\s+(?:-\\S+\\s+)*(?:\\S*/)?${NAME}`);
const RE_PKG = /^(?:\S*\/)?(?:node|nodejs|bun)\s+(?:-\S+\s+)*\S*\/@(?:anthropic-ai\/claude-code|openai\/(codex))\/\S+(?=\s|$)/; // npm で入れた物
function aiOf(command) {
  const c = String(command || '');
  const m = c.match(RE_FIRST) || c.match(RE_APP) || c.match(RE_INTERP);
  if (m) return m[1];
  const k = c.match(RE_PKG);
  return k ? (k[1] ? 'codex' : 'claude') : '';
}

// 見せる時に、鍵らしい物を伏せる
function cleanCmd(command) {
  return String(command || '')
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*=)\S+/gi, '$1***')
    .replace(/(--?[\w-]*(?:key|token|secret|password)[\w-]*(?:=|\s+))(?!-)\S+/gi, '$1***')
    .replace(/\b(sk-|sk-ant-|ghp_|gho_|github_pat_|xox[bp]-|AIza)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .slice(0, 160);
}

// Hub 自身の子孫を除き、AI の物だけ残す。同じ AI の子（node の包み → 本体など）は親の方だけ残す
function pickAi(rows, selfPid) {
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const underSelf = r => { const seen = new Set(); for (let p = r.ppid; p > 1 && !seen.has(p); p = byPid.get(p)?.ppid) { if (p === selfPid) return true; seen.add(p); if (!byPid.has(p)) break; } return false; };
  const kept = rows.filter(r => r.pid !== selfPid && aiOf(r.command) && !underSelf(r));
  const keptAi = new Map(kept.map(r => [r.pid, aiOf(r.command)]));
  return kept.filter(r => keptAi.get(r.ppid) !== keptAi.get(r.pid)).map(r => ({ ...r, ai: keptAi.get(r.pid) }));
}

// lsof -Fpn の出力 → Map(pid → cwd)
function parseLsof(text) {
  const out = new Map(); let pid = 0;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1) || 0;
    else if (line[0] === 'n' && pid && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

// 場所 → プロジェクト・作業。作業の workdir がいちばん長く一致する物、無ければ本体 / 台帳のフォルダ
const inside = (dir, cwd) => Boolean(dir) && (cwd === dir || cwd.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
function mapCwd(cwd, projects, baseOf, real = x => x) {
  if (!cwd) return { project: null, task: null };
  let best = null;
  const consider = (dir, project, task) => {
    for (const d of new Set([dir, real(dir)])) if (inside(d, cwd) && (!best || d.length > best.len || (d.length === best.len && task && !best.task))) best = { len: d.length, project, task };
  };
  for (const p of projects || []) for (const t of p.tasks || []) { const wd = expandHome(t.workdir); if (wd) consider(path.resolve(wd), p.id, t.id); }
  if (best) return { project: best.project, task: best.task };
  for (const p of projects || []) {
    let b = ''; try { b = baseOf ? baseOf(p) : ''; } catch (e) { b = ''; }
    for (const d of [b, p.dir]) if (d) consider(path.resolve(expandHome(d)), p.id, null);
  }
  return best ? { project: best.project, task: best.task } : { project: null, task: null };
}

function create(opts = {}) {
  const platform = opts.platform || process.platform;
  const exec = opts.exec || defaultExec;
  const readlink = opts.readlink || (p => fs.readlinkSync(p));
  const selfPid = opts.selfPid || process.pid;
  const projects = opts.projects || (() => []);
  const baseOf = opts.baseOf;
  const log = opts.log || (m => console.log(m));
  const realCache = new Map();
  const real = d => { if (!realCache.has(d)) { if (realCache.size > 1000) realCache.clear(); let r = d; try { r = fs.realpathSync(d); } catch (e) { r = d; } realCache.set(d, r); } return realCache.get(d); };
  const cwdCache = new Map(); // "pid:since" → cwd
  const listeners = [];
  let current = [], timer = null, busy = false, lastWarn = 0;
  const warn = m => { const now = Date.now(); if (now - lastWarn < WARN_EVERY) return; lastWarn = now; log(lt`[裏の作業の見張り] ${m}`); };

  async function cwds(rows) {
    const key = r => `${r.pid}:${r.since}`;
    const need = rows.filter(r => !cwdCache.has(key(r)));
    if (need.length) {
      if (platform === 'darwin') {
        try {
          const found = parseLsof(await exec('lsof', ['-a', '-d', 'cwd', '-p', need.map(r => r.pid).join(','), '-Fpn']));
          for (const r of need) if (found.has(r.pid)) cwdCache.set(key(r), found.get(r.pid));
        } catch (e) { warn(lt`lsof が使えません：${String(e.message || e).split('\n')[0]}`); }
      } else {
        for (const r of need) { try { cwdCache.set(key(r), readlink(`/proc/${r.pid}/cwd`)); } catch (e) { /* 他人の物・もう無い */ } }
      }
    }
    const alive = new Set(rows.map(key));
    for (const k of cwdCache.keys()) if (!alive.has(k)) cwdCache.delete(k);
    return rows.map(r => cwdCache.get(key(r)) || '');
  }

  async function scan() {
    if (busy) return current;
    busy = true;
    try {
      let text;
      try { text = await exec('ps', psArgs(platform)); }
      catch (e) { warn(lt`ps が使えません：${String(e.message || e).split('\n')[0]}`); return current; }
      const rows = parsePs(text);
      if (!rows.length) { warn(lt('ps の出力を読めませんでした')); return current; }
      const kept = pickAi(rows, selfPid);
      const dirs = kept.length ? await cwds(kept) : [];
      let all = [];
      if (kept.length) { try { all = projects() || []; } catch (e) { all = []; } }
      const next = kept.map((r, i) => ({ pid: r.pid, ai: r.ai, cmd: cleanCmd(r.command), since: r.since, cwd: dirs[i], ...mapCwd(dirs[i], all, baseOf, real) }));
      const before = new Set(current.map(x => x.pid)), after = new Set(next.map(x => x.pid));
      const removed = current.filter(x => !after.has(x.pid)), added = next.filter(x => !before.has(x.pid));
      current = next;
      if (removed.length || added.length) for (const fn of listeners) { try { fn(current, { added, removed }); } catch (e) { log(lt`[裏の作業の見張り] ${e.message}`); } }
      return current;
    } catch (e) { warn(String(e.message || e)); return current; }
    finally { busy = false; }
  }

  return {
    scan,
    list: () => current.slice(),
    onChange: fn => { listeners.push(fn); },
    start(ms = INTERVAL) { if (timer) return; scan().catch(() => {}); timer = setInterval(() => { scan().catch(() => {}); }, ms); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { create, parsePs, parseLstart, parseLsof, aiOf, cleanCmd, pickAi, mapCwd, psArgs };
