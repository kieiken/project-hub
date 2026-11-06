# PR 草稿：Windows 平台層以 Codex CLI sandbox 實作 `commandSandbox`（只含 Codex 隔離執行）

> 狀態：草稿，尚未推送、尚未開 PR。給 kieiken/project-hub 的第一片 adapter PR。
> 基底：`refs/remotes/origin/main` 9f5f6b5（Project Hub 4.126.95）。
> 分支：`codex-sandbox-win32`（本機 worktree），程式碼 commit `b2608700`（初版）＋真機驗證後的修正 commit `86b88e3`（`:root`、`.git`="deny"、秘密檔 glob 拒讀）＋沙箱內逾時收尾 commit（coreutils `timeout`，2026-11-04），commit 身分 `kf208016 <66252666+kf208016@users.noreply.github.com>`。
> 2026-11-03 已在真機（Codex 0.164.0、已做 `codex sandbox setup --elevated`）透過 `WorkspaceSandbox.run()` 實際跑 `codex sandbox`，結果見第 5.2 節；初版的 `":minimal"` 在 0.164.0 的 elevated 後端會被拒絕，已改為 `":root"`。2026-11-04 補上沙箱內的逾時收尾並真機驗證：逾時後沙箱帳號名下不再留下行程。
> 文末附日文概要，可直接貼進 PR 說明。

## 1. 這個 PR 做什麼

作者 4.126.95 的 `hub/lib/platform/win32.js` 第 121 行把 `commandSandbox` 固定為 `available: () => false`，所以 `hub/lib/workspace-sandbox.js` 在 Windows 一律以「Windowsでは未対応」拒絕 ChatGPT 子作業的 `hub_run_command`。

這個 PR 只做一件事：在 Windows 平台層補上 `commandSandbox` 的 `available()／profile()／spawn()` 三個合約，用 **Codex CLI 自帶的 `codex sandbox` 子命令**當作 OS 邊界，讓 `WorkspaceSandbox.run()` 在 Windows 可以執行命令。行為規格對齊 Mac 的 `darwin.js`（`sandbox-exec` profile）：只有工作區根目錄可寫、`.git` 與憑證檔（`.env*`、`*.pem` 等）不可讀寫、額外列出的檔案可讀、無網路、命令經 POSIX shell 執行、逾時時命令連同它的子行程一併結束。

不在這個 PR 裡：Claude／Grok 的隔離執行、瀏覽器登入、憑證 ACL、安裝程式、版本固定與專用副本（Issue #8 的 (b)(c)）、Windows 的 `hub/test/run.cjs` 執行器。

## 2. 為什麼這樣拆

- 作者在 PR #4 的規則：先開 Issue、以最新版為基底、按功能拆小 PR。Issue #8（10-26）提議的順序是 (a) Codex 隔離 → (b) Claude／Grok 隔離基盤 → (c) 版本固定與專用副本。這個 PR 是 (a) 裡最小、可獨立審的一片：只碰平台層與 `WorkspaceSandbox`，不改 HTTP 路由、不改授權政策（平台層合約明寫「never permission policy」）。
- D: 分支（windows-browser-mvp，基底 v4.68.2）直接合併到 4.126.95 有 60 檔 330 段衝突，不可行。D: 的 Codex 隔離是為「原生橋接」設計的（app-server `command/exec`、Job supervisor、root pin、版本雜湊），和作者 4.126.x 的 `commandSandbox` 合約（spawn 一個 ChildProcess、串流 stdout／stderr、回傳 exit code）形狀不同。這裡只移植 D: 已在真機驗證過的那條通道：`codex sandbox -C <root> -P <profile> --include-managed-config -c … -- <程式>`（D: `hub/lib/provider-sandbox.js`，PROVIDER-RUNTIME.md 記載「官方 `codex sandbox` 在本機能轉送 stdin／stdout／stderr，退出碼 0；此版 `-P` 為必要參數」）。
- 不搬 D: 的 Job supervisor（`managed-process.js`、C# job-runner）、root pin、`codex-versions.js` 雜湊白名單、`local-drives.js`：這些是 D: 原生橋接的安全層，作者的平台層已經有自己的 `killTree`（原生 snapshot＋所有權核對）與 `findExecutable`，先沿用作者的機制，把 D: 那些留給後續 PR 討論。

## 3. 改了哪些檔（9 檔）

