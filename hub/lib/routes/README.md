# 受付の機能別分割

`createRoutes` に機能群の名前・作成関数・`ctx` を登録します。`ctx` は既存のオブジェクトや関数への参照だけで、受付のために状態を複製しません。登録表・`ctx`・各受付口は固定し、渡されたオブジェクトそのものは凍結しません。

各群は名前付きの受付口（`matches(req, url)` と `handle(req, res, url, body)`）を返します。`server.js` は元の判定位置で一致を調べ、処理結果をそのまま返します。登録順に全経路を走査する仕組みではありません。`send` が値を返さない場合や、非同期処理が失敗した場合も、元の早期終了と例外の伝わり方を保ちます。

共通のリモート接続・Origin・X-Hub・再起動・組立・更新中・読み取り専用・内部依頼偽装などの確認と、共通の本文読み取りはサーバーに残します。言語パックだけは元から早い位置で独自に本文を読むため、その確認と読み取りを一緒に移しています。新しい群を移す時も、確認の前後関係を変えません。

| 群 | 受付口 | 渡すもの |
| --- | --- | --- |
| language | locale / packs | 応答、言語設定、リモート・接続確認、言語パック、既存ROOTとVERSION、本文読取 |
| github | read / write | 応答、既存GitHub操作、Store、製品Gitの選択、監査記録、翻訳 |
| maintenance | write | 応答、既存整理・問題解決、実行権の取得と解除、製品の場所、Store、監査記録、翻訳 |
| onboarding | write | 応答、既存の初期設定、翻訳 |
| usage | read / write | 応答、既存の利用状況と選択・上限表示、アカウント照合、既存PORT、翻訳 |
| remote | read / write / logout | 応答、既存のリモート設定、アドレス取得関数、監査記録 |
| information | background / read | 応答、既存のプロセス一覧、起動版と保存版の取得、変更履歴、セッション一覧、ログ読取 |
| modelinfo | tools / skills / models | 応答、既存の道具の状態とモデル反映、スキル一覧、アカウント、役割と起動設定、モデル案内、加速設定 |
| accounts | read / write | 応答、既存のアカウント・利用状況・道具・モデル反映、セッション・Store・会話保存、起動処理、上限記録、監査、翻訳 |
| musesettings | read / write | 応答、ローカル接続/Origin確認、固定版Museツールの選択・秘密を除いた状態、本人用Terminal起動、操作名だけの監査 |
| hierarchy | remove / organize | 応答、既存の削除・復元と審査、アイデアの退避、通知整理、並び順、Store・セッション・会話、監査 |
| aiupdate | write | 応答、既存のAI更新処理、モデル反映、監査、翻訳 |
| limits | clear / write | 応答、既存のアカウント照合・利用状況・通常の上限解除・上限例外とFable解除、現在の話し合い取得、監査、翻訳 |
| modelsettings | cli / write | 応答、既存のCLI指定・モデル表示設定・役割とモデルの取得、監査、翻訳 |
| acceleration | write | 応答、既存の全体の加速設定、監査 |
| state | read | 既存の表示読取・通知整理・保存HEAD取得、状態表示用の参照、現在の話し合い・再起動制御・復元完了の取得、圧縮応答 |
| start | image / upload / write | 既存Store・画像操作・生データ読取、後から定義される開始関数への呼出し、応答、翻訳 |
| freetalk | status / attachment / ensure / topic / lifecycle / projectStart / history | 既存の話題・添付・履歴・移行処理、モデル初期値、会話の記録と待ち列、未読更新、無料の内部依頼、応答、翻訳 |
| taskbody | preview / archives | 応答、翻訳、既存の本文下見と保管一覧、台帳参照、パス・ファイル読取 |
| taskhistory | continuation / history | 応答、既存の作業履歴・継続状況、現在の自動整理状況の取得関数 |
| taskhistorywrite | auto / cancel / rotate / summary | 既存の整理開始・取消・履歴切替・要約準備、実行権と現在の整理状況、文章担当と無料の内部依頼、応答、翻訳 |
| taskcontinuation | recover / continue | 既存の継続復旧・開始・本文予算、現在の自動整理の呼出し、監査、応答 |
| taskbodywrite | write | 既存の本文反映・復旧・要約、監査、応答 |
| taskintegration | wait / mergeStatus / mergePreview / merge / handupPreview / handup / records / abandon / futureHold / keep / preview / resume / apply / organize / results / resolve | 既存の取り込み・引渡し・結果整理、子を残す将来保留、現在の本体取り込み進行の取得、保存先確認・送信記録・監査・無料の内部依頼 |
| taskattachments | upload / attach | 既存の生データ読取・世代・添付実行権・保存/取消・端末入力、監査、応答 |
| taskmanagement | acceleration / empty / tidy / create | 既存の作業加速設定・空作業整理・作業整理・作成、稼働確認、監査、応答 |
| rolesettings | history / write / defaults / restore | 既存の無料の役割履歴・保存・既定設定・復元と版確認、応答 |
| mcpsettings | tools / read / register / write | 既存の道具・設定・登録、独自の本文読取・内部依頼偽装拒否・移行済み話題の確認、監査、応答 |
| localfiles | view / open / reveal / url / pick | 既存の場所確認・安全なfdと範囲配信・文書表示・OS操作、監査、応答 |
| terminalio | stream / switch / input / resize | 既存セッションのSSE・モデル/思考変更・入力・大きさ、未読更新、監査、応答 |
| chatrecovery | handoff / unfinished | 既存の終了保存復旧・未解決記録の解決、応答 |
| ideaimage | upload | 既存の人の操作確認・画像サイズ検査・保存・送信結果照合、応答 |
| chatread | stream | 既存のStore・会話・待ち列・履歴世代・未読更新・アイデア表示、現在の外部AI進行の取得、応答、翻訳 |
| taskread | steps / preview | 既存Store・手順の版・作業コピー判定・Gitの見通しと対象検査・本体表示、応答、翻訳 |
| tasksettings | update / read | 既存Store・リモート判定・監査・稼働中の会話とセッション・未読更新、応答、翻訳 |
| chatnote | write | 既存Store・話題名更新・会話保存・通知、応答、翻訳 |
| taskprogress | completion / step | 既存の完了承認・成果確認・手順保存と整理、現在の話し合い取得、稼働確認・監査・親への報告、応答、翻訳 |
| taskcopy | clear / exclusion | 既存のコピー欠落・取り込み記録の確認、台帳更新、監査、応答、翻訳 |
| phase | continue / next | 既存の世代照合・稼働確認・フェーズ保存、監査、応答、翻訳 |
| project | notes / github / children / status / handoff / archive / refs / create | 既存の台帳・ノート・製品Git/作業コピー・親子関係・稼働確認・作成、監査、翻訳 |

