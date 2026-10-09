'use strict';
// Presentation only: stored Japanese state IDs, option values and user content stay intact.
(() => {
  const pairs = `
プロジェクト|專案
プロジェクト名|專案名稱
新しいプロジェクト|新增專案
プロジェクトを作る|建立專案
子プロジェクトを作る|建立子專案
同じ階層に分岐|在同一層建立分支
あなたの番|等待你處理
あなた|你
利用状況|使用情況
AIの利用状況|AI 使用情況
設定|設定
返事待ち|等待回覆
完了確認|完成確認
完了|已完成
未着手|尚未開始
実行中|執行中
進行中|進行中
停止|停止
上限で停止|因額度上限暫停
作業中|工作中
作業|工作
作業名|工作名稱
作業一覧|工作清單
概要|總覽
会話|對話
ターミナル|終端機
新しい作業|新增工作
作業を作る|建立工作
作業を追加|新增工作
追加|新增
削除|刪除
保存|儲存
閉じる|關閉
取り消す|取消
キャンセル|取消
戻る|返回
名前|名稱
説明|說明
担当|負責者
モデル|模型
思考|思考強度
役割|角色
役割分担|角色分工
司令塔|協調者
調査|研究
デザイン|設計
画像生成|圖片生成
コーディング|程式開發
チェック|檢查
文章|文字撰寫
最終確認|最後確認
人|人工
中|中
高|高
極高|極高
状態|狀態
手順|步驟
フェーズ|階段
本体|主專案
台帳|專案紀錄
フォルダ|資料夾
ファイル|檔案
成果物|成果檔案
成果|成果
資料|資料
参考|參考
関連|相關
確認|確認
コピー|複製
コピーしました|已複製
✓ コピーしました|✓ 已複製
選ぶ…|選擇…
選ぶ|選擇
開く|開啟
外す|移除
送る|傳送
送信|傳送
始める|開始
▶ 始める|▶ 開始
止める|停止
続ける|繼續
再開|繼續
更新|更新
更新する|更新
再読み込み|重新載入
読み込み中…|載入中…
読み込み中|載入中
取得中…|取得中…
確認中…|確認中…
整理と確認|整理與檢查
整理と検証|整理與驗證
今の状況を確認|檢查目前狀態
情報と操作を開く|開啟資訊與操作
利用状況を閉じる|關閉使用情況
整理と検証を閉じる|關閉整理與驗證
プロジェクトと作業|專案與工作
プロジェクトの一覧を出す・しまう|顯示或收起專案清單
変更の記録を見る|查看更新紀錄
利用枠の使用率とリセット時期を見る|查看額度使用比例與重設時間
契約の利用枠に対する使用率です。トークン数や、この会話の長さとは別です。|這裡顯示方案額度的使用比例，並非 token 數或目前對話長度。
通常は5分ごとに取得します。日時はこの端末の時刻です。取得に失敗した場合は、自動で繰り返さず［今の状況を確認］から再確認できます。|通常每 5 分鐘取得一次，時間依本機時區顯示。若取得失敗，可按「檢查目前狀態」重試。
説明（何を作るか・誰のためか。1〜2行）|說明（要做什麼、提供給誰，1～2 行）
フェーズ（1行に1つ。順番どおり）|階段（依序填寫，每行一個）
くわしく（なくてもよい）|詳細設定（選填）
本体のフォルダ（もうコードや資料がある時）|主專案資料夾（已有程式碼或資料時選擇）
親プロジェクト（小分けにする時）|上層專案（需要分組時選擇）
（なし）|（無）
なし|無
ここにフォルダを落とす、または［選ぶ］|將資料夾拖到這裡，或按「選擇」
ここに落とす、または［選ぶ］|拖曳到這裡，或按「選擇」
例：HD 占いアプリ|例如：活動報名系統
例：台湾向けの投稿を3本作る|例如：撰寫三篇面向台灣讀者的貼文
参考にするフォルダ・ファイル（Hub の外。AI は読むだけで書き換えない。何個でも）|參考資料夾與檔案（Hub 外部資料，AI 僅讀取，可選多個）
関連プロジェクト（Hub の他のプロジェクト。AI がその資料を読んでよい）|相關專案（允許 AI 讀取其他 Hub 專案的資料）
ブラウザのチャット|瀏覽器對話
本作業|主要工作
派生|衍生工作
派生元|來源工作
作業用コピー|工作副本
本体で作業|在主專案工作
場所は開始時に決定|開始時決定工作位置
本体に取り込む|合併到主專案
取り込み|合併
取り込み済み|已合併
子作業|子工作
子プロジェクト|子專案
名前を変える|重新命名
改名|重新命名
分岐|分支
送らずに消す|清除而不傳送
返事が必要なものはありません。|目前沒有需要回覆的項目。
完了に移すものはありません。|目前沒有待確認完成的項目。
AI が終わったと言っている作業。中身を見て、完了に移すか続けるかを決めます|AI 回報已完成的工作。查看成果後，決定確認完成或繼續。
返事待ち・上限で止まっている作業と、AI が入力や選択を待っている作業|等待回覆、額度用盡暫停，以及 AI 等待輸入或選擇的工作。
［送らずに消す］は質問と返事待ちの表示だけを消します。AI には送らず、続きを始めません。|「清除而不傳送」只清除提問與等待回覆標記，不會傳送給 AI 或繼續執行。
ブラウザで開く|在瀏覽器開啟
ファイル・フォルダの開き方を選ぶ|選擇開啟檔案或資料夾的方式
テキスト|文字
書きかけ|尚未完成
Hub に戻す|帶回 Hub
戻して Codex に続けさせる|帶回並交由 Codex 繼續
ChatGPT の返事をコピーしました|已複製 ChatGPT 的回覆
フォルダの開き方を選んでください。|請選擇資料夾的開啟方式。
コピーを作らず、元のファイルを既定のアプリで開けます。|使用預設應用程式開啟原始檔案。
台帳が見つかりません|找不到專案紀錄
新規|新增
すべて|全部
全て|全部
完了を表示|顯示已完成
完了を隠す|隱藏已完成
質問|問題
回答|回答
依頼|指示
指示|指示
次の指示|下一個指示
追加説明|補充說明
画像を追加|新增圖片
画像|圖片
画像を選ぶ|選擇圖片
下書き|草稿
詳細|詳細資訊
履歴|歷程
ログ|紀錄
エラー|錯誤
成功|成功
失敗|失敗
未設定|尚未設定
設定済み|已設定
利用枠|使用額度
残り|剩餘
リセット|重設
週間枠|每週額度
5時間枠|5 小時額度
週間枠（OAuthアプリ）|每週額度（OAuth 應用程式）
モデル別|依模型
上限|上限
不明|未知
未取得|尚未取得
再取得|重新取得
接続|連線
接続済み|已連線
未接続|尚未連線
有効|啟用
無効|停用
オン|開啟
オフ|關閉
外から使う|遠端使用
合言葉|通行密碼
ログイン|登入
ログアウト|登出
サンプル担当|範例負責者
サンプルアプリ|範例應用程式
サンプルサイト|範例網站
サンプル文書|範例文件
計画|規劃
作る|製作
仕上げ|完成整理
主担当|主要負責者
交代候補|備援負責者
反映|套用
適用|套用
権限|權限
承認|核准
確認する|確認
元に戻す|還原
並べ替え|排序
上へ|上移
下へ|下移
移動|移動
最新|最新
インストール済み|已安裝
見つかりません|找不到
準備中|準備中
実行|執行
検証|驗證
プレビュー|預覽
変更|變更
変更なし|沒有變更
差分|變更差異
終了|結束
再起動|重新啟動
取り込む|合併
片付け|清理
待機中|等待中
順番待ち|排隊中
通知|通知
成果を受け取る|接收成果
受け取る|接收
要確認|需要確認
メモ|備註
場所|位置
目的|目的
進み具合|進度
読み取り専用|唯讀
確認なし|不需確認
最大・確認なし|最高權限，不需確認
保存しました|已儲存
保存できませんでした|無法儲存
コピーできませんでした|無法複製
AI に頼む|交給 AI
手動|手動
自動|自動
キャンセルしました|已取消
実作業もできる|允許實際操作
日本語|日文
問題点|問題與待辦
最終更新|最後更新
フェーズ|階段
モデル：役割どおり|模型：依角色設定
フェーズ：今のフェーズ|階段：目前階段
+ 新規プロジェクト|＋ 新增專案
始めるAI|執行的 AI
名前の変更・分岐・子を作成|重新命名、建立分支或子專案
利用状況。利用枠の使用率とリセット時期を見る|使用情況：查看額度比例與重設時間
ZXQ0QXZ に「ZXQ1QXZ」を送りました|已將「ZXQ1QXZ」傳送給 ZXQ0QXZ
フェーズ ZXQ0QXZ|階段 ZXQ0QXZ
画像はここに落とす・Ctrl+V・📎で追加（最大10枚）。入力内容はプロジェクトごとに保存します。|拖曳圖片到這裡，或使用 Ctrl+V／📎 新增（最多 10 張）。輸入內容會依專案儲存。
サンプル担当（Discord）|範例負責者（Discord）
計画・割り振り・進み具合|規劃、分工與進度追蹤
情報集め・要約|蒐集資料與摘要
画面・構成・見た目|介面、結構與視覺設計
画像を作る|製作圖片
プログラムを書く|撰寫程式
独立レビュー（本人のテストは必須）|獨立審查（開發者仍須自行測試）
説明文・マニュアル|說明文字與操作手冊
完成の判断|判定是否完成
いつもの担当|主要負責者
現在版：|目前版本：
導入方法：|安裝方式：
確認できません|無法確認
未導入|尚未安裝
組織を読み込む|載入組織
作業画面|工作介面
AI の更新|AI 工具更新
新しく始めるときのAI|新工作預設使用的 AI
（先に合言葉を保存してください）|（請先儲存通行密碼）
`;
  const dictionary = { ...(window.hubTranslations || {}), ...Object.fromEntries(pairs.trim().split('\n').map(line => { const i = line.indexOf('|'); return [line.slice(0, i), line.slice(i + 1)]; })) };
  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const templates = Object.entries(dictionary).filter(([key]) => /[\u3041-\u309f\u30a1-\u30fa]/.test(key) && /ZXQ\d+QXZ/.test(key) && (key.match(/ZXQ\d+QXZ/g) || []).length <= 3).map(([key, value]) => {
    const ids = key.match(/ZXQ\d+QXZ/g);
    const regex = new RegExp('^' + key.split(/ZXQ\d+QXZ/).map(escapeRegex).join('([\\s\\S]*?)') + '$');
    return { regex, value, ids };
  });
  const skip = 'script,style,textarea,pre,code,.mb,.msg-body,.message-body,.chat-text,.rich-text,.codeblock,.issue-original,.xterm,[contenteditable="true"],[data-no-translate]';
  const localizedNodes = new WeakMap();
  function translate(text) {
    const core = text.trim();
    if (dictionary[core]) return text.replace(core, dictionary[core]);
    if (/^現在版：.* 導入方法：/.test(core)) return text.replace('現在版：', '目前版本：').replace('導入方法：', '安裝方式：').replaceAll('確認できません', '無法確認').replace('未導入', '尚未安裝');
    if (/^最終更新 [\d-]+$/.test(core)) return text.replace('最終更新', '最後更新');
    if (/^(?:未着手|進行中|完了|完了報告あり・確認待ち)・作業 \d+ \/ \d+$/.test(core)) {
      return text.replace(/未着手|進行中|完了報告あり・確認待ち|完了|作業/g, word => ({ 未着手: '尚未開始', 進行中: '進行中', 完了: '已完成', '完了報告あり・確認待ち': '已回報完成，等待確認', 作業: '工作' }[word]));
    }
    if (/^\d+(?:\.\d+)?秒$/.test(core)) return text.replace(core, core.replace('秒', ' 秒'));
    if (/^\d+分(?:\d+秒)?$/.test(core)) return text.replace(core, core.replace('分', ' 分鐘 ').replace('秒', ' 秒').trim());
    if (core.length > 2000) return text;
    for (const template of templates) {
      const found = core.match(template.regex);
      if (found) return text.replace(core, template.value.replace(/ZXQ\d+QXZ/g, id => found[template.ids.indexOf(id) + 1]));
    }
    // Only whole labels with counters; never replace arbitrary user sentences.
    const match = core.match(/^(返事待ち|完了確認|作業中|完了|プロジェクト|作業|残り|週間枠|5時間枠)([\s（(：:]\s*[\d.,% /・）)]+)$/);
    return match ? text.replace(core, dictionary[match[1]] + match[2]) : text;
  }
  function localize(root) {
    if (root.nodeType === 3) {
      if (!root.parentElement?.closest(skip)) {
        if (localizedNodes.get(root) === root.nodeValue) return;
        const parent = root.parentElement;
        if (parent?.tagName === 'OPTION' && !parent.hasAttribute('value')) parent.setAttribute('value', parent.textContent);
        const next = translate(root.nodeValue);
        if (next !== root.nodeValue) root.nodeValue = next;
        localizedNodes.set(root, next);
      }
      return;
    }
    if (root.nodeType !== 1 || root.matches(skip)) return;
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      if (root.hasAttribute(attr)) { const old = root.getAttribute(attr), value = translate(old); if (old !== value) root.setAttribute(attr, value); }
    }
    for (const child of root.childNodes) localize(child);
  }
  document.documentElement.lang = 'zh-Hant-TW';
  document.title = 'Project Hub｜專案中心';
  localize(document.body);
  const observeOptions = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'] };
  const observer = new MutationObserver(records => {
    observer.disconnect();
    try {
      for (const record of records) {
        if (record.type === 'childList') for (const node of record.addedNodes) localize(node);
        else localize(record.target);
      }
    } finally { observer.observe(document.body, observeOptions); }
  });
  observer.observe(document.body, observeOptions);
  window.hubTranslate = translate;
  for (const name of ['alert', 'confirm', 'prompt']) {
    const original = window[name].bind(window);
    window[name] = (message, ...rest) => original(translate(String(message)), ...rest);
  }
})();
