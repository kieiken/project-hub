'use strict';
const { lt } = require('./locale');
// gh の認証を操作の間だけ借りる。秘密を設定・応答・コマンド引数に残さない。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const gitw = require('./git');
const execute = promisify(execFile);
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const validName = n => typeof n === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(n) && n !== '.' && n !== '..';
const fail = (message, status = 400) => { const e = Error(message); e.status = status; throw e; };
function mask(s, token = '') {
  s = String(s || '');
  if (token) s = s.split(token).join('***');
  return s.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, '***')
    .replace(/(Bearer\s+)\S+/gi, '$1***').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1')
    .replace(/((?:GH_TOKEN|GITHUB_TOKEN)\s*[=:]\s*)\S+/gi, '$1***').slice(0, 1600);
}
function parseAccounts(raw) {
  const accounts = []; let current;
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/Logged in to github\.com account ([A-Za-z0-9-]+)/);
    if (m && LOGIN.test(m[1])) { current = { login: m[1], active: false }; accounts.push(current); }
    else if (current && /Active account:\s*true/.test(line)) current.active = true;
    else if (/Failed to log in|token.*invalid/i.test(line)) current = null;
  }
  return [...new Map(accounts.map(a => [a.login, a])).values()];
}
function suggestedName(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/^-+|-+$/g, '') || `project-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
}
function createGithub({ exec = execute, settingsFile, init = gitw.init, tooBig = gitw.tooBig, idle = () => {}, dry = false } = {}) {
  let cached, statusPending;
  const locks = new Set();
  const canonical = folder => fs.realpathSync(folder);
  const locked = folder => locks.has(canonical(folder));
  function assertStart(project, task) {
    if (!locked(project.base)) return;
    // 既にある作業用コピーは許可。本体保存やコピーの準備は作成終了後に行う。
    if (task.workspaceMode !== 'direct' && task.workdir && fs.existsSync(task.workdir) && canonical(task.workdir) !== canonical(project.base)) return;
    fail(lt('同じ本体でGitHubの作成中です。終わってからAIを始めてください'), 409);
  }
  // 親の環境の token や gh のデバッグ設定で別アカウントを使ったり秘密をログへ出さない。
  const env = token => {
    const e = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_HOST: 'github.com', LC_ALL: 'C', LANG: 'C' };
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'DEBUG', 'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE']) delete e[k];
    if (token) e.GH_TOKEN = token;
    return e;
  };
  async function run(file, args, cwd, token) {
    const r = await exec(file, args, { cwd, env: env(token), encoding: 'utf8', timeout: args[0] === 'auth' && args[1] === 'status' ? 15000 : 90000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return typeof r === 'string' ? { stdout: r, stderr: '' } : r;
  }
  async function git(folder, args) { return (await run('git', ['-C', folder, ...args])).stdout.trim(); }
  async function optional(folder, args) { try { return await git(folder, args); } catch { return null; } }
  function settings() {
    try { const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); return { account: LOGIN.test(s.account) ? s.account : 'kieiken', owner: LOGIN.test(s.owner) ? s.owner : '' }; }
    catch { return { account: 'kieiken', owner: '' }; }
  }
  async function status({ fresh = false } = {}) {
    if (dry) return { gh: false, ready: false, accounts: [], error: lt('テスト中は GitHub に接続しません') };
    if (!fresh && cached && Date.now() - cached.at < 60000) return cached.value;
    if (statusPending) return statusPending;
    statusPending = (async () => {
      let value;
      try {
        await run('gh', ['--version']);
        let r; try { r = await run('gh', ['auth', 'status', '--hostname', 'github.com']); } catch (e) { r = e; }
        const accounts = parseAccounts(`${r.stdout || ''}\n${r.stderr || ''}`);
        value = { gh: true, ready: accounts.length > 0, accounts, ...(accounts.length ? {} : { error: lt('GitHub にログインしていません。設定画面の［GitHub］欄でログインしてください') }) };
      } catch { value = { gh: false, ready: false, accounts: [], error: lt('GitHub の道具（gh）が入っていません。設定画面の［GitHub］欄を見てください') }; }
      cached = { at: Date.now(), value }; return value;
    })();
    try { return await statusPending; } finally { statusPending = null; }
  }
  function summary() {
    if (dry) return { ready: false, error: lt('テスト中は GitHub に接続しません') };
    // 一覧は認証検証の通信を待たない。詳細画面だけ status() を待つ。
    if (!cached || Date.now() - cached.at >= 60000) void status().catch(() => {});
    return cached ? { ready: cached.value.ready, error: cached.value.error || '' } : { ready: false, error: lt('GitHubのログインを確認中です') };
  }
  async function tokenFor(account) {
    const s = await status();
    if (!s.accounts.some(a => a.login === account)) fail(lt('ログイン済みのアカウントを選んでください'));
    try { const t = (await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account])).stdout.trim(); if (!t || /\s/.test(t)) throw Error(); return t; }
    catch { fail(lt`${account} のログインが切れています。設定画面の［GitHub］欄でログインし直してください`); }
  }
  async function owners(account) {
    const token = await tokenFor(account);
    try {
      const r = await run('gh', ['api', '--hostname', 'github.com', 'user/orgs', '--paginate', '--jq', '.[].login'], undefined, token);
      return [...new Set([account, ...r.stdout.split('\n').map(s => s.trim()).filter(s => LOGIN.test(s))])];
    } catch (e) { fail(lt`組織を読み込めませんでした：${mask(e.stderr || e.message, token)}`); }
  }
  async function save({ account, owner = '' }) {
    const st = await status();
    if (!LOGIN.test(account) || !st.accounts.some(a => a.login === account)) fail(lt('ログイン済みのアカウントを選んでください'));
    if (owner && owner !== account && !(await owners(account)).includes(owner)) fail(lt('所属する組織かアカウント本人を選んでください'));
    const s = { account, owner: owner === account ? '' : owner };
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2) + '\n'); return s;
  }
  // HEAD のファイルだけでは、削除済みの秘密も送ってしまう。到達可能な履歴も調べる。
  async function risks(folder, head) {
    if (!head) return [];
    // blob一覧の代表名ではなく全コミットの変更パスを読む。改名を分解し、
    // mergeの各親とrootも比較する。NUL区切りなので改行・タブ入りの名前も保持。
    const raw = (await run('git', ['-C', folder, 'log', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--root', '-m', '--full-history', '--format=', head, '--'])).stdout;
    const parts = raw.split('\0'), entries = [];
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].match(/^\s*:[0-7]{6} [0-7]{6} ([a-f0-9]+) ([a-f0-9]+) [A-Z]\d*$/);
      if (!m) continue;
      const file = parts[++i];
      for (const oid of new Set([m[1], m[2]])) if (!/^0+$/.test(oid)) entries.push({ oid, file });
    }
    const sizes = new Map((await git(folder, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objectsize)'])).split('\n').map(l => l.split(' ')));
    const result = [], seen = new Set();
    for (const x of entries) {
      const b = path.posix.basename(x.file);
      let reason = '';
      if (b !== '.env.example' && b !== '.env.sample' && (/^(\.env(\..*)?|\.dev\.vars(\..*)?|\.npmrc|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa|dsa).*)$/i.test(b) || /(^|\/)\.claude\/settings\.local\.json$/.test(x.file))) reason = lt('秘密設定らしいファイル（履歴を含む）');
      // blob のサイズは履歴中のオブジェクトから調べる。作業中のファイルや symlink は読まない。
      const bytes = Number(sizes.get(x.oid));
      if (bytes > 50 * 1024 ** 2) reason += `${reason ? '・' : ''}${bytes > 100 * 1024 ** 2 ? lt('100MB超（GitHubが受け付けない大きさ）') : lt('50MB超')}`;
      if (reason && !seen.has(x.file + reason)) { result.push({ file: x.file, reason, bytes }); seen.add(x.file + reason); }
    }
    return result;
  }
  async function preview(project) {
    const folder = project.base, st = await status(), s = settings();
    const blockers = []; const top = await optional(folder, ['rev-parse', '--show-toplevel']);
    const real = p => fs.realpathSync(p);
    const type = !top ? 'none' : real(top) === real(folder) ? 'repo' : 'nested';
    const origin = await optional(folder, ['config', '--get', 'remote.origin.url']);
    const head = type === 'repo' ? await optional(folder, ['rev-parse', '--verify', 'HEAD']) : null;
    const branch = head ? await optional(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : '';
    if (!st.ready) blockers.push(st.error);
    if (type === 'nested') blockers.push(lt`このフォルダは別の Git（${top}）の中にあります。そのフォルダで作ってください`);
    if (origin !== null && type === 'repo') blockers.push(lt`すでに送り先（origin）があります：${gitw.webUrl(origin) || lt('登録済み')}`);
    if (type === 'none' && tooBig(folder)) blockers.push(lt('ファイルが多すぎるため、Git の保存は始められません'));
    const account = st.accounts.find(a => a.login === s.account)?.login || st.accounts.find(a => a.active)?.login || st.accounts[0]?.login || '';
    return { project: project.id, folder, ledger: folder === project.dir, git: type, hasOrigin: type === 'repo' && origin !== null,
      branch: branch || '', head: head || '', canPush: Boolean(head && branch), dirty: type === 'repo' && Boolean(await optional(folder, ['status', '--porcelain'])),
      commits: head ? Number(await git(folder, ['rev-list', '--count', head])) : 0, risky: await risks(folder, head), blockers,
      remotes: type === 'repo' ? (await git(folder, ['remote'])).split('\n').filter(Boolean) : [],
      suggestedName: suggestedName(project.name), accounts: st.accounts, defaultAccount: account, defaultOwner: account === s.account ? s.owner || account : account };
  }
  async function create(project, input) {
    // 同じ本体を参照する別台帳も、一つのロックにする。
    const key = fs.realpathSync(project.base);
    if (locks.has(key)) fail(lt('作成中です'), 409);
    locks.add(key);
    let token = '', created = false, connected = false, initialized = false, pushed = false;
    const url = `https://github.com/${input.owner || input.account}/${input.name}`;
    try {
      if (!validName(input.name) || !LOGIN.test(input.account) || !LOGIN.test(input.owner || input.account)) fail(lt('名前は英数字・ハイフン・アンダースコア・ピリオドで1〜100文字にしてください'));
      if (input.push !== undefined && typeof input.push !== 'boolean') fail(lt('送信するかどうかを選んでください'));
      if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 1000)) fail(lt('説明は1000文字以内にしてください'));
      const owner = input.owner || input.account;
      const d = await preview(project);
      if (d.blockers.length) fail(d.blockers.join('\n'), 409);
      idle(project);
      if (input.push && (!d.canPush || input.expectedHead !== d.head || input.expectedBranch !== d.branch)) fail(lt('送信する保存またはブランチが変わりました。確認画面を開き直してください'), 409);
      token = await tokenFor(input.account);
      if (owner !== input.account && !(await owners(input.account)).includes(owner)) fail(lt('所属する組織かアカウント本人を選んでください'));
      // 認証・組織照会を待つ間に稼働状態が変わっても、本体を初期保存しない。
      idle(project);
      if (d.git === 'none') { const r = init(project.base); if (!r.ok) fail(r.reason); initialized = true; await git(project.base, ['config', 'hub.mode', 'direct']); }
      const args = ['repo', 'create', `${owner}/${input.name}`, '--private'];
      if (input.description) args.push('--description', input.description);
      await run('gh', args, project.base, token); created = true;
      await git(project.base, ['remote', 'add', 'origin', url + '.git']); connected = true;
      gitw.remoteInfoCache.clear();
      if (input.push) {
        idle(project);
        if (await git(project.base, ['rev-parse', 'HEAD']) !== d.head || await optional(project.base, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== d.branch) fail(lt('送信前に保存またはブランチが変わりました。今回は送信しません'));
        const destinations = await git(project.base, ['remote', 'get-url', '--push', '--all', 'origin']);
        if (destinations !== url + '.git') fail(lt('送信先が作ったリポジトリと違います。今回は送信しません'));
        await run('git', ['-C', project.base, '-c', 'credential.helper=', '-c', 'credential.helper=!f(){ echo username=x-access-token; echo password=$GH_TOKEN; };f', 'push', '-u', 'origin', `${d.head}:refs/heads/${d.branch}`], undefined, token);
        pushed = true;
        if (await optional(project.base, ['rev-parse', `refs/heads/${d.branch}`]) === d.head) {
          await git(project.base, ['branch', '--set-upstream-to', `origin/${d.branch}`, d.branch]);
        }
      }
      return { ok: true, url, private: true, pushed, created, connected, initialized, message: lt('作りました') };
    } catch (e) {
      const reason = mask(e.stderr || e.message, token);
      if (created) return { ok: false, partial: true, created, connected, initialized, url, private: true, pushed,
        message: pushed ? lt`リポジトリの作成と送信はできましたが、ブランチの送り先設定に失敗しました：${reason}` : connected ? lt`リポジトリの作成と送り先の登録はできましたが、送信に失敗しました：${reason}。あとで AI かターミナルで送れます` : lt`GitHub にリポジトリは作りましたが、送り先の登録に失敗しました：${reason}` };
      let message = reason;
      if (/already exists|name already exists/i.test(reason)) message = lt`GitHub に同じ名前のリポジトリがあります（${input.owner || input.account}/${input.name}）。名前を変えてください`;
      else if (/401|bad credentials|authentication/i.test(reason)) message = lt`${input.account} のログインが切れています。設定画面の［GitHub］欄でログインし直してください`;
      else if (/403|permission|not authorized/i.test(reason)) message = lt`${input.owner || input.account} に作る権限がありません`;
      else if (/timeout|ENOTFOUND|ECONN|connect/i.test(reason)) message = lt('GitHub につながりませんでした。作成されたかは未確認です。GitHubで確かめてから続けてください');
      if (initialized) return { ok: false, partial: true, created: false, connected: false, initialized, pushed: false, message: lt`Git の保存は始めました。リポジトリの作成は完了していません：${message}` };
      fail(message, e.status || 400);
    } finally { locks.delete(key); }
  }
  return { summary, status, settings, save, owners, preview, create, locked, assertStart };
}
module.exports = { createGithub, parseAccounts, suggestedName, validName, mask };
