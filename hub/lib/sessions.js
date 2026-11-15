'use strict';
const { lt } = require('./locale');
// 画面の中の作業画面：作業ごとに Claude Code / Codex を動かし、画面とつなぐ
// node-pty が無い時（準備前）は、その旨を返して落ちないようにする
const os = require('os');
const fs = require('fs');
const path = require('path');
const platforms = require('./platform');
const { childEnv, accountEnv, agyAccountError, resolveCli } = require('./launch');

let pty = null;
try { pty = require('node-pty'); } catch (e) { pty = null; }

// node-pty の配布物は spawn-helper に実行の許可が付いていないことがある（Mac で posix_spawnp failed になる）
function fixHelper() {
  let base;
  try { base = path.dirname(require.resolve('node-pty/package.json')); } catch { return; }
  platforms.fixPtyHelper(base);
}
if (pty) fixHelper();

const MAX_SCROLLBACK = 200000; // 画面を開き直した時に見せる分（文字数）

class Sessions {
  constructor(options = {}) {
    this.pty = options.pty || pty;
    this.platform = options.platformApi || platforms.forPlatform(options.platform);
    this.map = new Map(); // key: project/task/ai → { proc, buf, watchers, ai, dir, started, exited }
    this.stopControl=options.stopControl;
    this.onExit = null; // 終わった時に呼ぶ（project, task, ai, s）。未読の印に使う
  }

  available() { return Boolean(this.pty); }

  key(project, task, ai) { return `${project}\u0000${task}\u0000${ai}`; }

  get(project, task, ai) { return this.map.get(this.key(project, task, ai)) || null; }

  list() {
    const out = [];
    for (const [k, s] of this.map) {
      const [project, task, ai] = k.split('\u0000');
      // 最後の出力からの秒数。処理中も無出力になるため、入力待ちの根拠にはしない。
      out.push({ project, task, ai, account: s.account || 'default', running: !s.exited, started: s.started, quiet: Math.round((Date.now() - s.lastOut) / 1000) });
    }
    return out;
  }

  // 作業画面を開く。すでに動いていればそれを返す
  start({ project, task, ai, dir, command, args, env, cols, rows, account = 'default', model, effort, role, limitSlot, prompt, head, status, limitMarker, licenseFeatures }) {
    this.stopControl?.assert({project,task});
    if (!this.pty) throw new Error(lt('作業画面の部品（node-pty）が入っていません。setup.sh を実行してください'));
    const k = this.key(project, task, ai);
    const cur = this.map.get(k);
    if (cur && !cur.exited) { if ((cur.account || 'default') !== account) throw Error(lt('このAIは別のアカウントで作業中です。終了してから切り替えてください')); return cur; }
    this.licenseGuard?.({ project, task, ai, licenseFeatures }, 'start');
    if (ai === 'agy') { const error = agyAccountError(); if (error) throw new Error(error); }
    const blocked=this.canStart?.(ai,{project,task,dir});if(blocked)throw Error(blocked);
    const fullEnv = childEnv(ai, accountEnv(ai, account, { ...process.env, ...env, TERM: 'xterm-256color', LANG: process.env.LANG || 'ja_JP.UTF-8', HOME: os.homedir() }));
    if (!dir || !fs.existsSync(dir)) throw new Error(lt`作業の場所が見つかりません: ${dir}`);
    const exe = this.platform.findExecutable(command, fullEnv.PATH);
    if (!exe) throw new Error(lt`「${command}」が見つかりません。ターミナルで ${command} が動くか確かめてください`);
    require('./owned-processes').assertLaunchOwnership(this.platform);
    const limitWatch = this.prepare?.({ ai, account, dir, limitMarker });
    let proc;
    const gateOptions={project,task,ai,dir};this.startGate?.(gateOptions);
    try {
      const argv = resolveCli(exe, args, fullEnv, ai); // Windows の npm シム（.cmd）は本体に展開する
      proc = this.pty.spawn(argv.file, argv.args, { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env: fullEnv });
    } catch (e) {
      this.endGate?.(gateOptions);
      throw new Error(lt`作業画面を開けませんでした（${e.message}）`);
    }
    const s = { head, status, model, effort, role, limitSlot, prompt, limitWatch, proc, buf: '', watchers: new Set(), ai, account, dir, started: Date.now(), lastOut: Date.now(), exited: false, code: null };
    try{s.identity=require('./owned-processes').capture(proc.pid);}catch(e){s.ownershipError=e.message;}
    s.finishedP = new Promise(resolve => { s.resolveFinished = resolve; });
    proc.onData(d => {
      // 大きさを変えた直後の描き直しは「作業中」に数えない
      if (Date.now() - (s.resizedAt || 0) > 1500) s.lastOut = Date.now();
      s.buf += d;
      if (s.buf.length > MAX_SCROLLBACK) s.buf = s.buf.slice(-MAX_SCROLLBACK);
      for (const w of s.watchers) w({ type: 'data', data: d });
    });
    proc.onExit(({ exitCode }) => {
      s.exited = true; s.code = exitCode;this.endGate?.(gateOptions); s.resolveFinished();
      for (const w of s.watchers) w({ type: 'exit', code: exitCode });
      if (this.onExit) { try { this.onExit(project, task, ai, s); } catch (e) { s.saveError=e.message; } }
    });
    this.map.set(k, s);
    return s;
  }

  write(project, task, ai, data) {
    const s = this.get(project, task, ai);
    if (!s || s.exited || s.stopped || this.stopControl?.held({project,task})) return false;
    s.proc.write(data);
    return true;
  }

  // 入力欄に打ってから Enter を押す（すぐ Enter を送ると、貼り付けと見なされ改行になる CLI がある）
  type(project, task, ai, text) {
    const s = this.get(project, task, ai);
    if (!s || s.exited || s.stopped || this.stopControl?.held({project,task})) return false;
    s.proc.write(text);
    setTimeout(() => { if (!s.exited && !s.stopped && !this.stopControl?.held({project,task})) s.proc.write('\r'); }, 150);
    return true;
  }

  resize(project, task, ai, cols, rows) {
    const s = this.get(project, task, ai);
    if (!s || s.exited || s.stopped || this.stopControl?.held({project,task})) return false;
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
    if (!s.exited) { try { s.proc.kill(); } catch (e) { s.stopError=e.message; } }
    // Keep the session until the exit callback, never claim kill == exit.
    if(s.exited)this.map.delete(this.key(project, task, ai));
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
