'use strict';
const { lt } = require('./locale');
// 公開配布の版だけを読む。インストーラやAIは実行しない。
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;
const CLAUDE_DIST = 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';
function readPublic(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Project-Hub', Accept: 'application/json,text/plain' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Error(lt('配布元の応答を確認できません'))); return; }
      let body = '', bytes = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) { req.destroy(Error(lt('応答が大きすぎます'))); return; } body += chunk; });
      res.on('end', () => resolve(body)); res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(Error(lt('時間切れ'))), 10000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
  });
}
async function latestVersion(ai, method, home, read = readPublic) {
  let url, field;
  if (ai === 'codex') { url = 'https://api.github.com/repos/openai/codex/releases/latest'; field = 'tag_name'; }
  else if (ai === 'claude' && method === 'homebrew-cask') { url = 'https://formulae.brew.sh/api/cask/claude-code@latest.json'; field = 'version'; }
  else if (ai === 'claude') {
    let channel = 'latest';
    try { if (JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).autoUpdatesChannel === 'stable') channel = 'stable'; } catch (e) { if (e.code !== 'ENOENT') throw Error(lt('Claudeの更新チャンネルを確認できません')); }
    url = `${CLAUDE_DIST}/${channel}`;
  } else if (ai === 'agy') {
    if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw Error(lt('このOSの配布情報に対応していません'));
    const os = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
    url = `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${os}_${arch}.json`; field = 'version';
  } else if (ai === 'grok') url = 'https://x.ai/cli/stable';
  else throw Error(lt('未対応のAIです'));
  const body = await read(url);
  const version = String(field ? JSON.parse(body)[field] || '' : (ai === 'grok' ? body.split(/\r?\n/)[0].trim() : body.trim())).replace(/^rust-v/, '');
  if (!VERSION.test(version)) throw Error(lt('配布元の版を読めません'));
  return { version, source: url };
}
function newer(latest, current) {
  if (!VERSION.test(latest) || !VERSION.test(current)) return null;
  const a = latest.split(/[.+-]/).slice(0, 3).map(Number), b = current.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return !latest.includes('-') && current.includes('-');
}
module.exports = { latestVersion, newer, readPublic };
