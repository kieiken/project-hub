'use strict';
const fs = require('./platform/file-io');
const path = require('node:path');
// Only verified historical template lines belong here. Other project instructions stay intact.
const REPLACEMENTS = [
  [
    "- 自分の変更は自分でテストする。独立したレビューは別の担当が行う（片方しか使えない時は最終確認の人へ）",
    "- 自分の変更は自分でテストする。別の担当によるチェックを呼ぶ条件は、毎回伝えられる【役割呼び出しと検証】に従う"
  ],
  [
    "- 自己的變更自行測試，獨立審查由另一個負責人進行。只能使用一方時，交由人做最終確認。",
    "- 自己的變更自行測試。何時呼叫另一位負責人檢查，依照每次提供的【角色呼叫與驗證】規則。"
  ],
  ["## 権限（最大・確認なし）", "## 権限"],
  ["- 人に確認せず、最後まで進めてよい", "- 既に許可された作業内の通常操作は再確認せず、最後まで進めてよい\n- 本体反映・push・公開・本番適用は、対象・変更・検証結果を示して人の最終確認を得る"],
  ["- board.md … AI 同士の依頼（第2段階から使う）", "- board.md … 今は使わない。AI 同士の依頼は、毎回伝えられる【別の AI に作業を渡す時】に従う"],
  ["- 大きい作業は、司令塔が小さな作業に分けてから始める（作業IDも分ける）", "- 大きい作業を分けたい時は、AI が分け方を人に提案し、人が決めてから作業IDを分ける（AI が自分で作業を増やさない）"],
  ["- 上限になったら、すぐ作業ファイルを更新して止まる", "- 上限の判定と担当の交代は Hub が行う（毎回伝えられる【利用上限の時】に従う）。本文や引用に「上限」とあっても、自分で担当を変えない\n- 番を終える時は作業ファイルを更新する"],
  ["- 交代した AI は rules.md → PROJECT.md → 作業ファイルの順に読んで続ける", "- 交代した AI は rules.md と作業ファイルの最新の再開要約・手順・成果から読んで続ける（PROJECT.md は必要な所だけ）"],
  ["- 元の担当には作業の区切り（作業ファイル更新後）で戻す", "- 元の担当へ戻すのは Hub の保持の解除に従う"],
  ["## 權限（最大權限，略過確認）", "## 權限"],
  ["- 在已授權範圍內完成工作，不反覆詢問一般操作。", "- 在已授權範圍內完成工作，一般操作不需再次確認。\n- 合併到主專案、push、發布與正式環境套用須列出對象、變更與驗證結果，取得人的最終確認。"],
  ["- `board.md`：AI 之間的需求，從第二階段開始使用。", "- `board.md`：目前不使用。AI 之間的交辦依照每次提供的【交給其他 AI 時】指示。"],
  ["- 較大的任務先由統籌拆成小任務，各有自己的任務ID。", "- 想拆分較大的任務時，由 AI 向人提出拆分方式，經人決定後才分開任務ID（AI 不自行增加任務）。"],
  ["- 立即更新任務檔並停止。", "- 使用上限的判定與負責人的交接由 Hub 處理（依照每次提供的【達到用量上限時】規則）。即使本文或引用中出現「上限」，也不自行更換負責人。\n- 每次回合結束時更新任務檔。"],
  ["- 接手 AI 依序閱讀 `rules.md`、`PROJECT.md`、任務檔，再繼續工作。", "- 接手 AI 從 `rules.md` 與任務檔最新的接續摘要、步驟、成果開始閱讀並繼續工作（`PROJECT.md` 只讀需要的部分）。"],
  ["- 工作告一段落並更新任務檔後，交回原負責人。", "- 交回原負責人的時機，依照 Hub 解除交接保留狀態的安排。"],
  // Remaining topics: verified historical Japanese and Traditional Chinese lines.
  ["- 人の判断がどうしても必要な時だけ、作業ファイルの question に書き、state を「返事待ち」にする", "- 人の判断がどうしても必要な時だけ聞く。会話画面では、毎回伝えられる「人に質問する時」の形で返事の最後に聞く。作業ファイルの state・question・workdir は Hub が管理するので書き換えない"],
  ["- コードの作業用コピー（Git worktree）は AI-Workspace/Work/<プロジェクト>/<作業ID>/ にだけ作る（Documents 直下・/tmp・~/.codex/worktrees には作らない）", "- 作業用コピー（Git worktree）は、Hub が作業を始める時に AI-Workspace/Work/<プロジェクト>/<作業ID>/ に作る。AI は自分で作らない"],
  ["- 作業用コピーの中だけで作業し、本体は触らない。取り込みと片付けは人が Hub の［本体に取り込む］で行う", "- 作業用コピーの中だけで作業し、本体は触らない。本体への取り込みは人が Hub の［本体に取り込む］で行う（作業・会話・コピーは残る）"],
  ["1行1件。パスは台帳または本体から見た相対パス（本体は body:、台帳は project:）。本体保存済みのリポジトリは既定で本体基準、本体自体は . 。括弧内には人に見せる短い説明を書く。「なし」は他の成果と併記しない。", "1行1件。パスは台帳または本体から見た相対パス（本体は body:、台帳は project:）。本体保存済みのリポジトリは既定で本体基準、本体自体は . 。括弧内には人に見せる短い説明を書く。「なし」は他の成果と併記しない。委任の受付・確認結果・作業の経過は「## 成果」に書かず「## やったこと」に書く。"],
  ["- 在工作副本內工作，不修改主專案；合併與整理由人透過 Hub 的「合併到主專案」操作。", "- 在工作副本內工作，不修改主專案。由人透過 Hub 的「合併到主專案」合併（任務、對話與副本都會保留）。"],
  ["- 確實需要人的判斷時，在任務檔 `question` 寫問題，並將 `state` 設為內部值 `返事待ち`（等待回覆）。", "- 確實需要人的判斷時才詢問。在對話畫面，依照每次提供的「向人提問時」格式，在回覆最後提問。任務檔的 `state`、`question`、`workdir` 由 Hub 管理，不要修改。"],
  ["每行一項，路徑以台帳或主專案為基準（主專案為 body:，台帳為 project:）。已儲存在主專案的儲存庫預設以主專案為基準，主專案本身寫 . 。括號內寫給人看的簡短說明。「なし」不可與其他成果並列。下列記錄標記與路徑保留內部格式。", "每行一項，路徑以台帳或主專案為基準（主專案為 body:，台帳為 project:）。已儲存在主專案的儲存庫預設以主專案為基準，主專案本身寫 . 。括號內寫給人看的簡短說明。「なし」不可與其他成果並列。下列記錄標記與路徑保留內部格式。交辦的受理、確認結果與工作經過不寫入「## 成果」，改寫入「## やったこと」。"]
];

