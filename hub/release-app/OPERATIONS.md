# 正式配布の適用準備（まだ実行しない）

対象は4.125.2、既存4系列 project-hub-4.123。試験版から本番の権利への変更はない。
配布証明書/公証なしの方針へ変更済み。外部操作、秘密利用、更新ファイルの実署名、課金、公開には個別承認が必要。

## 入力と対象

保存したコミットを release-app/build.cjs で組み立てる。MacはApple SiliconのProject Hub.app、WindowsはProjectHub-Windowsフォルダ。既存の一般保存先は直接選択し、管理領域はMacのLibrary/Application Support/ProjectHub、Windowsのホーム直下ProjectHub。試験管理領域に触れない。新しい候補は既存ユーザーの端末ではまだ起動しない。

Macのローカル封印はad-hocであり、発行者署名・公証ではない。WindowsのMac上生成物には専用窓のEXEがまだなく、そのまま起動できない。動的コンパイルへの代替はしない。どちらも販売用完成品と表示しない。

## Windowsの固定窓を作る（本人のWindowsが必要、配布証明書なし）

1. 独立確認後の「Windows作成用一式」を新しい作成専用場所へ展開する。これは起動用完成版ではなく、START-WINDOWS.cmdはまだ開かない。必要環境はWindows 11 x64、Node22.13以降、Windows PowerShell5.1、OS付属の.NET Framework C#コンパイラ。検証済みWebView2 SDKは同梱済みでダウンロードしない。完成版の起動にはWebView2 Runtime/Gitも必要。
2. MAKE-WINDOWS-APP.cmdを通常のダブルクリックで一度実行する。既存アプリ/一般データ/試験購入管理領域は使わず、Hubも起動しない。全候補inventoryと固定ソース/SDK/アイコンを検査して別フォルダへEXEを作り、入力/出力SHAをpreparation.jsonへ保存する。明示 --unsigned の最終組立が全入力・SDK・receipt・リンク/余剰・ファイル権限を再検査し、別の末尾 -publisher-free フォルダへ全件複製する。購入/更新の署名検査は省かない。
3. 成功すると元フォルダの隣に -native-prepared（作成原物）、-publisher-free（完成候補）、-completion.json（結果）が残る。元候補は不変。既存の出力があれば再実行を拒否する。失敗時は途中出力と表示を保持し、原因を直すまで押し直さない。未作成/失敗を完成扱いしない。実行内容は prepare-windows.cjs → finalize-windows.cjs --unsigned。署名失敗からの格下げや環境変数の切替はない。
4. 返却照合は元候補manifest SHA/source、同梱固定ソース/SDK/アイコン、preparation.json、完成候補の全inventory/種類/リンク/余剰を照合する。実行ファイル4点以外は元のbytes/SHAとlogical modeが一致、起動ソースは空のpublisherThumbprintのまま、publisherSigned=false/distribution=publisher-free/windowsNativePrepared=true。Windowsのstat/chmodは読取専用属性のみを表すため、POSIX実行bitをNTFSのACLと呼ばず区別する。返却ZIPの展開後の種類/SHA、logical modeとWindows read-only属性の対応も記録する。verify-windows-return.cjsで検証する（後述の作成物だけ、実データは含めない）。
5. 独立確認後の完成候補でSETUP-WINDOWS.cmdを通常権限で一度実行する。完成フォルダ全体とmanifestの一致を確認して通常ユーザー用固定場所へ配置し、アイコン・作業フォルダ付きのSTART-WINDOWS.cmdをユーザー用スタートメニューへ登録する。既存データと旧アプリは保持し、異なる内容の同版配置は上書きしない。旧版の正規起動項目の切り替えは本人が画面で確認する。必要環境不足は表示して停止し、自動導入や昇格はしない。
6. 実Windowsで「すべてのアプリ」のProject Hubから起動→版・実行元・新規サーバーを確認→通常終了と子プロセス/待受停止→同じ項目から開き直しを確認する。検索結果も同じ登録項目を指すことを確認する。完了画面やショートカットの存在、Mac上の生成・検査だけを実機合格としない。初回登録がない端末を使えなければ、新規登録の実機確認は未確認として残す。SmartScreenの個別許可が表示されない/Smart App Controlや組織制限で拒否なら止める。保護全体を無効にしない。正式コードの再購入・試験コードの入力は不要。

将来の署名付き経路も保持する。本人が別途許可した証明書で作成EXEを署名後、--unsignedを使わずfinalize-windows.cjs --thumbprint 大文字40桁を指定する。この場合は署名Valid/指紋一致を入力/出力で検査する。署名不正を証明書なし完成品に変更しない。元の作成receiptは署名によるEXEの変更だけを許し、SDK/入力の変更は許さない。

Windowsの`hub/app/windows/ProjectHub.ico`は、Macと共通の`hub/public/icon.png`から作った16/24/32/48/64/128/256pxの画像です。C#コンパイル時に`/win32icon`でEXEへ埋め込み、窓もそのEXEのアイコンを使います。アイコンの変更は新しい入力・receipt・EXEを要し、既存の作成証跡や署名は使い回しません。START-WINDOWS.cmd自体のコマンドファイル用アイコンは変わりません。

## Macの直接配布（Developer ID・公証を使わない）