`ctx` に通常渡すのは、登録より前に定義された `const` または関数への参照です。後から代入される `let` や登録より後で定義する関数は、値を写さず `getDiscussion: () => discussion`、`getRestartControl: () => restartControl`、`quickStart: (...args) => quickStart(...args)` のような関数だけを渡します。作成時には呼ばず、元の処理が値を参照していた位置で呼びます。処理全体や非同期処理の前でまとめて値を固定せず、元の参照時点を保ちます。新しいキャッシュ・共有状態・初期化順の変更は加えません。

利用状況・アカウントの読み取りの再起動待ち合わせ、リモートのログイン受付は本体に残します。アドレスのキャッシュは既存の取得関数が管理します。認証・利用状況の照合や削除・復元前の確認は各受付内で元の順番に行います。停止の共通受付とリモート接続の認証は本体に残しています。会話送信・手動の待ち列・端末開始と引継ぎは下記の専用受付から呼びます。

プロジェクトのGitHub場所表示は作業コピーと製品Gitの選択に関わるため、GitHub設定・リポジトリ操作とは分け、`project` の受付にまとめています。ファイル操作は既存の各部品に任せ、受付に直接の書き込みを加えません。`routes/` のJavaScriptも既存の書き込み監査に含めます。

フリートークは7口を元の位置で呼びます。正規名、移行済み・移行中、共通のフリートーク制限、本文読取、外部接続などの受付前の確認は本体に残します。履歴・移行・削除の確認と保存は既存の部品へ任せ、成功後だけ会話のメモリ・待ち列・未読を片付ける順番を保ちます。

会話の読み取り側は `chatread.stream` に分け、元の位置で呼びます。共通の正規名・接続・更新待ちなどの確認は本体に残します。未読の解除、SSEのヘッダー、履歴・進行中の返事・待ち列の初回送信、変更の購読の順を保ち、接続が閉じた時に購読とタイマーを解除します。外部AIの進行は `getWebchat()` で元の参照時点に取得し、送信・停止・順番待ちの操作や認証は移しません。

作業履歴の読み取り側は `taskhistory.continuation` と `taskhistory.history` に分け、元の早い位置で呼びます。各口の `X-Hub` 確認、状態と選別プレビューの取得順、履歴一覧・本文・自動整理状況の返却、例外時の409と不明経路の404を保ちます。`autoView` は既存の関数を呼ぶだけで、状態を複製しません。整理開始・取消・履歴切替・要約は `taskhistorywrite`、継続の開始・復旧は `taskcontinuation` に分けます。共通の整理中・会話世代の確認をまたがず、それぞれ元の位置から呼びます。要約準備→実行権の取得→無料の内部依頼、開始直前の実行権解除→稼働確認→版の一致確認、終了時の解除を元の順番で保ちます。継続の開始後の監査と自動整理の予約も同じ位置で行います。送信・順番待ちは専用群から呼び、停止とリモート認証の共通受付は本体に残します。

