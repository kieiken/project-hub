# Project Hub Windows 繁體中文擴充

以 v4.68.2 為基礎的 Windows 瀏覽器介面版本，保留原專案 MIT 授權。不是上游正式 Windows 發行版，尚未整合上游 v4.90.0。

## 安裝

需要 Windows 10／11、Node.js 22 以上、Git，以及已安裝並登入的 Claude Code 或 Codex CLI。在原始碼根目錄執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\hub\setup-windows.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\hub\start-windows.ps1
```

安裝腳本建立桌面捷徑；預設資料放在「文件」中的 `ProjectHub-Workspace`。本機設定在 `hub/windows-local.json`，不應提交至 Git。瀏覽器網址為 http://127.0.0.1:4545。關閉瀏覽器不會停止服務，可執行 `hub/stop-windows.ps1`。

## 儲存位置

在設定的儲存位置區塊選擇空白目錄，可以複製現有資料或建立空白工作區。切換前必須停止 AI 工作。原資料會保留；既有絕對程式碼路徑不會重寫，請勿直接刪除舊目錄。複製模式拒絕符號連結及 Git worktree 指標檔。

## Skill 管理

在設定中管理共用 Skill 來源資料夾，預設掃描使用者家目錄下的 `.codex/skills`。可新增多個來源，掃描其中的 `SKILL.md`，再按專案勾選並儲存。設定保存在資料目錄的 `_hub/skills.json`，不改寫 Skill 原件。

開始工作時，所選 Skill 的讀取指示會加入 AI 提示。工具能力及 Skill 相容性仍取決於實際 CLI；不存在的已選 Skill 會明確報錯。此功能不代表所有外部 Skill 都能無條件執行。

## 翻譯與平台限制

主要介面加入離線繁體中文字典，保留使用者對話、程式碼及表單值。進階動態訊息、CLI 輸出及上游文件尚未全部翻譯。Windows 使用瀏覽器，未移植 macOS 原生嵌入視窗。外部程序工作目錄對應及 HEIC 解碼仍有限制。

本版本加入 Windows 程序／路徑處理、CRLF 支援、圖片轉換及針對性的本機 HTTP、網址與檔名防護。這不是完整安全稽核。服務預設只監聽本機，請勿直接公開連接埠。

驗證範圍與未完成項目見 [TESTS.md](TESTS.md)。