保存ソースからmacOS13を対象に正規ビルドし、ローカルad-hoc封印と全byte/SHA/種類/mode/余剰を確認する。Developer ID/Apple契約/notarytool/Keychain/証明書購入は今回の前提にしない。更新ファイルと購入証明の署名は別に維持する。local ad-hocは発行元の証明でもAppleの安全性確認でもない。

独立合格後の送付直前にZIP化、別展開の全件照合とcodesign --verify --deep --strictで封印確認する。実Macでは固定した起動場所を本人が確認してから起動する。未公証警告に対してはREADME/guideとApple公式の個別アプリ許可に限る。破損/悪質な内容の警告は停止する。spctl無効化・隔離属性一括削除・組織制限の回避は行わない。今のMacでのビルド/封印確認を別Macでの導入成功としない。

## 本番購入・体験・受付

既存のWorkerとDBを評価して再利用する。秘密値を出力しない。OPERATIONS.mdとmigrate-orders-stripe.mdの現行手順に従い、既存鍵/kid・購入コードHMAC秘密・4系列識別子を保持する。

1. 本人が確認する対象：本番Stripeアカウント、regular4900JPYとintro1100JPYの1回限りの現行価格、Payment Link、modeの合った読取/Checkout書込の制限キー、署名Webhook、既存Worker・D1。TRIAL_DAYS=30、端末Mac2/Windows2。日本国内向け販売条件と実Checkoutの受付対象は公開前に照合し、国外受付を勝手に開始しない。
2. DBは先に読取でschema・orders列・intro challengeを確認する。新規schemaに旧migrationを重複適用しない。必要なmigrationだけ対象差分を別承認し、一括適用後readbackする。消費済みchallengeや購入履歴を作り直さない。
3. scripts/release-license-build-4.125.2.sql の対象2行を確認し、新buildを登録。既存と異なる行は上書きせず停止。既存4.125.0行は残す。
4. release-preflight.mjs は秘密を含まない正規化した読取結果だけをstdinで受ける。未知はfalse/NOT_READYとする。READYは確認項目が揃った申告であり、実通信/実配信/発売合格の証明ではない。Windows受付falseならWindows blockedのまま。
5. 現候補は本人依頼によりMac・Windowsとも本番の受付先を設定済み。本番の購入受付設定・Worker配置・build登録は具体対象と差分を別承認し、readbackで確認する。候補側の設定ONを本番受付の成功扱いにしない。試験用endpoint/鍵/証明を本番へ入れない。今回の準備・試験では候補を起動せず、本番へ接続しない隔離検証のみとする。
6. 結果不明時は既存claim/receiptとStripe/DB結果を照合してから対応し、再送・再購入をさせない。旧試験注文・返金済み注文は再利用しない。実カードの本番テスト購入と予定返金をしない。本番の購入後経路は最初の正当な販売で監視し、既済Sandbox成功と分けて記録する。

復旧：公開前は現行版・現行Worker・既存配信を維持。新受付に問題がある場合は承認済み範囲で新規購入入口を停止し、既済の支払いを照合する。新build行を消したり旧秘密へ雑に戻したりしない。DB全体のTime Travel復旧は他の販売を巻き込むため自動で行わず、対象と再照合の別承認を要する。署名済み購入証明がすでに端末へ出た場合、即時失効を保証しない。

## 安定版更新・公開

release-app/package-update.cjs は完成済み正本のruntimeから更新ZIP/未署名payload/署名planを作る。Windows固定窓未作成の一式は拒否し、完成前の更新ファイルを公開可能と扱わない。今回のMac正本と、本人Windows完成・返却照合後の正本からasset/tree/seq/期限/planを固定し、変更分だけ確認してから既存の更新鍵で署名する。配布証明書なしの固定正本は発行者署名後の再構築を要求しないが、内容や本番受付が変われば再構築する。古い候補への署名・承認を流用しない。実際に使う鍵メモ/Keychainのアクセスは別承認。

公開先候補は kieiken/project-hub の v4.125.2。
- Project-Hub-4.125.2-Runtime-Apple-Silicon.zip
- Project-Hub-4.125.2-Runtime-Windows-x64.zip
- project-hub-runtime-update.json
- project-hub-runtime-update-windows.json

新方式は latest/download の上記runtime feedだけを使う。旧project-hub-update*.jsonと試験v4.125.1-purchase-test.updateは変更しない。Latestの切替は既存利用者にも影響する公開操作なので別承認。旧方式/購入試験版から正式版の初回は手動入替で、試験側のpending更新を削除しない。旧購入試験版の管理領域は保持し、試験ライセンスを本番に昇格しない。正式版内で実更新を確認するには後続の別版が必要で、同一4.125.2を更新成功とはしない。

LPのindex.htmlとguide.htmlはローカル原稿。全前提が整うまで準備中とし購入/ダウンロードを無効にする。問い合わせの実受信と返信、販売地域/法務最終確認、証明書なし正式候補の起動結果、正式build受付のreadbackを確認後、実ファイルの固定URLとSHAを揃えて公開承認を求める。署名/公開/本番受付/メール受信はこの文書によって完了しない。

公式導入資料（2026-10-21確認）：https://support.apple.com/ja-jp/102445 、https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation 、https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions 。一般の未確認アプリ警告への個別許可と、起動不可の保護を区別する。
