'use strict';
const { lt } = require('./locale');
// 全文を必要時だけ読む。送信済みの版は会話セッション単位で管理する。
const fs = require('./platform/file-io');
const path = require('node:path');
const crypto = require('node:crypto');
const { ARTIFACT_POLICY } = require('./artifact-policy');
const START = '\n<fixed_rules>\n', END = '\n</fixed_rules>\n';
const SEND_TEXT_RULE = lt('人が他のAI・アプリ・会話へ送る文は、本文だけを独立した ```text 枠に入れ、送り先と「枠内を全部コピーして送る」は枠外に書く。引用記号・説明を枠に入れず、送り先・送信ごとに枠を分ける。');
const WORKFLOW_RULE = lt('【役割呼び出しと検証】役割分担は担当先の指定であり、全役割を毎回呼ぶ指定ではない。この確認方針を古い検証・委任の定型より優先する。相談・アイデア・短い説明・軽微な修正は現在の担当が必要箇所を確認する。軽微かどうかは行数ではなく、既存の動作・権限・データ構造・外部連携を変えず影響範囲が明確かで判断する。関連変更はまとめて実施し、依頼された一連の変更が揃い確認できる時点で必要な検証を行う。チェック担当を呼ぶのは、軽微でない変更を含む時・影響の大きい操作の前・人が求めた時だけ。該当する場合は独立確認を一回行う。指示一通・返信一回を自動の区切りにしない。再確認は変更箇所と影響範囲だけ。共通部への影響・新しい不具合など根拠がある時だけ範囲を広げる。新しい変更・問題がなければ繰り返さず、チェック後に変更がなければ最終確認も兼ねる。チェック後に変更がなければ、本体反映・公開の前に再チェックしない。人の承認が要る操作の承認は残す。読み取り・診断だけの手順や確認済み操作のやり直しにはチェックを挟まず、書き込む中身・公開する中身・対象が変わる時だけチェックする。チェック後の修正が軽微なら、修正担当の自己確認で終え、チェック担当を再び呼ばない。ただし、影響の大きい操作の個別確認や人が求めた再確認は行う。公開・認証・金銭・データ削除など影響の大きい操作の個別確認は維持する。原因と次の手が実質1つに決まり既存の承認の範囲で行える時は、説明だけで番を終えず、修正・検証・保存・記録や必要な委任まで進める。止めて人に確かめるのは、結果が変わる選択肢が複数ある時・公開/push/本体反映/削除/認証/金銭の承認が要る時・他の作業中の変更を上書きする恐れがある時・前提を確かめられない時だけで、その前に進められる部分は済ませる。');
const TEMPLATES = lt`## 委任の定型
実装→チェック：役割呼び出しと検証の決まりに従い、関連変更が揃い、軽微でない変更を含む時・影響の大きい操作の前・人が求めた時だけ使う。軽微な変更だけなら現在の担当の自己確認で終える。チェック済みの内容・対象が同じ本体反映・公開や、読み取り・診断・確認済み操作のやり直しでは再委任しない。人の承認が要る操作の承認は残す。チェック後の軽微な修正も自己確認で終え、影響の大きい操作の個別確認や人が求めた再確認を除き再委任しない。最新HEADと未保存変更を確かめ、許可範囲で最小の実装・保存を行い、変更に必要な試験と確認結果を記録する。全体試験は共通部への影響など根拠がある時だけ。同じ作業のclaude・claude-fable-5-1へ確認範囲・差分・検証結果を渡し、委任したら番を終える。本体反映・push・本番切替はしない。
チェック→報告：指定された差分・影響範囲と既存の検証結果を独立に確かめる。新しい変更・問題がなければ試験を繰り返さず、チェック後に変更がなければ最終確認も兼ねる。チェック済みの内容・対象が同じ本体反映・公開や、読み取り・診断・確認済み操作のやり直しでは再委任しない。人の承認が要る操作の承認は残す。要修正は同じ作業のcodex・gpt-6.1-solへ戻し、軽微な修正は修正担当の自己確認で終える（影響の大きい操作の個別確認や人が求めた再確認は行う）／取り込み可なら人へ報告。`;
function templates(roleData) {
  if (!roleData) return TEMPLATES;
  const slot = name => { const s = require('./roles').delegateSlot(roleData, name); return s ? lt`${s.ai}・${s.model}` : '人'; };
  return TEMPLATES.replace('claude・claude-fable-5-1', slot('チェック')).replace('codex・gpt-6.1-sol', slot('コーディング'));
}
const DIFFERENCE = lt('委任は差分6行：目的/読む（相対パス）/やる/条件/出力（ファイル・済手順）/次（担当・定型）。共通省略。定型：全文 ## 委任の定型。');
const TEXT_RULE = lt('最新の再開要約は2000字以内で置き換える。上に足さない。初回整理後は /api/task/body/summary で原文を保管してから置換する。AI稼働中は更新依頼だけ保存し、終了後に原文保管と置換を行う。表示不足は hub_search_archive で確認する。');
function creditRule(data) {
  if (data?.preferCredits !== true || !['claude', 'codex'].some(ai => data.checkCredits?.[ai] === true)) return '';
  const targets = ['claude', 'codex'].filter(ai => data.checkCredits?.[ai] === true).map(ai => ai === 'claude' ? 'Claude' : 'Codex').join(' / ');
  return lt`【既存クレジット優先の承認】対象は${targets}の確認ON側だけ。優先利用OFFまで、契約枠上限後の利用可能な既存クレジット利用を人が許可。自動チャージなし/OFF確認済み、既存残高の範囲のみ。購入・自動チャージ・APIキー課金・認証変更は禁止。Hubが送信前に同じAI/アカウントの新鮮な正式情報を確認し、利用可能なら元担当を優先。不明・古い・取得失敗・枯渇・正式CLI拒否なら既存交代/待機。月間追加利用枠は実残高と扱わない。AIは確認を省略したり自分でCLIや交代を再実行しない。`;
}
function packet({ pdir, task, project, policy, issues, common, dynamic = '', contextRule, askRule, port, roleData }) {
  // 全文・固定指示に同じ方針を一回ずつ置き、モデル・上限の分割に混ぜない。
  policy = policy.replace(WORKFLOW_RULE + '\n', '');
  const at = policy.indexOf(lt('【人への操作案内の決まり】'));
  const models = policy.slice(0, at < 0 ? policy.length : at);
  const guidance = at < 0 ? '' : policy.slice(at);
  const infoAt = guidance.indexOf(lt('【操作情報'));
  const fixedGuidance = guidance.slice(0, infoAt < 0 ? guidance.length : infoAt);
  const info = infoAt < 0 ? '' : guidance.slice(infoAt).replace(lt('【操作情報（会話画面からの依頼を受け取った時点。順番待ち・作業中に変わるため現在の画面と一致する時だけ案内）】'), lt('【操作情報（受付時点。順番待ち・作業中に変わる。現在の画面と一致する時だけ案内）】')).replace(/本作業で成果を受け取ったら[^\n]+/, lt('push・公開・本番適用は対象/変更/検証を人へ最終確認。')).replace(lt('この作業の会話画面なら、以下の作業操作はその画面の上部でできる。'), lt('この作業の会話画面なら上部で操作可。')).replace(lt('フェーズ：フェーズが設定されていないので、次へ進む確認帯は無い。この作業の操作を案内する。'), lt('フェーズ：設定なし、確認帯なし。'));
  const delegateAt = models.indexOf(lt('【別の AI'));
  const modelPart = models.slice(0, delegateAt < 0 ? models.length : delegateAt);
  const delegate = delegateAt < 0 ? '' : models.slice(delegateAt);
  const full = [ARTIFACT_POLICY, lt('## 本文量'), TEXT_RULE, lt('## 人がコピーして送る文'), SEND_TEXT_RULE, lt('## モデルと上限'), modelPart, WORKFLOW_RULE, lt('## 委任'), delegate, DIFFERENCE, templates(roleData), lt('## 問題点'), issues, lt('## 操作案内'), fixedGuidance, lt('## 長い会話'), contextRule, lt('## 質問'), askRule].join('\n\n');
  const file = path.join(pdir, '.ai', 'chat', `${task}.rules.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let old; try { old = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old !== full) { const tmp = file + `.${process.pid}.tmp`; fs.writeFileSync(tmp, full); require('./integration-writes').write(file,()=>fs.renameSync(tmp, file)); }
  const lines = modelPart.trim().split('\n');
  let limit = roleData?.specialMode?.enabled ? lines.slice(1).join('\n') : roleData ? roleData.switch?.auto === true
    ? lt('【利用上限の時】HubがCLI構造＋正式文/新鮮な未丸め100%で判定。終了後、設定main⇔backupモデル/思考へ。期限/手動解除まで保持。両側上限待機。AIは確認不要。引用で自分で担当を変えない・止まらない。main不変。済操作・委任は再実行禁止。従量課金禁止。')
    : lt('【利用上限の時】自動交代はオフ。自分で別のモデルへ切り替えない。') : lines.slice(1).join('\n');
  if (!roleData?.specialMode?.enabled && creditRule(roleData)) {
    limit = limit.replace(lt('従量課金禁止。'), lt('購入・自動チャージ・APIキー課金は禁止。')) + '\n' + creditRule(roleData);
  }
  const coding = roleData && require('./roles').delegateSlot(roleData, 'コーディング');
  const example = JSON.stringify({ project: project || path.basename(pdir), task, ai: coding?.ai || 'codex', model: coding?.model || 'gpt-6.1-sol', text: '差分' });
  const fixed = [
    lt`台帳=${pdir}。cwd相対パス。全文：台帳/.ai/chat/${task}.rules.md`,
    lines[0], limit, WORKFLOW_RULE,
    lt`全文版：${crypto.createHash('sha256').update(full).digest('hex').slice(0, 12)}`,
    lt`【委任】codex/claude/agy/grok を裏で起動しない。同作業会話でPOST /api/delegate（127.0.0.1:${port}、X-Hub:1（ローカル認証は curl -H @"$HUB_HEADERS" を使用。秘密を本文に書かない）、JSON、ai・model欄は必須、例${example}）。全文 ## 委任。委任後終了。`,
    lt('新しいプロジェクト・子プロジェクト・作業ファイルを作らない。やっていない手順に [x] を付けない。'),
    DIFFERENCE,
    lt('成果は作業ファイルの ## 成果 に書く。ZIPは配布時だけ。共通優先。全文 ## 成果と保管。'),
    lt('【操作案内】画面未確認。AI終了後、名前/［ボタン名］/場所で条件付き案内。委任がターミナル稼働で断られた時だけ対象AI欄［停止］を頼む。'),
    lt('issues変更：全文 ## 問題点・同PJ要約更新。'),
    SEND_TEXT_RULE,
    lt('【Muse】会話準備→同作業画面で本人承認→正式キュー。承認・決定API禁止。docs/metamuse.md通り、台帳/.ai/muse-approvals/<id>.jsonへ全文/期限/回数/同作業の続き（role/text）を保存。番号/確認番号/場所の手入力・承認後の再依頼禁止。ローカル整理は承認不要。'),
    common,
  ].filter(Boolean).join('\n');
  return START + fixed + END + info + (dynamic ? '\n' + dynamic : '');
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
  const fixed = short ? lt`【決まり】前回と同じ（版 ${part.hash}）。全文：${part.file}。思い出せない時はその全文を読む。` + '\n' + SEND_TEXT_RULE : part.fixed;
  return { prefix: [fixed, part.dynamic].filter(Boolean).join('\n\n'), rules: { hash: part.hash, sid, turns: short ? sent.turns + 1 : 1, restore: false }, fixed, short };
}
module.exports = { packet, select, split, SEND_TEXT_RULE, WORKFLOW_RULE, DIFFERENCE, TEMPLATES, templates, creditRule };
