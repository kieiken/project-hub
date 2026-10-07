'use strict';
const { lt } = require('./locale');
// 全文を必要時だけ読む。送信済みの版は会話セッション単位で管理する。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ARTIFACT_POLICY } = require('./artifact-policy');
const START = '\n<fixed_rules>\n', END = '\n</fixed_rules>\n';
const TEMPLATES = lt`## 委任の定型
実装→チェック：最新HEADと未保存変更を確かめる→変更前を保存→最小の実装→関連・全体試験→commit→実施した手順だけ済→同じ作業のclaude・claude-fable-5-1へ独立チェックを委任して番を終える。本体反映・push・本番切替はしない。
チェック→報告：差分と試験を独立に確かめる→要修正は同じ作業のcodex・gpt-6.1-solへ戻す／取り込み可なら人へ報告。`;
function templates(roleData) {
  if (!roleData) return TEMPLATES;
  const slot = name => { const s = require('./roles').delegateSlot(roleData, name); return s ? lt`${s.ai}・${s.model}` : '人'; };
  return TEMPLATES.replace('claude・claude-fable-5-1', slot('チェック')).replace('codex・gpt-6.1-sol', slot('コーディング'));
}
const DIFFERENCE = lt('委任は差分6行：目的／読む（相対パス）／やる／条件／出力（ファイル・済手順）／次（担当・定型）。共通事項は省き、定型指定時に全文の ## 委任の定型 を読む。');
function packet({ pdir, task, project, policy, issues, common, contextRule, askRule, port, roleData }) {
  const at = policy.indexOf(lt('【人への操作案内の決まり】'));
  const models = policy.slice(0, at < 0 ? policy.length : at);
  const guidance = at < 0 ? '' : policy.slice(at);
  const infoAt = guidance.indexOf(lt('【操作情報'));
  const fixedGuidance = guidance.slice(0, infoAt < 0 ? guidance.length : infoAt);
  const info = infoAt < 0 ? '' : guidance.slice(infoAt).replace(lt('【操作情報（会話画面からの依頼を受け取った時点。順番待ち・作業中に変わるため現在の画面と一致する時だけ案内）】'), lt('【操作情報（受付時点。順番待ち・作業中に変わる。現在の画面と一致する時だけ案内）】')).replace(/本作業で成果を受け取ったら[^\n]+/, lt('push・公開・本番適用は対象/変更/検証を人へ最終確認。')).replace(lt('この作業の会話画面なら、以下の作業操作はその画面の上部でできる。'), lt('この作業の会話画面なら上部で操作可。')).replace(lt('フェーズ：フェーズが設定されていないので、次へ進む確認帯は無い。この作業の操作を案内する。'), lt('フェーズ：設定なし、確認帯なし。'));
  const delegateAt = models.indexOf(lt('【別の AI'));
  const modelPart = models.slice(0, delegateAt < 0 ? models.length : delegateAt);
  const delegate = delegateAt < 0 ? '' : models.slice(delegateAt);
  const full = [ARTIFACT_POLICY, lt('## モデルと上限'), modelPart, lt('## 委任'), delegate, DIFFERENCE, templates(roleData), lt('## 問題点'), issues, lt('## 操作案内'), fixedGuidance, lt('## 長い会話'), contextRule, lt('## 質問'), askRule].join('\n\n');
  const file = path.join(pdir, '.ai', 'chat', `${task}.rules.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let old; try { old = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old !== full) { const tmp = file + `.${process.pid}.tmp`; fs.writeFileSync(tmp, full); fs.renameSync(tmp, file); }
  const lines = modelPart.trim().split('\n');
  const limit = /現在は自動交代がオフ|目前自動切換已關閉/.test(modelPart) ? lines.slice(1).join('\n') : lt('【利用上限の時】会話の司令塔・チェックFableだけ、HubがCLIエラー構造＋正式文で判定し終了後Astraへ。保持中は期限/手動解除までAstra開始。AIは確認不要。「上限」・引用で自分で担当を変えない・止まらない。main不変。済んだ部分は繰り返さず残りを続ける。');
  const coding = roleData && require('./roles').delegateSlot(roleData, 'コーディング');
  const ids = JSON.stringify({ project: project || path.basename(pdir), task }).slice(1, -1);
  const fixed = [
    lt`台帳=${pdir}。cwd内は相対パス。全文：台帳/.ai/chat/${task}.rules.md（必要時参照）。`,
    lines[0], limit,
    lt`全文版：${crypto.createHash('sha256').update(full).digest('hex').slice(0, 12)}`,
    lt`【別の AI に作業を渡す時】codex / claude / agy / grok を裏で起動しない。会話でcurl -s -X POST http://127.0.0.1:${port}/api/delegate -H 'X-Hub: 1' -H 'Content-Type: application/json' -d '{${ids},"ai":"${coding?.ai || 'codex'}","model":"${coding?.model || 'gpt-6.1-sol'}","title":"短い名前","text":"差分"}'。ai・model欄は必須。渡したら終了。全文 ## 委任。`,
    lt('新しいプロジェクト・子プロジェクト・作業ファイルを作らない。やっていない手順に [x] を付けない。'),
    DIFFERENCE,
    lt('成果は作業ファイルの ## 成果 に書く。ZIPは配布時だけ。共通で優先。全文の ## 成果と保管。'),
    lt('【操作案内】画面未確認。見える名前・［ボタン名］・場所で条件付き案内、AI終了後。全文 ## 操作案内。委任がターミナル稼働で断られた時だけ作業画面［ターミナル］の対象AI欄［停止］を頼む。'),
    lt('issues変更時は全文 ## 問題点 を読み、同じプロジェクトの要約も更新。'),
    common,
  ].filter(Boolean).join('\n');
  return START + fixed + END + info;
}
function split(prompt) {
  const start = String(prompt || '').indexOf(START), end = String(prompt || '').indexOf(END);
  if (start < 0 || end < start) return null;
  const fixed = prompt.slice(start + START.length, end);
  const rulesHash = crypto.createHash('sha256').update(fixed).digest('hex').slice(0, 12);
  const file = (fixed.match(/(?:全文|完整內容)：(台帳\/[^（\n]+)/) || [])[1] || '';
  return { fixed, dynamic: prompt.slice(0, start) + prompt.slice(end + END.length), hash: rulesHash, file };
}
function select(prompt, { meta, ai, sid, resume, restore = false }) {
  const part = split(prompt);
  if (!part) return { prefix: prompt };
  const sent = meta.rulesSent?.[ai];
  const short = resume && sent?.sid === sid && sent.hash === part.hash && sent.turns < 4 && !sent.restore && !restore;
  const fixed = short ? lt`【決まり】前回と同じ（版 ${part.hash}）。全文：${part.file}。思い出せない時はその全文を読む。` : part.fixed;
  return { prefix: [fixed, part.dynamic].filter(Boolean).join('\n\n'), rules: { hash: part.hash, sid, turns: short ? sent.turns + 1 : 1, restore: false }, fixed, short };
}
module.exports = { packet, select, split, DIFFERENCE, TEMPLATES, templates };