作業本文の読み取り側は `taskbody.preview` と `taskbody.archives` に分け、元の位置で呼びます。`X-Hub` の確認、下見への引数、保管一覧を取得してから原文を照合し、リンクを拒否してから本文を読む順番を保ちます。一覧に無い場所は読まず404、下見・一覧・読取の例外は409にします。本文の変更・要約・復旧は `taskbodywrite.write` に分け、既存の本文処理→監査→応答の順を保ちます。取り込み操作は別の `taskintegration` 受付から、元の既存処理へ渡します。


作業の手順・取り込み前の見通しは `taskread`、作業設定と既読の記録は `tasksettings`、会話へのメモ追加は `chatnote` に分け、元の5か所から呼びます。作業設定で場所を変える前の確認、リモートの監査記録、話題名の更新と会話保存・通知の順を保ちます。共通の本文検査・停止・履歴世代・移行済み話題の確認は本体に残します。

- `task-progress`: 作業の完了承認/再開と手順の変更。確認→稼働判定→成果検査→保存→監査→親への報告、および手順保存→成果整理の待合→最新の読み直しの順を維持する。discussion は元の参照位置で現在値を取得する。
- `task-copy-record`: 無いコピーの古い記録の片付けと、取り込み対象への追加/除外。実際のコピーや取り込み処理は移さず、元の場所/保存/監査の順を保つ。
- `phase`: フェーズの続行と次への移動。元の別々の位置に置き、確認/世代照合/稼働判定/保存/監査の順を保つ。

機能固有の残る受付は上記9群41口に分け、通算39群109口です。共通確認・外側HTTP・停止/再起動/更新、既存APIや私有差し込みへの短い転送、廃止済み入口の拒否をサーバーに残します。会話送信、端末開始/引継ぎ、別窓開始、手動の順番待ち操作の9口も、仕組み3つの移設と合わせて分けました。無料の会話・手動待ち・停止・内部依頼・終了保存を保ちます。

`taskintegration.handup` だけは本文によって従来の引渡しと統合を区別するため、元の位置で `matches(req, url, b)` を呼びます。元の条件を一回だけ評価し、統合中の吸収は後段の `apply` へ進みます。取り込み確認用のトークン・送信記録・実処理前の確認・監査の順は変えません。`mainMergeFlow` は値を写さず `getMainMergeFlow()` で元の各参照時点に取得します。

MCP、画像、添付の生データは共通の `readBody` より前の元位置で読みます。添付の世代拒否・実行権解除・部分失敗の取消と、ファイル表示の `O_RDONLY | O_NOFOLLOW`・同じfdの配信・範囲/閉鎖処理を保ちます。`localfiles` の `createReadStream` は読取専用で、書き込み監査の台帳には元処理の移設として明記します。端末SSEは再送→購読→閉鎖時の解除の順を保ち、端末開始や会話送信はこの群へ移しません。

仕組みに接する受付は `chatsend.send`、`terminalstart.start / handoff / continue`、`queuecontrol.draft / receipt / retreat / edit / unqueue` の3群9口です。元の9か所から呼び、合計42群118口になりました。GETの下書きと退避照合は本文読取の前、残りは共通の本文・世代・履歴実行権の確認後に置きます。停止のsnapshotと手動再開ticketは同じリクエストの `reqCtx` を使い、非同期取得の後も停止を確認します。

`lib/engines/queue.js` は既存ChatRunnerの接続、退避の接続、外部会話終了後の待ち列開始、内部/人の依頼の配送を担当します。順番進行と終了保存の本体は既存 `chat.js` / `chat-continuation.js` / `request-delivery.js` を使います。`lib/engines/limit-switch.js` は既存の私有policyへの差込口、証拠取得、端末の交代資料保存と再確認、終了検出の接続です。`lib/engines/parallel.js` は既存の停止・権利・作業場所の排他確認と端末の実行権の取得/解放を担当します。

各作成関数は既存参照と、後から定義/代入される値の `get...` 関数だけを受け取ります。getterは元の各参照位置で呼び、awaitの前に値をまとめて固定しません。サーバーの薄い関数は既存の宣言順と呼出先を保つために残しています。私有policy作成、ChatRunner作成、端末hookとタイマーの設置は元と同じ位置で一回だけ呼びます。新しい実行列・共有状態・タイマーは加えません。履歴整理の自動進行は別機能なので、この移設では変えていません。