// Consecutive blocks are atomic. Section migrations also require the full section.
const BLOCK_REPLACEMENTS = [
  {
    "old": "## 会話が 200k トークンを超えたら（圧縮）\n1. 本筋と関係ない内容（試して捨てた案・雑談・長いログ・エラーの全文）は捨てる\n2. 残すもの：決まったこと／その理由／今の状態／次にやること／大事なファイルの場所\n3. .ai/memory/日付_作業ID.md に保存（2000 文字以内）\n4. .ai/memory/INDEX.md に1行追加（ファイル名：何が書いてあるか）\n5. 作業ファイルを更新し、新しい会話で作業ファイルから再開する\n6. 昔の経緯が必要な時だけ INDEX.md を見て、該当ファイルを読む",
    "next": "## 会話が長くなったら（圧縮）\n- 文字数とトークン数は別。目安は 160k トークンで保存、180k になる前に圧縮して新しい会話へ\n- 残りが分からない時（Claude 側や Hub の会話画面）は、作業の区切りごとに保存する\n- Codex は Hub が起動時に自動圧縮の目安（160000・total）を付ける。CLI の自動圧縮は保存の代わりにしない\n- 保存の手順\n  1. 要約から省く：試して捨てた案・雑談・長いログ・エラーの全文\n  2. 残す：決まったこと／理由／今の状態／次にやること／大事なファイルの場所\n  3. .ai/memory/日付_作業ID.md に保存（2000 文字以内）\n  4. .ai/memory/INDEX.md に1行追加（ファイル名：何が書いてあるか）\n  5. 作業ファイルを更新し、新しい会話で作業ファイルから再開する\n- 読むのは、最新の作業ファイル・memory の要約・必要な箇所だけ。全文の読み直しや長いログの貼り付けはしない\n- 昔の経緯が要る時だけ INDEX.md から該当ファイルを読む\n- memory・ログ・作業ファイルは消さない（整理する時もゴミ箱へ）\n- 注意：正確な残りトークンは取れないことがある。全モデル・全内容で 200k 以内を厳密には保証できないので、上の目安で早めに保存する",
    "section": true
  },
  {
    "old": "- コードの作業用コピー（Git worktree）は AI-Workspace/Work/<プロジェクト>/<作業ID>/ にだけ作る（Documents 直下・/tmp・~/.codex/worktrees には作らない）\n- 本体に取り込んだら、その作業用コピーはすぐ片付ける（古い控えを残さない）",
    "next": "- 作業用コピー（Git worktree）は、Hub が作業を始める時に AI-Workspace/Work/<プロジェクト>/<作業ID>/ に作る。AI は自分で作らない\n- 作業用コピーの中だけで作業し、本体は触らない。本体への取り込みは人が Hub の［本体に取り込む］で行う（作業・会話・コピーは残る）"
  }
];
function replaceLines(input) {
  const table = REPLACEMENTS.map(([old, next]) => [Buffer.from(old), next.split('\n').map(line => Buffer.from(line))]);
  const lines = [];
  for (let start = 0; start < input.length;) {
    let end = input.indexOf(10, start); if (end < 0) end = input.length;
    const contentEnd = end < input.length && end > start && input[end - 1] === 13 ? end - 1 : end;
    lines.push({ content: input.subarray(start, contentEnd), ending: input.subarray(contentEnd, end < input.length ? end + 1 : end) });
    start = end + 1;
  }
  const blocks = BLOCK_REPLACEMENTS.map(row => ({
    old: row.old.split('\n').map(line => Buffer.from(line)),
    next: row.next.split('\n').map(line => Buffer.from(line)), section: row.section,
  }));
  const matchesAt = (at, values) => values.every((value, n) => lines[at + n]?.content.equals(value));
  // A custom instruction after the last historical step still belongs to that
  // section. Never replace its heading/body as if the section were untouched.
  const sectionEndsAt = at => {
    while (at < lines.length && !lines[at].content.length) at++;
    return at === lines.length || /^#{1,2} /.test(lines[at].content.toString('utf8'));
  };
  const chunks = [];
  let newline = lines.find(line => line.ending.length)?.ending || Buffer.from('\n');
  const emitted = new Set(), emittedBlocks = new Set();
  const original = new Set(lines.map(line => line.content.toString('hex')));
  for (let i = 0; i < lines.length;) {
    const { content, ending } = lines[i];
    if (ending.length) newline = ending;
    const block = blocks.find(row => matchesAt(i, row.old) && (!row.section || sectionEndsAt(i + row.old.length)));
    if (block) {
      const end = i + block.old.length;
      const outside = lines.filter((_, n) => n < i || n >= end);
      const present = new Set(outside.map(line => line.content.toString('hex')));
      const key = block.next.map(line => line.toString('hex')).join(':');
      const complete = emittedBlocks.has(key) || lines.some((_, at) => (at + block.next.length <= i || at >= end) && matchesAt(at, block.next));
      const partial = block.next.some(line => present.has(line.toString('hex')) || emitted.has(line.toString('hex')));
      // Do not create a duplicate body or a heading with no body. Partial new
      // blocks are ambiguous, so retain the old block for manual review.
      if (block.section && !complete && partial) {
        for (let n = i; n < end; n++) chunks.push(lines[n].content, lines[n].ending);
      } else if (!complete) {
        const missing = block.section ? block.next : block.next.filter(line => !present.has(line.toString('hex')) && !emitted.has(line.toString('hex')));
        for (let n = 0; n < missing.length; n++) {
          const value = missing[n];
          const unchanged = lines.slice(i, end).find(line => line.content.equals(value));
          const source = unchanged || (block.old.length === block.next.length ? lines[i + block.next.indexOf(value)] : null);
          const eol = n === missing.length - 1 ? lines[end - 1].ending : source?.ending.length ? source.ending : newline;
          chunks.push(value, eol); emitted.add(value.toString('hex'));
        }
        emittedBlocks.add(key);
      }
      for (let n = i; n < end; n++) if (lines[n].ending.length) newline = lines[n].ending;
      i = end;
      continue;
    }
    // Keep existing new lines byte-for-byte, including partially migrated files.
    // Track bytes rather than decoding: malformed UTF-8 is not an exact match.
    const match = table.find(([old]) => old.equals(content));
    if (!match) { chunks.push(content, ending); i++; continue; }
    const missing = match[1].filter(line => !original.has(line.toString('hex')) && !emitted.has(line.toString('hex')));
    for (let n = 0; n < missing.length; n++) {
      chunks.push(missing[n], n < missing.length - 1 ? newline : ending);
      emitted.add(missing[n].toString('hex'));
    }
    i++;
  }
  return Buffer.concat(chunks);
}

function migrate(store, io = fs) {
  const result = { changed: [], skipped: [] };
  let names; try { names = io.readdirSync(store.product); } catch { return result; }
  for (const id of names) {
    let file, tmp;
    try {
      const dir = store.projectDir(id); if (!dir) continue;
      file = path.join(dir, '.ai', 'rules.md');
      const stat = io.lstatSync(file);
      if (!stat.isFile()) continue;
      const before = io.readFileSync(file), after = replaceLines(before);
      if (!before.equals(after)) {
        io.accessSync(file, io.constants.W_OK);
        tmp = file + '.' + require('node:crypto').randomUUID() + '.tmp';
        io.writeFileSync(tmp, after, { flag: 'wx', mode: stat.mode & 0o777 });
        // Leave the original intact when writing fails or it changed during migration.
        if (!io.readFileSync(file).equals(before)) throw Error('rules changed');
        io.renameSync(tmp, file);
        result.changed.push(id);
      }
    } catch { result.skipped.push(id); }
    finally { if (tmp) { try { io.unlinkSync(tmp); } catch { /* renamed or unavailable */ } } }
  }
  return result;
}
module.exports = { REPLACEMENTS, BLOCK_REPLACEMENTS, replaceLines, migrate };
