# Project Hub

[日本語](README.md) | 繁體中文

**公開 Beta 版。目前是開發中的版本（v4.90.0）。** 功能、畫面與儲存格式仍可能改變。請先在可以試用的範圍內使用，避免直接套用到重要資料。歡迎分享使用心得、回報問題或提交 Pull Request；參與方式見 [CONTRIBUTING.zh-TW.md](CONTRIBUTING.zh-TW.md)。

Project Hub 將專案與任務集中管理，並在同一個畫面中執行 Claude Code / Codex。主要供單一使用者在自己的 Mac 上使用。服務只監聽 `127.0.0.1`；本機操作沒有使用者登入驗證。可自行啟用 Tailscale 與通關密語，從自己的 iPhone 遠端操作，但不適合作為公開網站或多人共用伺服器。

使用前請閱讀 [hub/README.zh-TW.md](hub/README.zh-TW.md) 的「使用前須知」。

## 畫面範例

以下是過去版本的實際畫面，個人資料、業務內容與真實對話已遮蔽。畫面仍是拍攝時的日文版本，可能與目前版本（4.90.0）不同。

### 對話畫面與執行中的指示（取消／補充說明／下一個指示）

拍攝於 2026-09-29，版本為 v4.10.0（已遮蔽敏感資訊）。

![對話畫面與執行中的指示（v4.10.0，已遮蔽敏感資訊）](docs/screenshots/conversation-redacted.png)

### 對話畫面與排隊中的後續指示

拍攝於 2026-09-30，版本為 v4.16.0（已遮蔽敏感資訊）。

![對話畫面與排隊中的後續指示（v4.16.0，已遮蔽敏感資訊）](docs/screenshots/queued-instructions-redacted.png)

## 必要條件

- macOS。
- Node.js 22 以上、Git。
- 安裝要使用的 AI CLI（Claude Code / Codex），並先完成登入。
- 編譯終端機元件 node-pty 與 Project Hub.app 需要 Apple 開發工具。

## 開始使用

在取得的專案最上層（本 README 所在位置）執行：

```sh
HUB_LANG=zh-TW HUB_APP_DIR=/Applications HUB_ROOT="/Volumes/External/AI-Workspace" bash hub/setup.sh
```

`/Volumes/External/AI-Workspace` 是範例，請換成自己的資料磁碟路徑，並確認磁碟已掛載。遵循本機儲存規則時，將程式放在 `/Applications`，專案資料、快取與編譯暫存放在指定資料磁碟。

- `HUB_LANG=zh-TW` 使用繁中介面、範本與範例資料；`ja` 為日文。
- 在 `HUB_ROOT` 下建立 `_hub/`、`Product/`、`Work/`。未指定時，預設位置為 `~/Documents/AI-Workspace/`。
- 可以重複執行；既有 `roles.yaml` 與專案台帳（有 `PROJECT.md` 的資料夾）不會被覆寫。
- 透過 npm 安裝 node-pty，並建立 Project Hub.app 與桌面入口。`HUB_APP_DIR` 可指定應用程式安裝位置。

操作方式與更新步驟見 [hub/README.zh-TW.md](hub/README.zh-TW.md)。

## 每日自動更新

公開版本預設關閉，可在設定「Project Hub 自動更新」啟用。每天最多從原作者 `kieiken/project-hub` 的 `main` 檢查一次，重啟也會保留每日限制。新版先在隔離副本翻成繁中並完成驗證，保留舊 App 後才更新；驗證過的翻譯透過個人 fork 提交 PR 回原作者。

Codex CLI 與 GitHub CLI 需要先登入，並設定可推送的 fork；來源衝突或流程失敗時保留舊版並提示，不保證所有未來版本都能自動合併。開關、狀態與處理方式見 [使用手冊](hub/README.zh-TW.md)。

## 注意事項

- **AI 權限確認**：預設啟動 Claude Code 時會略過權限確認，Codex 則會略過權限確認與沙箱限制。AI 可以使用你的帳號權限修改檔案與執行指令。可在 `_hub/roles.yaml` 的 `permissions` 改成需要確認的啟動方式。
- **費用**：AI 的方案、費率與付款方式由各 CLI 的設定決定；Project Hub 不保證使用 AI 不會產生費用。
- 自動 Git 儲存、複製到工作副本的設定檔，以及留在本機的紀錄等注意事項，見 [hub/README.zh-TW.md](hub/README.zh-TW.md)。

## 測試

