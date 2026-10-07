'use strict';
const { lt } = require('./locale');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function git(dir, args) {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 2000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd(); } catch { return null; }
}
function snapshot(dir) { if (!dir) return { head: null, status: null }; return { head: git(dir, ['rev-parse', 'HEAD']), status: git(dir, ['status', '--short']) }; }
function clip(value, max) { const text = String(value || ''); return text.length > max ? text.slice(0, max - 1) + '…' : text; }
function buildHandoffCard({ original, user, rows, dir, pdir, task, queue = [], delegates = [], direct = false, evidence }) {
  const intro = lt('【Fable の利用上限による自動の引き継ぎ】Fable 5.1 は利用上限で止まった。担当は起動設定どおり Codex・GPT-6-Astra。すでに済んだ部分は繰り返さず、残りを続ける。');
  if (direct) return lt`【Fable の利用上限による自動の引き継ぎ】Fable 5.1 上限保持中（記録${evidence?.at || lt('確認済み')}・解除${evidence?.validUntil || lt('手動解除まで')}）。最初から Astra で開始。担当は起動設定どおり Codex・GPT-6-Astra。すでに済んだ部分は繰り返さず、残りを続ける。\n前の番は無い（保持中の開始）。\n\n元の依頼：\n${original}`;
  const index = rows.findIndex(r => r.role === 'user' && r.at === user?.at && r.text === user?.text);
  const tools = index < 0 ? null : rows.slice(index + 1).filter(r => r.tool === true);
  const now = snapshot(dir);
  const safeHead = /^[a-f0-9]{40,64}$/i.test(user?.head || '');
  const changes = safeHead && now.head && user.head !== now.head ? git(dir, ['log', '--oneline', `${user.head}..HEAD`]) : '';
  // 新しい番は送り元IDで判定。旧記録だけは時刻で判定し、受信requestを除く。
  const outgoing = r => !(r.id && r.id === user?.request) && (Object.hasOwn(r, 'sourceTurn') ? Boolean(user?.turn && r.sourceTurn === user.turn) : !user?.turn && r.at >= (user?.startedAt || user?.at || ''));
  const pending = queue.filter(r => outgoing(r) && !r.limitSwitch);
  const sent = delegates.filter(r => r.action === 'delegate' && outgoing(r));
  const unique = [...new Map([...pending, ...sent].map(r => [r.id || `${r.ai}:${r.model}:${r.title}`, r])).values()];
  let taskText = null; try { taskText = fs.readFileSync(path.join(pdir, '.ai', 'tasks', `${task}.md`), 'utf8'); } catch { /* 要確認 */ }
  const steps = taskText?.match(/^## (?:手順|步驟)\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim();
  const memo = taskText?.match(/^## (?:メモ|備註)\n+([^\n]+)/m)?.[1]?.slice(0, 200);
  const statusLines = now.status?.split('\n').filter(Boolean) || [];
  const unchanged = tools?.length === 0 && safeHead && now.head === user.head && now.status === '' && user.status === '' && unique.length === 0;
  const gitInfo = !safeHead || !now.head || now.status === null ? lt('Git：確認できない：実物を確かめる') : lt`Git：開始 ${user.head} → 今 ${now.head}
HEAD変化：${user.head === now.head ? lt('なし') : lt('あり')}
${changes ? clip(changes.split('\n').slice(0, 10).map(line => clip(line, 100)).join('\n'), 180) + '\n' : ''}未保存：${now.status === '' ? lt('なし') : lt`${statusLines.length}行\n` + clip(statusLines.slice(0, 20).map(line => clip(line, 100)).join('\n'), 180)}
詳細はgit log / git statusで確認`;
  const taskRef = clip(`台帳/.ai/tasks/${task}.md`, 180);
  const delegateInfo = unique.length ? lt`送った委任：${unique.length}件（同じ委任を送り直さない）：\n` + clip(unique.map(r => `${clip(r.title || r.shown?.split('\n')[0] || r.id, 70)}／${clip(r.ai, 20)}／${clip(r.model, 40)}`).join('\n'), 350) + lt('\n全件は順番待ちと台帳の操作記録で確認') : lt('送った委任：なし');
  const base = [intro, gitInfo, delegateInfo,
    lt`手順：\n${steps ? clip(steps, 450) : lt('確認できない')}\n残りの手順・続きは ${taskRef} の「手順」を確認`, memo ? lt`最新メモ：${memo}` : '',
    unchanged ? lt('前の番は何もしていない。最初から始めてよい。') : lt('上の操作は済んでいる可能性がある。実物を確かめてから残りを続ける。')].filter(Boolean);
  let list = (tools || []).slice(-15).map(r => clip(r.text, 120));
  const summary = () => tools === null ? lt('道具：記録を確認できない') : lt`道具：${tools.length}件${tools.length ? '\n' + list.join('\n') : lt('（操作なし）')}`;
  let body;
  // 各重要欄は独立予算。古い道具の詳細だけを外し、判断・委任・参照先を切らない。
  do { body = [...base.slice(0, 1), summary(), ...base.slice(1)].join('\n'); if (body.length <= 2490 || !list.length) break; list.shift(); } while (true);
  return lt`${body}\n\n元の依頼：\n${original}`;
}
module.exports = { snapshot, buildHandoffCard };