| 檔案 | 改動 |
| --- | --- |
| `hub/lib/platform/win32-command-sandbox.js`（新，85 行） | Codex 沙箱 adapter：`create({fs, env, findExecutable, shellCandidates, spawn, execPath})` 回傳 `{available, profile, spawn, codexExecutable, shell, timeoutExecutable}`；另匯出 `limitScript(timeoutMs)`（沙箱內逾時包裝的 shell 字串）。 |
| `hub/lib/platform/win32.js` | `commandSandbox` 改為延遲載入上面的模組（第一次呼叫才 `require`，`supervisorFiles` 不變，detached supervisor 不會載到它），`spawn` 多傳第 5 個參數；`shellCandidates` 提到函式外層讓 adapter 共用。其餘不動。 |
| `hub/lib/workspace-sandbox.js` | 新增 `kill(child)`：先 `platform.killTree(child,'SIGKILL')`，失敗時改 `child.kill('SIGKILL')`；`run()` 的逾時與 `close` 後清理、`stop()` 都走它。`run()` 把自己的 `timeoutMs` 以第 5 個參數 `{ timeoutMs }` 傳給 `commandSandbox.spawn()`（darwin 不用它）。Windows 拒絕訊息改成「WindowsではCodex CLIの隔離実行（codex sandbox）とGit for Windowsが必要です。見つからないため、コマンドを実行しません」。 |
| `hub/test/platform-win32-command-sandbox.test.js`（新，7 題） | 見第 6 節。 |
| `hub/test/platform-win32.test.js` | 「unsupported Windows features」那題改用 fixture 的 fs／env（PATH 上什麼都沒有），不再依賴主機有沒有裝 Codex。 |
| `hub/test/platform-preparation.test.js` | 「Windows sandbox refusal」那題同上，改用 fixture 建 win32 adapter；訊息斷言改成 `/Codex CLIの隔離実行/`。 |
| `README.md`、`README.zh-TW.md`、`hub/app/windows/README.md` | 把「隔離実行は Windows 未対応」的句子改成前置條件說明（Codex CLI 的 sandbox 已做 `codex sandbox setup --elevated`、Git for Windows）。 |

### 3.1 `win32-command-sandbox.js` 的行為

