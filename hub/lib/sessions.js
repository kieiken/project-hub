'use strict';
const { lt } = require('./locale');
// 画面の中の作業画面：作業ごとに Claude Code / Codex を動かし、画面とつなぐ
// node-pty が無い時（準備前）は、その旨を返して落ちないようにする
const os = require('os');
const fs = require('fs');
const path = require('path');
const { childEnv, accountEnv, agyAccountError } = require('./launch');

let pty = null;
try { pty = require('node-pty'); } catch (e) { pty = null; }

// node-pty の配布物は spawn-helper に実行の許可が付いていないことがある（Mac で posix_spawnp failed になる）
function fixHelper() {
  let base;
  try { base = path.dirname(require.resolve('node-pty/package.json')); } catch (e) { return; }
  for (const sub of ['prebuilds', 'build/Release', 'build/Debug']) {
    const dir = path.join(base, sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      const f = n === 'spawn-helper' ? path.join(dir, n) : path.join(dir, n, 'spawn-helper');
      try { if (fs.existsSync(f)) fs.chmodSync(f, 0o755); } catch (e) { /* 無視 */ }
    }
  }
}
if (pty) fixHelper();

// コマンドが PATH のどこにあるか探す（見つからなければ null）
function which(cmd, envPath) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const d of String(envPath || '').split(':')) {
    if (!d) continue;
    const f = path.join(d, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (e) { /* 次へ */ }
  }
  return null;
}

const MAX_SCROLLBACK = 200000; // 画面を開き直した時に見せる分（文字数）

class Sessions {
  constructor(options = {}) {
    this.pty = options.pty || pty;
    this.map = new Map(); // key: project/task/ai → { proc, buf, watchers, ai, dir, started, exited }
    this.onExit = null; // 終わった時に呼ぶ（project, task, ai, s）。未読の印に使う
  }

  available() { return Boolean(this.pty); }

  key(project, task, ai) { return `${project}\u0000${task}\u0000${ai}`; }

  get(project, task, ai) { return this.map.get(this.key(project, task, ai)) || null; }

  list() {
    const out = [];
    for (const [k, s] of this.map) {
      const [project, task, ai] = k.split('\u0000');
      // 画面が止まっている秒数。Claude Code・Codex は作業中ずっと表示が動くので、止まっていれば入力待ち
      out.push({ project, task, ai, account: s.account || 'default', running: !s.exited, started: s.started, quiet: Math.round((Date.now() - s.lastOut) / 1000) });
    }
    return out;
  }

  // 作業画面を開く。すでに動いていればそれを返す
  start({ project, task, ai, dir, command, args, env, cols, rows, account = 'default' }) {
    if (!this.pty) throw new Error(lt('作業画面の部品（node-pty）が入っていません。setup.sh を実行してください'));
    const k = this.key(project, task, ai);
    const cur = this.map.get(k);
    if (cur && !cur.exited) { if ((cur.account || 'default') !== account) throw Error(lt('このAIは別のアカウントで作業中です。終了してから切り替えてください')); return cur; }
    if (ai === 'agy') { const error = agyAccountError(); if (error) throw new Error(error); }
    const fullEnv = childEnv(ai, accountEnv(ai, account, { ...process.env, ...env, TERM: 'xterm-256color', LANG: process.env.LANG || 'ja_JP.UTF-8', HOME: os.homedir() }));
    if (!dir || !fs.existsSync(dir)) throw new Error(lt`作業の場所が見つかりません: ${dir}`);
    const exe = which(command, fullEnv.PATH);
    if (!exe) throw new Error(lt`「${command}」が見つかりません。ターミナルで ${command} が動くか確かめてください`);
    let proc;
    try {
      proc = this.pty.spawn(exe, args, { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env: fullEnv });
    } catch (e) {
      throw new Error(lt`作業画面を開けませんでした（${e.message}）`);
    }
    const s = { proc, buf: '', watchers: new Set(), ai, account, dir, started: Date.now(), lastOut: Date.now(), exited: false, code: null };
    proc.onData(d => {
      // 大きさを変えた直後の描き直しは「作業中」に数えない
      if (Date.now() - (s.resizedAt || 0) > 1500) s.lastOut = Date.now();
      s.buf += d;
      if (s.buf.length > MAX_SCROLLBACK) s.buf = s.buf.slice(-MAX_SCROLLBACK);
      for (const w of s.watchers) w({ type: 'data', data: d });
    });
    proc.onExit(({ exitCode }) => {
      s.exited = true; s.code = exitCode;
      for (const w of s.watchers) w({ type: 'exit', code: exitCode });
      if (this.onExit) { try { this.onExit(project, task, ai, s); } catch (e) { /* 無視 */ } }
    });
    this.map.set(k, s);
    return s;
  }

  write(project, task, ai, data) {
    const s = this.get(project, task, ai);
    if (!s || s.exited) return false;
    s.proc.write(data);
    return true;
  }

  // 入力欄に打ってから Enter を押す（すぐ Enter を送ると、貼り付けと見なされ改行になる CLI がある）
  type(project, task, ai, text) {
    const s = this.get(project, task, ai);
    if (!s || s.exited) return false;
    s.proc.write(text);
    setTimeout(() => { if (!s.exited) s.proc.write('\r'); }, 150);
    return true;
  }

  resize(project, task, ai, cols, rows) {
    const s = this.get(project, task, ai);
    if (!s || s.exited) return false;
    const c = Math.max(20, cols | 0), r = Math.max(5, rows | 0);
    if (s.proc.cols === c && s.proc.rows === r) return true;
    s.resizedAt = Date.now();
    try { s.proc.resize(c, r); } catch (e) { /* 無視 */ }
    return true;
  }

  stop(project, task, ai) {
    const s = this.get(project, task, ai);
    if (!s) return false;
    s.stopped = true; // 人が止めた（未読にしない）
    if (!s.exited) { try { s.proc.kill(); } catch (e) { /* 無視 */ } }
    this.map.delete(this.key(project, task, ai));
    return true;
  }

  watch(project, task, ai, fn) {
    const s = this.get(project, task, ai);
    if (!s) return () => {};
    s.watchers.add(fn);
    return () => s.watchers.delete(fn);
  }

  stopAll() { for (const [k] of this.map) { const [p, t, a] = k.split('\u0000'); this.stop(p, t, a); } }
}

module.exports = { Sessions };
