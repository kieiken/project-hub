'use strict';
const { lt } = require('./locale');
// Grok Build の公開された models 出力だけを読む。認証の生出力は返さない。
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
function models(text) {
  const ids = String(text).split(/\r?\n/).map(line => line.match(/^\s{2,}[*-]\s+(\S+)(?:\s+\(default\))?\s*$/)?.[1]).filter(id => id && ID.test(id));
  return [...new Set(ids)].map(id => ({ id, label: id }));
}
function authStatus({ error, stdout = '' }) {
  if (error?.code === 'ENOENT') return { status: 'not-installed', message: lt('Grok Build が未導入です') };
  if (error?.killed || error?.code === 'ETIMEDOUT') return { status: 'unknown', message: lt('ログイン状態の確認が時間切れになりました') };
  const first = String(stdout).split(/\r?\n/)[0].trim();
  if (/^You are using XAI_API_KEY\.$|^Model '.+' is using its own API key\.$|^You are authenticated via deployment key\.$/.test(first)) return { status: 'api', message: lt('APIのログインは対象外です') };
  if (first === 'You are not authenticated.') return { status: 'logged-out' };
  if (!error && /^You are logged in with .+\.$/.test(first)) return { status: 'logged-in' };
  return { status: 'unknown', message: lt('ログイン状態を確認できませんでした') };
}
function loginError(message) {
  return /Not signed in\./i.test(message) ? lt('Grok にログインしていません。設定 › AI › AIアカウントの［ログイン］からログインしてください。') : message;
}
module.exports = { models, authStatus, loginError };