- `available()`：同步、無副作用。`findExecutable('codex')` 找到 `codex.exe` 就直接用；找到 npm 的 `codex.cmd` 時，確認同目錄 `node_modules/@openai/codex/package.json` 的 `name` 是 `@openai/codex`，再取 vendored 的 `node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`（套件內或 hoisted 兩個位置）。`.bat` 或其他殼一律不展開。另需 `shellCandidates()` 的 `bash.exe` 存在，以及 Git for Windows 的 coreutils `timeout.exe`（在 bash 同目錄或 `..\usr\bin\`）。三者齊備才回 `true`。**不執行 codex 來查版本**。
- `profile(root, readFiles)`：驗 `root` 與每個 readFile 是本機磁碟絕對路徑（`X:\`、無 NUL／換行／引號、無 ADS、無 `..`）。回傳凍結物件 `{root, readFiles, args}`，`args` 固定為：

  ```
  sandbox -C <root> -P project-hub-command --include-managed-config
    -c permissions.project-hub-command.filesystem={":root"="read","<root>"="write","<root>\.git"="deny",
         "<root>\**\.git"="deny","<root>\**\.env*"="deny","<root>\**\.netrc"="deny","<root>\**\.npmrc"="deny","<root>\**\.pypirc"="deny",
         "<root>\**\id_rsa*"="deny","<root>\**\id_ed25519*"="deny","<root>\**\id_ecdsa*"="deny","<root>\**\id_dsa*"="deny",
         "<root>\**\*.pem"="deny","<root>\**\*.key"="deny","<root>\**\*.p12"="deny","<root>\**\*.pfx"="deny",
         <每個 readFile>="read"}
    -c permissions.project-hub-command.network.enabled=false
    -c windows.sandbox="elevated"
  ```

  - `":root"="read"`：Codex 0.164.0 的 elevated 後端只接受這個讀取基底（給 `":minimal"` 會回「elevated Windows sandbox requires effective `:root` read access」，真機實測）。意思是「讀取照沙箱帳號本身的 NTFS ACL」，不是「加開全部讀取」，範圍見第 4 節第 2 點。
  - `.git`="deny"：真機實測同時擋讀與寫（`cat .git/HEAD`、`echo x > .git/w`、`ls .git` 都 Permission denied），對齊 Mac 的 `(deny file-read* file-write* (subpath root/.git))`；初版的 `"read"` 只擋寫。
  - 13 條 `<root>\**\<樣式>`="deny"：對應 Mac profile 的兩條 regex（巢狀 `.git`、`.env*`、`.netrc`、`.npmrc`、`.pypirc`、`id_rsa*`／`id_ed25519*`／`id_ecdsa*`／`id_dsa*`、`*.pem`／`*.key`／`*.p12`／`*.pfx`）。Codex 在啟動時展開 glob 並對符合的檔案加拒讀 ACE；真機實測 `.env`、`sub/.env`、`.ENV`、`key.pem`、`sub/CERT.PEM`、`sub/id_rsa`、`sub/nested/.git/HEAD` 都讀不到（NTFS 不分大小寫），兩萬檔的工作區只多 0.2～0.4 秒。清單放在模組常數 `SECRET_GLOBS`。
  - 在 `root` 底下的 readFile 會被濾掉（在可寫根裡再加 read 會變成唯讀 carve-out，反而限制寫入）。路徑用 `JSON.stringify` 當 TOML basic string（跳脫規則相容），glob 用反斜線分隔也可（真機實測）。
- `spawn(command, root, profile, spawnProcess, { timeoutMs })`：驗 command 非空、profile 是上面 `profile()` 產出且 `root` 一致；再確認 codex、bash 與 Git for Windows 的 coreutils `timeout.exe` 都在，否則丟 `command_sandbox_unavailable`。實際呼叫：

  ```
  spawnProcess(realpath(codex.exe), [...profile.args, '--', <bash.exe>, '-c',
      'exec /usr/bin/timeout --kill-after=2 <秒>s /usr/bin/bash -c "$0"', command],
    { cwd: root, env: <最小環境>, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  ```

  - 沙箱內的逾時包裝：Hub 到 `timeoutMs` 會終止 codex.exe，但 Hub 以一般使用者身分無權終止沙箱帳號的行程，所以同樣的上限（無條件進位到整秒）也由沙箱內的 coreutils `timeout` 執行：到點對命令的行程群組送 TERM，2 秒後 KILL。命令以 `$0` 原樣傳給內層 `bash -c`，沒有任何引號處理。沒傳 `timeoutMs`（或不是正數）就不包裝，尾端仍是 `-c command`。
  - 為什麼是在 shell 內 `exec timeout`，而不是把 `timeout.exe` 直接放在 `--` 後面：`Git\bin\bash.exe` 是原生的啟動器（負責設定 `MSYSTEM`、把 `/mingw64/bin` 加進 PATH，`git` 要靠它才找得到），真正的 MSYS bash 是它再啟動的，不在外層 `timeout` 的行程群組裡；真機實測那種包法六種子行程一個都收不掉。改在啟動器建好的 shell 內 `exec /usr/bin/timeout`，`timeout` 自己成為群組 leader，內層 `/usr/bin/bash` 與命令的子行程都在群組內，六種都在上限結束（第 5.2 節）。

  最小環境只放 `SystemRoot、SystemDrive、windir、ComSpec、PATHEXT、USERPROFILE、APPDATA、LOCALAPPDATA、ProgramFiles、ProgramFiles(x86)、NUMBER_OF_PROCESSORS、PROCESSOR_ARCHITECTURE、CODEX_HOME`（有值才放），加上固定的 `PATH=System32;Git\bin;<node 目錄>`、`HOME=TEMP=TMP=<root>`、`LANG=en_US.UTF-8`。Hub 的 `HUB_*`、帳號變數、`OPENAI_API_KEY` 等 AI 憑證一律不進去。對齊 Mac 的 `HOME: root, TMPDIR: root`。Git Bash 會自己把 `/usr/bin`、`/mingw64/bin` 加進 PATH，所以 `cat`、`printf`、`git` 都找得到（已實測）。
- 用 `fs.realpathSync.native` 取 codex.exe 的正規路徑再 spawn：作者的 win32 `killTree` 會用 `findExecutable(child.spawnfile)` 和 kernel 的 image path 比對。

### 3.2 為什麼要動 `workspace-sandbox.js`

作者的 `run()` 在 `close` 事件後會再呼叫一次 `killTree(child)`（Mac 用來掃 detached process group）。Windows 的 `killTree` 對已結束的子行程會丟「Windowsの起動した子プロセスを確認できません」，在事件處理器裡丟出去就是 uncaught exception。`chatgpt.js` 自己的 `run()` 已有同樣寫法（`try { killTree } catch { child.kill }`），這裡比照。Mac 行為不變：darwin 的 `killTree` 預設有 fallback、不會丟。

## 4. 已知限制（請審閱者特別看）

1. **需要先做一次 `codex sandbox setup --elevated`**（需系統管理員，一次性）。真機（Codex 0.164.0）實測：elevated 後端只接受 `":root"` 讀取基底；`unelevated` 後端做不到唯讀 carve-out 與拒讀（「Restricted read-only access requires the elevated Windows sandbox backend」），而且 Git Bash 在它的受限 token 下根本起不來（`CreateFileMapping … Win32 error 5`）。所以 0.164.0 只有「elevated＋`:root`」這一種可用組合。沒做 setup 時，codex 會以非 0 結束並在 stderr 說明（不會退回無沙箱執行）；Hub 在 spawn 前**無法**偵測 setup 狀態（不執行 codex 就查不到），`available()` 只看檔案存在。結果是：命令「失敗」而不是「拒絕」，ChatGPT 會拿到 exit code 與 stderr。
2. **讀取範圍比 Mac 寬**。`":root"` 的意思是讀取照沙箱帳號（`CodexSandboxOffline`，屬於 `BUILTIN\Users`／`Authenticated Users`）本身的 NTFS ACL。真機實測：讀得到 `C:\Windows\win.ini`，列得出 `D:\`、`D:\HubTest`、`C:\Program Files`、`C:\Users`；讀不到使用者設定檔根目錄（`C:\Users\<user>`，Permission denied），也讀不到關掉繼承、只給使用者／SYSTEM／Administrators 的資料夾。因此像 `D:\` 這種根目錄預設 ACL 給 `Authenticated Users` 修改權的磁碟，上面其他專案的檔案沙箱**讀得到**（寫不到：elevated 後端用 write-restricted token，寫入要有明確的 `CodexSandboxUsers` ACE）。Mac 只開放 `/System、/usr、/bin、/sbin、/Library`。這個後端無法再收窄，PR 說明要照實寫。`network.enabled=false` 真機實測 `curl https://example.com`、`curl http://1.1.1.1` 都連不上（rc=7）。
3. **秘密檔案：讀與覆寫已對齊 Mac，刪除沒有**。13 條 glob 拒讀真機實測有效（第 3.1 節）；`echo z > .env` 也被擋（Permission denied）。但 `rm key.pem` **成功**：刪除權來自目錄的 Modify ACE，Codex 的 `deny` 只加拒讀 ACE。Mac 的 `(deny file-write*)` 連 unlink 一起擋。另外 glob 在啟動時展開，命令執行中新建的秘密檔要到下一次執行才被拒讀。ChatGPT 的檔案工具仍由 `resolveWorkspace` 的 `SECRET` 規則擋住。
4. **Codex 會改工作區的 NTFS ACL，而且不會還原**（真機實測，Codex 的設計）：工作區根目錄加 `CodexSandboxUsers:(OI)(CI)(M)` 並繼承到所有檔案；`.git` 與 glob 命中的檔案加 `CodexSandboxUsers:(DENY)(R)`（目錄再加可繼承的 deny）；每個 readFile 加 `CodexSandboxUsers:(RX)`；沙箱裡建立的檔案擁有者是 `CodexSandboxOffline`（使用者仍可透過繼承的 ACE 存取）。`CODEX_HOME` 底下 codex 會寫 `cap_sid` 與 `tmp\arg0-windows\<隨機>`（正常結束會清掉，被 kill 時留下）。PR 說明與 README 應讓使用者知道隔離執行會動工作區的 ACL。
5. **逾時：Hub 只殺得掉 codex.exe，沙箱內的收尾靠 coreutils `timeout`**（真機實測）。Hub 到 `timeoutMs` 以 `killTree` 終止 codex.exe（約 1.7～2.5 秒後 `run()` 解析為 `code: 1, signal: null`，不是 Mac 的 `SIGKILL`）；Hub 以一般使用者身分無權終止沙箱帳號（`CodexSandboxOffline`）的行程，所以 11-03 的版本會把 `sleep.exe` 留到 120 秒自然結束。11-04 起 `spawn()` 收到 Hub 的 `timeoutMs`，在沙箱內用 coreutils `timeout` 對命令的行程群組掛同樣的上限（TERM，2 秒後 KILL）：真機實測 `timeoutMs=6000` 跑 `sleep 120 & node … & wait`，執行中（+3.1 秒）看得到沙箱帳號的 `bash`／`timeout`／`sleep`，8.6 秒解析後從 9.1 秒起沙箱名下沒有任何行程，到 120 秒都沒有（第 5.2 節）。殘餘限制：秒數進位到整秒；只收得掉命令所在的行程群組，自己脫離群組的程式收不到（Git for Windows 沒有 `setsid`，但程式可自行建立）；沙箱內的上限比 Hub 的晚約 1.5 秒（codex 啟動時間），正常情況仍是 Hub 先殺 codex.exe、結果 `code: 1`；若 Hub 的事件迴圈被卡住，會由沙箱內先結束、`run()` 回 `code: 124`。
6. **環境變數**：沙箱內 `env` 實測只有 PASSTHROUGH 與固定值，加上 libuv 在 Windows 自動補的 `HOMEDRIVE／HOMEPATH／USERNAME／USERDOMAIN／LOGONSERVER`（取自父行程）與 Codex 自己加的 `GIT_CONFIG_*`（工作區的 `safe.directory`）、`GIT_PAGER／PAGER／LESS`、PATH 前面兩個 codex 目錄。沒有 `HUB_*`、沒有 API key。Git Bash 把 `/tmp` 掛到 `TEMP`＝工作區，所以 `pwd`、`$HOME` 顯示成 `/tmp`（`pwd -W` 才是 Windows 路徑）；`rm -rf /tmp/*` 會清掉工作區，和 Mac `TMPDIR=root` 的性質相同。
7. **延遲與並行**：每條命令約 1.7～2.1 秒（ACL 佈建），長時間閒置後第一次 13 秒；兩萬檔工作區加 glob 只多 0.2～0.4 秒；同一工作區 3 路並行、不同工作區 2 路並行都正常。
8. **沒有版本下限檢查**。D: 在真機驗過 0.154.0 的 `codex sandbox -P` 搭 `":minimal"`；本 PR 以 0.164.0 真機驗證，`":root"` 在 0.154.0 上未測。更舊的 Codex 不認 `-P` 時會以非 0 結束，不會退回無沙箱執行。
9. `hub/test/gpt-child.test.js` 的真 OS 題（「sandboxは子内だけを書ける…」）只在作者的 macOS 執行器下有意義；在 Windows 改動前後都因 fixture 原因（「GPT子の専用作業用コピーが必要です」）失敗，與本 PR 無關。
10. `hub/test/run.cjs` 要求 macOS `sandbox-exec`，Windows 上無法用官方執行器；本次用 `node --test --test-force-exit <檔>` 逐檔跑。
11. **Codex 的安裝版型只認兩種**：PATH 上直接的 `codex.exe`，或 npm 全域的 `codex.cmd`（旁邊有 `node_modules/@openai/codex`）。pnpm／bun／Vite+ 的全域版型、或 `.bat`／`.ps1` 殼，一律視為未安裝（fail closed），不會退回 cmd.exe。

## 5. 怎麼驗證（本次已做）

環境：Windows 11 Pro 10.0.26200、Node v24.15.0、Git for Windows（`C:\Program Files\Git\bin\bash.exe`）、npm 全域 `@openai/codex` 0.164.0（已做 `codex sandbox setup --elevated`；第 5.2 節有實際執行）。`TEMP／TMP` 指到 `D:\HubTest\tmp\codex_sandbox_pr\…`，不碰 4545／4546、已安裝的 ProjectHub；真實 `~/.codex` 只被 codex 自己讀設定與寫 `cap_sid`、`tmp\arg0-windows`。

```
cd hub
set HUB_LANG=ja
node --test --test-force-exit test/platform-win32-command-sandbox.test.js
node --test --test-force-exit test/platform-win32.test.js
node --test --test-force-exit test/platform.test.js
node --test --test-force-exit test/platform-preparation.test.js
node --test --test-force-exit test/gpt-child.test.js
node --test --test-force-exit test/chatgpt-retired.test.js
```

| 測試檔 | 改動前（9f5f6b5） | 改動後（b2608700；真機修正後與逾時收尾後各重跑前 6 檔，數字相同） | 說明 |
| --- | --- | --- | --- |
| platform-win32-command-sandbox.test.js（新） | — | 7／7 通過 | 含真機 Git Bash 兩題（命令包裝、逾時群組收尾） |
| platform-win32.test.js | 40／40 | 40／40 | |
| platform.test.js | 11／16 | 11／16 | 5 題失敗相同：Mac 專屬（`ps`、`/usr/bin/swift`…）與 Windows 無 symlink 權限 |
| platform-preparation.test.js | 9／10 | 9／10 | 1 題失敗相同：Darwin／Linux UID |
| gpt-child.test.js | 6／15 | 6／15 | 9 題失敗相同：見第 4 節第 6 點 |
| chatgpt-retired.test.js | 1／3 | 1／3 | 2 題失敗相同 |
| 整個 `hub/test`（逐檔） | 316 檔：3955 題，2425 過／1475 失敗／55 跳過；200 檔結束碼非 0 | 317 檔：3985 題，2414 過／1516 失敗／55 跳過；199 檔結束碼非 0 | 改動前後各用 `git archive` 的副本樹，6 路平行、每檔 180 秒上限；見下方說明 |

全套逐檔比對（`D:\HubTest\tmp\codex_sandbox_pr\baseline-p\suite.csv` 對 `after-p\suite.csv`）只有 9 檔不同：1 檔是新測試（6／6）；`text-budget.test.js`（結束碼 124→1）與 `update-isolation-generation.test.js`（3／4→3／3）改動後較好；其餘 6 檔（`idea-erasure`、`idea-lifecycle`、`maintenance`、`queue-retreat`、`task-continue`、`task-history-auto`）兩邊結束碼都是 124（180 秒逾時被截斷），題數差異只是逾時前跑到哪裡。把其中看起來「變差」的 4 檔在兩棵副本樹各自**單獨**重跑（300 秒上限、不與其他檔搶 CPU）：`task-continue` 兩邊都是 20 題 16 過 4 失敗、`task-history-auto` 兩邊都是 25 題 21 過 4 失敗、`queue-retreat` 兩邊都是 27 題 12 過 15 失敗（仍逾時）、`idea-erasure` 兩邊都逾時而改動後反而多跑完 13 題。失敗原因都是同一個與本 PR 無關的訊息「Windows補助の確認を実行できません」。通過數 2425→2414 的差（−11）就是 `task-continue`（−14）與 `task-history-auto`（−20）這兩檔在平行跑時被截斷造成的，單獨重跑即消失。結論：沒有可歸因於本次改動的退步。Windows 上大量失敗是因為沒有作者的 macOS 執行器與 Mac 專屬原生功能，改動前就是如此。

真機修正（`:root`、`.git`="deny"、glob）只改了 profile 常數與測試期望，上表前 6 檔重跑一次（log 在 `D:\HubTest\tmp\codex_sandbox_pr\after2\`）數字完全相同；11-04 的逾時收尾改動後再重跑一次（log 在 `…\after3\`），同樣相同；全套沒有再跑第二次。

另外在 Git Bash 上實測：`bash.exe -c "cd 'D:\…\it'\''s here' && printf hello > local.txt; cat local.txt"` 搭配上面的最小環境可正確執行，`HOME` 落在工作區根目錄，路徑含單引號也正確（這就是 `chatgpt.js` 包命令的方式）。這題改用 `pwd -W` 取 Windows 路徑來比對：當測試暫存目錄正好是 MSYS 的 `/tmp` 掛載點時，`$HOME` 會顯示成 `/tmp/…`，原本的字串比對在不改 `TEMP` 的機器上會誤判失敗。

### 5.1 送 PR 前建議 JAY 在真機補做（本次未做的部分）

1. 啟動 Hub（開發版、非安裝版），建一個 ChatGPT 子作業，透過 `hub_run_command` 實際走 HTTP 路由與 ChatGPT 工具呼叫跑一次（本次只直接呼叫 `WorkspaceSandbox.run()`，沒有經過 Hub 伺服器與 ChatGPT）。
2. 在一台**沒有**做 `codex sandbox setup --elevated` 的機器上跑一次，記下 codex 非 0 結束時的 stderr 原文，放進 PR 說明。
3. 在 Mac 上跑作者的 `node hub/test/run.cjs`，確認新測試檔在 macOS 下通過（7 題中 3 題標 Windows only 會 skip）。
4. 若作者在意 0.154.0：用 0.154.0 的 codex.exe 跑第 5.2 節的基本命令，確認 `":root"` 也被接受。

### 5.2 真機驗證（2026-11-03，已做）

直接呼叫 `codex sandbox`（探測後端與語法）：

| 組合 | 結果 |
| --- | --- |
| elevated＋`":minimal"="read"`（初版） | 失敗：「elevated Windows sandbox requires effective `:root` read access」；加 D: 的 `features.windows_sandbox_service=false`、`windows.allow_mxc=false` 也一樣 |
| elevated＋`":root"="read"` | 成功，以 `CodexSandboxOffline` 執行 |
| unelevated＋`":minimal"` | 失敗：「Restricted read-only access requires the elevated Windows sandbox backend」 |
| unelevated＋`":root"` | bash.exe 起不來：`CreateFileMapping … Win32 error 5` |
| `.git`="deny" | 讀、寫、列目錄都 Permission denied |
| `<root>\**\.env*`、`*.pem`、`id_rsa*`、`**\.git`（正斜線或反斜線分隔） | 命中的檔案都 Permission denied；`.ENV`、`CERT.PEM` 也命中；巢狀 `.git` 也命中 |
| readFile="read"（放在關掉繼承、沙箱原本讀不到的資料夾） | 無授權讀不到；授權後讀得到、寫不進（Permission denied）；檔案多一條 `CodexSandboxUsers:(RX)` |

經 `hub/lib/workspace-sandbox.js` 的 `WorkspaceSandbox.run()`＋真實 win32 平台層（也就是 Hub 實際走的路徑，只差沒經過 HTTP 與 ChatGPT）：

| 項目 | 命令 | 結果 |
| --- | --- | --- |
| Hub 形狀的命令 | `cd '<root>' && ls -la; pwd; pwd -W; whoami; git status` | exit 0；`whoami`＝`CodexSandboxOffline`；`pwd`＝`/tmp`、`pwd -W`＝工作區；`git status` 因 `.git` 拒讀而失敗（同 Mac） |
| 寫入邊界 | 工作區內新檔、`.git\w`、`..\o.txt`、`C:\Users\Public\…`、`D:\…` | 工作區內 rc=0；其餘 Permission denied |
| 秘密檔 | `.env`、`key.pem`、`.git\HEAD`、`sub\nested\.git\HEAD`、`sub\id_rsa`、`sub\CERT.PEM`、`.ENV` | 全部 Permission denied；`hello.txt` 正常；`echo z > .env` 被擋；`rm key.pem` 成功（第 4 節第 3 點） |
| 網路 | `curl -m 5 https://example.com`、`curl http://1.1.1.1` | 都 rc=7（連不上） |
| 環境 | `env` | 只有 PASSTHROUGH、固定值、libuv 補的使用者變數、Codex 加的 `GIT_CONFIG_*`／`PAGER`；無 `HUB_*`、無 key |
| 輸出上限 | 200 KB base64 | `truncated: true`，stdout 截在 64 KB |
| 結束碼與 stderr | `echo out; echo err >&2; exit 7` | `code: 7`，stdout／stderr 分開 |
| 逾時（11-03，無沙箱內包裝） | `timeoutMs=3000` 跑 `sleep 120` | 4.7 秒後解析 `code: 1, signal: null`；codex.exe 與沙箱 bash 消失；`sleep.exe` 留到 120 秒自然結束 |
| 逾時（11-04，沙箱內 `timeout` 包裝） | `timeoutMs=3000` 與 `6000` 跑 `sleep 120 & node -e "setTimeout(() => {}, 120000)" & wait` | 4.6／8.6 秒後解析 `code: 1, signal: null`；執行中（+3.1 秒）列得出沙箱帳號的 `bash`／`timeout`／`sleep`；解析後 +0.5 秒起沙箱名下沒有任何行程，追到 120 秒都沒有（第 4 節第 5 點） |
| 正常命令（包裝後） | `git --version; echo "$MSYSTEM\|$(command -v timeout)\|$HOME\|$(pwd -W)"; exit 3` | `code: 3`；`git version 2.54.0.windows.1`、`MINGW64`、`/usr/bin/timeout`、`/tmp`、工作區路徑；2.3 秒 |
| 並行 | 同一工作區 3 路、不同工作區 2 路 | 都正常，各約 3 秒／2 秒 |
| 延遲 | 新工作區連跑 3 次 | 1.85／1.67／1.78 秒 |
| 兩萬檔工作區 | 無 glob 對 13 條 glob | 1.66 秒對 1.87～2.06 秒 |

ACL 觀察（真機）：工作區根 `CodexSandboxUsers:(OI)(CI)(M)`；`.git` 與 glob 命中檔 `(DENY)(R)`；readFile `(RX)`；沙箱建立的檔案擁有者 `CodexSandboxOffline`；`D:\` 根目錄預設 ACL（`Authenticated Users:(M)`、`Users:(RX)` 可繼承）決定了沙箱讀得到 D: 上其他預設 ACL 的資料夾。

逾時包裝不經 Codex、只用 Git for Windows 的實測（11-04，`timeout --kill-after=2 1s`）：`sleep` 背景／前景、`node` 背景／前景、巢狀 `bash -c "sleep 30"`、`trap "" TERM; sleep 30` 六種都在上限結束（約 1.1 秒；`trap` 那種 3.1 秒由 KILL 收尾，結束碼 2304＝被信號 9 結束）。對照：把 `Git\bin\bash.exe` 直接當 `timeout.exe` 的子行程，六種都收不掉（8 秒上限才被 `spawnSync` 強制返回），因為啟動器是原生程式、真正的 MSYS bash 不在群組裡；直接用 `usr\bin\bash.exe` 當子行程收得掉，但會少掉啟動器設定的 `MSYSTEM`、`/mingw64/bin`（`git` 找不到）。所以採用「啟動器建好的 shell 內 `exec /usr/bin/timeout … /usr/bin/bash -c "$0"`」：環境完整（`MSYSTEM=MINGW64`、`git`＝`/mingw64/bin/git`、`timeout`＝`/usr/bin/timeout`）、結束碼照常傳回、含單引號／雙引號／`$HOME`／反引號的命令原樣傳入。

## 6. 新測試檔涵蓋

`hub/test/platform-win32-command-sandbox.test.js`（全部用 fixture fs／env，不碰真實磁碟與原生呼叫；前 4 題在 macOS 也會跑）：

1. 沒有 Codex／沒有 bash／沒有 coreutils `timeout.exe`／`.cmd` 殼但沒有 vendored 執行檔／manifest 不是 `@openai/codex`／`.bat` 殼 → `available()` 為 false，`spawn()` 丟 `command_sandbox_unavailable`；三者齊備 → true；hoisted 版型、PATH 上直接的 `codex.exe`、`timeout.exe` 與 shell 同目錄的版型都能解析。
2. `profile()` 的完整 argv（含 TOML 字串逐字比對：`":root"`、`.git`="deny"、13 條 glob deny、readFile）、`SECRET_GLOBS` 凍結且內容固定、readFiles 去重與濾掉工作區內的路徑、凍結、各種壞路徑（相對、UNC、ADS、`..`、引號、換行、NUL、POSIX、非字串）都丟 `command_sandbox_path`。
3. `spawn()`：檔案是 vendored codex.exe、argv 尾端是 `-- bash.exe -c <command>`、cwd／windowsHide／stdio／無 detached／無 shell、環境變數鍵集合逐一比對、`HOME／TEMP／TMP` 是工作區、PATH 三段、任何 `private` 值都沒漏進去；`{ timeoutMs: 120000 }`／`50` → 尾端變成 `-c 'exec /usr/bin/timeout --kill-after=2 120s（1s） /usr/bin/bash -c "$0"' <command>`（`limitScript()` 字串逐字比對），`0`、非數字、沒傳 → 不包裝；空命令、含 NUL、profile 與 root 不符、profile 不是物件 → 各自的錯誤碼。
4. `WorkspaceSandbox` 在 `killTree` 丟錯時仍能：正常結束解析結果、逾時時 `child.kill('SIGKILL')` 收尾、`stop()` 不丟。
5.（Windows only）用真實暫存目錄當工作區，整條 `WorkspaceSandbox → win32 adapter → spawn fixture` 走一遍；`timeoutMs: 45000` 到了 argv 尾端變成 `45s` 的包裝。
6.（Windows only，且需 Codex 與 bash 都在，否則 skip）不經 Codex，直接用 argv 尾端的 `bash.exe -c <20 秒包裝> <command>` 與最小環境真跑一次（真的經過 coreutils `timeout`）；`HOME` 用 `pwd -W` 取 Windows 路徑比對，不受 MSYS `/tmp` 掛載點影響。
7.（Windows only，同上）`timeoutMs: 1000` 跑 `sleep 30 & node -e "setTimeout(() => {}, 30000)" & wait` 與 `trap "" TERM; sleep 30`：`spawnSync` 要等所有持有輸出管線的行程都結束才返回，斷言 10 秒內返回、結束碼非 0、只印出 `started`。

## 7. 日文概要（PR 本文用）

**タイトル案**：Windows: Codex CLI の sandbox で `commandSandbox` を実装（ChatGPT 子作業のコマンド隔離実行）

**概要**

4.126.95 の `hub/lib/platform/win32.js` は `commandSandbox` を `available: () => false` に固定しており、`WorkspaceSandbox.run()` は Windows で常に「Windowsでは未対応」を返します。この PR は Windows プラットフォーム層に `commandSandbox` の `available()/profile()/spawn()` を実装し、OS 境界として Codex CLI 付属の `codex sandbox` サブコマンド（elevated 方式）を使います。`darwin.js` の `sandbox-exec` プロファイルと同じ方針で、作業フォルダだけ書込み可、`.git` と秘密ファイル（`.env*`、`*.pem` など）は読み書き不可、指定ファイルは読み取り可、ネットワーク無効、コマンドは Git for Windows の `bash.exe -c` で実行します。タイムアウト時はサンドボックス内でも coreutils `timeout` が同じ上限を掛け、コマンドをプロセスグループごと終了させます。Windows 11 x64 の実機（Codex 0.164.0、`codex sandbox setup --elevated` 済み）で `WorkspaceSandbox.run()` から実際に動作確認しました。Issue #8 の (a) の最小の一片で、Claude／Grok・ブラウザログイン・資格情報 ACL・インストーラ・バージョン固定は含みません。

**変更点**

- `hub/lib/platform/win32-command-sandbox.js`（新規）：`findExecutable('codex')` で見つかった `codex.exe`、または npm の `codex.cmd` から vendored の `codex.exe` を解決（cmd.exe は経由しない）。プロファイルは固定の `-c permissions.project-hub-command.filesystem={…}`（読み取り基底 `":root"`、作業フォルダ `write`、`.git` と秘密ファイルの glob は `deny`、指定ファイルは `read`）、`network.enabled=false`、`windows.sandbox="elevated"`。環境変数は最小限（Hub 設定・AI 資格情報は渡さない）、`HOME/TEMP/TMP` は作業フォルダ。`spawn()` は Hub の `timeoutMs` を受け取り、シェル内で `exec /usr/bin/timeout --kill-after=2 <秒>s /usr/bin/bash -c "$0"` の形でコマンドを渡します（コマンドは `$0` としてそのまま渡り、引用処理はありません。Git の `bin\bash.exe` ランチャーは MSYS bash を別のプロセスグループで起動するため、ランチャーの外側に `timeout` を置いても子プロセスは止まりません）。
- `hub/lib/platform/win32.js`：`commandSandbox` を初回利用時に読み込み（`supervisorFiles` は不変）。`shellCandidates` を共用化。
- `hub/lib/workspace-sandbox.js`：Windows の `killTree` は終了済みの子を拒否するため、`close` 後と停止時は `killTree` 失敗時に `child.kill('SIGKILL')` へ退避（`chatgpt.js` の `run()` と同じ形）。`run()` は `commandSandbox.spawn()` に第 5 引数 `{ timeoutMs }` を渡します（darwin は使いません）。Windows の拒否文言を前提条件の説明に変更。
- テスト：`hub/test/platform-win32-command-sandbox.test.js`（7 件）を追加。`platform-win32.test.js` と `platform-preparation.test.js` の Windows 拒否テストはホストの PATH に依存しないよう fixture 化。
- README（日・繁中）と `hub/app/windows/README.md` の前提条件の記述。

**既知の制限**

- `codex sandbox setup --elevated` を一度実行済みであることが前提。Codex 0.164.0 の elevated バックエンドは読み取り基底に `":root"` しか受け付けず（`":minimal"` は拒否）、unelevated では読み取り専用の切り出しも Git Bash の起動もできません。未設定の場合 Codex は非 0 で終了し（unsandboxed では実行しない）、Hub は事前に検出できません。
- 読み取り範囲は Mac より広く、サンドボックス用アカウントの NTFS ACL に従います（ユーザープロファイル直下は読めませんが、`D:\` のように既定 ACL が `Authenticated Users` に権限を与えるドライブ上の他フォルダは読めます）。`network.enabled=false` は実機で `curl` が接続できないことを確認済み。
- 秘密ファイルは読み取りと上書きを拒否しますが、削除（`rm`）はフォルダの Modify 権限で通ります。glob は起動時に展開されるため、実行中に作られたファイルは次回から対象になります。
- Codex はプロファイルを NTFS ACL の変更で実現し、実行後も元に戻しません（作業フォルダに `CodexSandboxUsers` の Modify、`.git` と秘密ファイルに deny、指定ファイルに RX）。サンドボックス内で作られたファイルの所有者は `CodexSandboxOffline` です。
- タイムアウト時に Hub が直接止められるのは codex.exe だけです（`run()` の結果は `code: 1, signal: null`）。サンドボックス内では coreutils `timeout` が同じ上限（秒に切り上げ）でコマンドのプロセスグループに TERM、2 秒後に KILL を送り、`sleep` や `node` の子が残らないことを実機で確認しました。自らプロセスグループを抜けたプロセスは対象外です。
- 1 コマンドあたり約 1.7～2.1 秒のオーバーヘッド（ACL 設定）があります。

**確認**

Windows 11 x64 / Node 24 で `platform-win32.test.js` 40/40、新規 7/7、`platform.test.js`・`platform-preparation.test.js`・`gpt-child.test.js`・`chatgpt-retired.test.js` は変更前後で同じ結果（失敗は Mac 専用または Windows の symlink 権限によるもの）。`hub/test` 全体の変更前後の件数は本文の表を参照。実機（Codex 0.164.0、setup 済み）では `WorkspaceSandbox.run()` 経由で、作業フォルダ内の書込み・外部への書込み拒否・`.git` と秘密ファイルの拒否・ネットワーク遮断・64 KB の出力上限・終了コード・タイムアウト（サンドボックス内の `sleep`／`node` が残らないこと）・並列実行を確認しました（本文 5.2 節）。Hub の HTTP 経路と ChatGPT からの呼び出しを通した確認は PR 前に実施予定。