```sh
HUB_SKIP_NPM=1 npm --prefix hub test
```

未安裝 node-pty 時，會略過實際操作內嵌終端機的檢查。

## 隨附的初始台帳（seed）

`hub/seed/` 提供日文版，`hub/seed-zh-TW/` 提供繁中版，包含虛構的「範例應用程式」「範例網站」「範例文件」及「Project Hub」專案台帳。它們不是實際專案或工作紀錄。`setup.sh` 依語言將台帳複製到 `Product/<名稱>/`。

繁中範本保留程式使用的欄位名稱、角色識別碼與狀態值；中文名稱、說明與「步驟」標題不影響資料相容性。既有日文台帳不會自動改寫。

## 關於公開版本

這個資料夾是只包含 Project Hub、沒有原始 Git 歷史的公開版本。在 Git 工作目錄執行 `node scripts/export-public.js`，可以從已提交的檔案重新匯出到 `public-release/ProjectHub`。需要固定產品程式碼版本時使用 `--ref <commit>`；需要從另一個提交取得公開文件時使用 `--public-ref <commit>`。

- 不包含真實工作紀錄（例如 `.ai/` 中的對話與交接）；僅保留範本與虛構台帳所需的 `.ai/` 檔案。
- 公開版 [變更紀錄](hub/CHANGELOG.zh-TW.md) 從 4.20.0 開始。更早的紀錄涉及過去資料，因此未納入公開版本。繁中版保留公開版的完整歷史。

## 參考來源

以下專案提供設計概念；未隨附它們的原始碼，也沒有程式依賴。

- teddashh/bat-agent-connector（MIT）：監看等待輸入、合併前確認與操作紀錄。
- arumwu/goose-acp-handoff：AI 交接時的背景資料。

## 授權

Project Hub 採 MIT 授權（Copyright (c) 2026 kieiken），原文見 [LICENSE](LICENSE)。

這個專案最初建立於 Discord Bot 範本「discordpy-startup」的儲存庫（MIT，Copyright (c) 2019-2020 Discord Bot Portal JP）。公開版本未包含該範本的 Bot、Python 或 Heroku 設定，仍保留來源的著作權與授權聲明。

xterm.js、透過 npm 安裝的 node-pty 等第三方軟體資訊，見 [THIRD_PARTY_NOTICES.zh-TW.md](THIRD_PARTY_NOTICES.zh-TW.md)。授權條文保留原文。

## 使用心得、問題與 Pull Request

這是持續根據使用回饋改進的開發版本。

- **心得與需求**：在 [Issue](https://github.com/kieiken/project-hub/issues/new/choose) 選擇「使用心得與需求」。可簡單寫下使用情境、喜歡或不易理解的地方。
- **問題回報**：選擇「問題回報」，附上版本（畫面或 `hub/package.json`）、macOS 與 Node.js 版本、重現步驟及實際結果。
- **Pull Request**：歡迎提交；大幅變更請先透過 Issue 討論。
- 分享對話、台帳或截圖前，請先移除姓名、路徑、通關密語、token 等個人或機密資訊。

## 最新介面與相容性（4.90.0）

繁中包含 AI 帳號、模型別使用量與票券、freetalk 話題與整理、外部共用刪除保護、自動更新與對話表格。未設定 `HUB_LANG` 時使用日文；`HUB_LANG=zh-TW` 只翻譯程式自身文言，使用者文章、路徑、終端輸出、狀態與角色的儲存值保留原文。既有日文台帳與繁中標題都可讀取，不覆寫既有專案。

自動更新預設關閉。啟用需要 `HUB_UPDATE_SOURCE`、`HUB_UPDATE_APP` 與 `HUB_STORAGE_GUARD`；缺少時顯示尚未支援。確認與翻譯使用永久保存的 24 小時閘門，AI 與排隊結束前等待套用，建置與簽章確認後保留舊 App 備份。自動翻譯與翻譯 PR 另需 `HUB_AUTO_TRANSLATE=1` 與 `HUB_TRANSLATION_FORK`，辭典安裝本身不會啟動 AI 或提交 PR。

Mac App 的 CI 會執行兩種語言的測試、公開內容檢查、建置與簽章驗證，再產生繁體中文的發佈用 App。App 使用自行簽署的簽章，尚未公證；啟動仍需另行安裝 Node.js 22 以上與使用的 AI CLI。使用條件與設定方式見 [hub/README.zh-TW.md](hub/README.zh-TW.md)。
