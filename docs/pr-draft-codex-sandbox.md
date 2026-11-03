# PR 草稿：Windows 平台層以 Codex CLI sandbox 實作 `commandSandbox`（只含 Codex 隔離執行）

> 狀態：草稿，尚未推送、尚未開 PR。給 kieiken/project-hub 的第一片 adapter PR。
> 基底：`refs/remotes/origin/main` 9f5f6b5（Project Hub 4.126.95）。
> 分支：`codex-sandbox-win32`（本機 worktree），程式碼 commit `b2608700`，commit 身分 `kf208016 <66252666+kf208016@users.noreply.github.com>`。
> 文末附日文概要，可直接貼進 PR 說明。

## 1. 這個 PR 做什麼

作者 4.126.95 的 `hub/lib/platform/win32.js` 第 121 行把 `commandSandbox` 固定為 `available: () => false`，所以 `hub/lib/workspace-sandbox.js` 在 Windows 一律以「Windowsでは未対応」拒絕 ChatGPT 子作業的 `hub_run_command`。

這個 PR 只做一件事：在 Windows 平台層補上 `commandSandbox` 的 `available()／profile()／spawn()` 三個合約，用 **Codex CLI 自帶的 `codex sandbox` 子命令**當作 OS 邊界，讓 `WorkspaceSandbox.run()` 在 Windows 可以執行命令。行為規格對齊 Mac 的 `darwin.js`（`sandbox-exec` profile）：只有工作區根目錄可寫、`.git` 不可寫、額外列出的檔案可讀、無網路、命令經 POSIX shell 執行。

不在這個 PR 裡：Claude／Grok 的隔離執行、瀏覽器登入、憑證 ACL、安裝程式、版本固定與專用副本（Issue #8 的 (b)(c)）、Windows 的 `hub/test/run.cjs` 執行器。

## 2. 為什麼這樣拆

- 作者在 PR #4 的規則：先開 Issue、以最新版為基底、按功能拆小 PR。Issue #8（10-26）提議的順序是 (a) Codex 隔離 → (b) Claude／Grok 隔離基盤 → (c) 版本固定與專用副本。這個 PR 是 (a) 裡最小、可獨立審的一片：只碰平台層與 `WorkspaceSandbox`，不改 HTTP 路由、不改授權政策（平台層合約明寫「never permission policy」）。
- D: 分支（windows-browser-mvp，基底 v4.68.2）直接合併到 4.126.95 有 60 檔 330 段衝突，不可行。D: 的 Codex 隔離是為「原生橋接」設計的（app-server `command/exec`、Job supervisor、root pin、版本雜湊），和作者 4.126.x 的 `commandSandbox` 合約（spawn 一個 ChildProcess、串流 stdout／stderr、回傳 exit code）形狀不同。這裡只移植 D: 已在真機驗證過的那條通道：`codex sandbox -C <root> -P <profile> --include-managed-config -c … -- <程式>`（D: `hub/lib/provider-sandbox.js`，PROVIDER-RUNTIME.md 記載「官方 `codex sandbox` 在本機能轉送 stdin／stdout／stderr，退出碼 0；此版 `-P` 為必要參數」）。
- 不搬 D: 的 Job supervisor（`managed-process.js`、C# job-runner）、root pin、`codex-versions.js` 雜湊白名單、`local-drives.js`：這些是 D: 原生橋接的安全層，作者的平台層已經有自己的 `killTree`（原生 snapshot＋所有權核對）與 `findExecutable`，先沿用作者的機制，把 D: 那些留給後續 PR 討論。

## 3. 改了哪些檔（9 檔，+236／−15）

| 檔案 | 改動 |
| --- | --- |
| `hub/lib/platform/win32-command-sandbox.js`（新，65 行） | Codex 沙箱 adapter：`create({fs, env, findExecutable, shellCandidates, spawn, execPath})` 回傳 `{available, profile, spawn, codexExecutable, shell}`。 |
| `hub/lib/platform/win32.js` | `commandSandbox` 改為延遲載入上面的模組（第一次呼叫才 `require`，`supervisorFiles` 不變，detached supervisor 不會載到它）；`shellCandidates` 提到函式外層讓 adapter 共用。其餘不動。 |
| `hub/lib/workspace-sandbox.js` | 新增 `kill(child)`：先 `platform.killTree(child,'SIGKILL')`，失敗時改 `child.kill('SIGKILL')`；`run()` 的逾時與 `close` 後清理、`stop()` 都走它。Windows 拒絕訊息改成「WindowsではCodex CLIの隔離実行（codex sandbox）とGit for Windowsが必要です。見つからないため、コマンドを実行しません」。 |
| `hub/test/platform-win32-command-sandbox.test.js`（新，6 題） | 見第 6 節。 |
| `hub/test/platform-win32.test.js` | 「unsupported Windows features」那題改用 fixture 的 fs／env（PATH 上什麼都沒有），不再依賴主機有沒有裝 Codex。 |
| `hub/test/platform-preparation.test.js` | 「Windows sandbox refusal」那題同上，改用 fixture 建 win32 adapter；訊息斷言改成 `/Codex CLIの隔離実行/`。 |
| `README.md`、`README.zh-TW.md`、`hub/app/windows/README.md` | 把「隔離実行は Windows 未対応」的句子改成前置條件說明（Codex CLI 的 sandbox 已做 `codex sandbox setup --elevated`、Git for Windows）。 |

### 3.1 `win32-command-sandbox.js` 的行為

- `available()`：同步、無副作用。`findExecutable('codex')` 找到 `codex.exe` 就直接用；找到 npm 的 `codex.cmd` 時，確認同目錄 `node_modules/@openai/codex/package.json` 的 `name` 是 `@openai/codex`，再取 vendored 的 `node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`（套件內或 hoisted 兩個位置）。`.bat` 或其他殼一律不展開。另需 `shellCandidates()` 的 `bash.exe` 存在。兩者齊備才回 `true`。**不執行 codex 來查版本**。
- `profile(root, readFiles)`：驗 `root` 與每個 readFile 是本機磁碟絕對路徑（`X:\`、無 NUL／換行／引號、無 ADS、無 `..`）。回傳凍結物件 `{root, readFiles, args}`，`args` 固定為：

  ```
  sandbox -C <root> -P project-hub-command --include-managed-config
    -c permissions.project-hub-command.filesystem={":minimal"="read","<root>"="write","<root>\.git"="read",<每個 readFile>="read"}
    -c permissions.project-hub-command.network.enabled=false
    -c windows.sandbox="elevated"
  ```

  在 `root` 底下的 readFile 會被濾掉（在可寫根裡再加 read 會變成唯讀 carve-out，反而限制寫入）。路徑用 `JSON.stringify` 當 TOML basic string（跳脫規則相容）。
- `spawn(command, root, profile, spawnProcess)`：驗 command 非空、profile 是上面 `profile()` 產出且 `root` 一致；再確認 codex 與 bash 都在，否則丟 `command_sandbox_unavailable`。實際呼叫：

  ```
  spawnProcess(realpath(codex.exe), [...profile.args, '--', <bash.exe>, '-c', command],
    { cwd: root, env: <最小環境>, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  ```

  最小環境只放 `SystemRoot、SystemDrive、windir、ComSpec、PATHEXT、USERPROFILE、APPDATA、LOCALAPPDATA、ProgramFiles、ProgramFiles(x86)、NUMBER_OF_PROCESSORS、PROCESSOR_ARCHITECTURE、CODEX_HOME`（有值才放），加上固定的 `PATH=System32;Git\bin;<node 目錄>`、`HOME=TEMP=TMP=<root>`、`LANG=en_US.UTF-8`。Hub 的 `HUB_*`、帳號變數、`OPENAI_API_KEY` 等 AI 憑證一律不進去。對齊 Mac 的 `HOME: root, TMPDIR: root`。Git Bash 會自己把 `/usr/bin`、`/mingw64/bin` 加進 PATH，所以 `cat`、`printf`、`git` 都找得到（已實測）。
- 用 `fs.realpathSync.native` 取 codex.exe 的正規路徑再 spawn：作者的 win32 `killTree` 會用 `findExecutable(child.spawnfile)` 和 kernel 的 image path 比對。

### 3.2 為什麼要動 `workspace-sandbox.js`

作者的 `run()` 在 `close` 事件後會再呼叫一次 `killTree(child)`（Mac 用來掃 detached process group）。Windows 的 `killTree` 對已結束的子行程會丟「Windowsの起動した子プロセスを確認できません」，在事件處理器裡丟出去就是 uncaught exception。`chatgpt.js` 自己的 `run()` 已有同樣寫法（`try { killTree } catch { child.kill }`），這裡比照。Mac 行為不變：darwin 的 `killTree` 預設有 fallback、不會丟。

## 4. 已知限制（請審閱者特別看）

1. **需要先做一次 `codex sandbox setup --elevated`**（需系統管理員，一次性）。Codex 0.164.0 的 `windows.sandbox` 可接受 `elevated／unelevated／mxc`；唯讀 carve-out（`.git`="read"）與拒讀規則都要 elevated 後端，unelevated 會回「refusing to run unsandboxed」。沒做 setup 時，codex 會以非 0 結束並在 stderr 說明；Hub 在 spawn 前**無法**偵測 setup 狀態（不執行 codex 就查不到），所以 `available()` 只看檔案存在。結果是：命令「失敗」而不是「拒絕」，ChatGPT 會拿到 exit code 與 stderr。
2. **秘密檔案的拒讀沒有對齊 Mac**。Mac profile 用 regex 拒絕 `.env*、.netrc、.npmrc、.pypirc、id_rsa*、*.pem／.key／.p12／.pfx` 的讀寫，也拒絕 `.git` 的讀。Codex 的 filesystem permission 是路徑式、無樣式比對；本 PR 只把 `.git` 設成唯讀（寫被擋、讀不擋），其他秘密檔沒有額外規則。Codex 0.164.0 有 `deny` 值（拒讀，需 elevated），可在真機驗證後補 `.git`="deny" 與已知秘密路徑；這裡沿用 D: 真機驗過的 `"read"`。ChatGPT 的檔案工具仍由 `resolveWorkspace` 的 `SECRET` 規則擋住。
3. **讀取範圍比工作區大**：`":minimal"="read"` 是 Codex 的最小系統讀取集合；D: 的紀錄是「Read access is broader than the task directory」、「networkAccess=false 不是完整的網路邊界」。這和 Mac 允許讀 `/System、/usr、/bin、/sbin、/Library` 的精神一致，但不應宣稱比 Mac 更嚴。
4. **逾時與停止**：`WorkspaceSandbox` 逾時會 `killTree(codex.exe)`；作者的 win32 `killTree` 只列舉同 SID 的子孫，沙箱內的行程跑在 CodexSandbox 專用帳號（不同 SID），不在列舉內。清理依賴 Codex 自己的 job／cleanup。本次沒有執行 provider CLI，這點**未在真機驗證**。
5. **沒有版本下限檢查**。D: 在真機驗過 0.154.0 的 `codex sandbox -P`；0.164.0 的二進位字串確認有同樣的旗標與 `permissions.<profile>.filesystem`。更舊的 Codex 不認 `-P` 時會以非 0 結束，不會退回無沙箱執行。本次**沒有**用 Hub 實際啟動 `codex sandbox` 跑過這組 profile（限制：此工作階段不執行 provider CLI）。
6. `hub/test/gpt-child.test.js` 的真 OS 題（「sandboxは子内だけを書ける…」）只在作者的 macOS 執行器下有意義；在 Windows 改動前後都因 fixture 原因（「GPT子の専用作業用コピーが必要です」）失敗，與本 PR 無關。
7. `hub/test/run.cjs` 要求 macOS `sandbox-exec`，Windows 上無法用官方執行器；本次用 `node --test --test-force-exit <檔>` 逐檔跑。
8. **Codex 的安裝版型只認兩種**：PATH 上直接的 `codex.exe`，或 npm 全域的 `codex.cmd`（旁邊有 `node_modules/@openai/codex`）。pnpm／bun／Vite+ 的全域版型、或 `.bat`／`.ps1` 殼，一律視為未安裝（fail closed），不會退回 cmd.exe。

## 5. 怎麼驗證（本次已做）

環境：Windows 11 Pro 10.0.26200、Node v24.15.0、Git for Windows（`C:\Program Files\Git\bin\bash.exe`）、npm 全域 `@openai/codex` 0.164.0（只讀檔案位置與字串，未執行）。`TEMP／TMP` 指到 `D:\HubTest\tmp\codex_sandbox_pr\…`，不碰 4545／4546、真實 `~/.codex`、已安裝的 ProjectHub。

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

| 測試檔 | 改動前（9f5f6b5） | 改動後（b2608700） | 說明 |
| --- | --- | --- | --- |
| platform-win32-command-sandbox.test.js（新） | — | 6／6 通過 | 含真機 Git Bash 一題 |
| platform-win32.test.js | 40／40 | 40／40 | |
| platform.test.js | 11／16 | 11／16 | 5 題失敗相同：Mac 專屬（`ps`、`/usr/bin/swift`…）與 Windows 無 symlink 權限 |
| platform-preparation.test.js | 9／10 | 9／10 | 1 題失敗相同：Darwin／Linux UID |
| gpt-child.test.js | 6／15 | 6／15 | 9 題失敗相同：見第 4 節第 6 點 |
| chatgpt-retired.test.js | 1／3 | 1／3 | 2 題失敗相同 |
| 整個 `hub/test`（逐檔） | 316 檔：3955 題，2425 過／1475 失敗／55 跳過；200 檔結束碼非 0 | 317 檔：3985 題，2414 過／1516 失敗／55 跳過；199 檔結束碼非 0 | 改動前後各用 `git archive` 的副本樹，6 路平行、每檔 180 秒上限；見下方說明 |

全套逐檔比對（`D:\HubTest\tmp\codex_sandbox_pr\baseline-p\suite.csv` 對 `after-p\suite.csv`）只有 9 檔不同：1 檔是新測試（6／6）；`text-budget.test.js`（結束碼 124→1）與 `update-isolation-generation.test.js`（3／4→3／3）改動後較好；其餘 6 檔（`idea-erasure`、`idea-lifecycle`、`maintenance`、`queue-retreat`、`task-continue`、`task-history-auto`）兩邊結束碼都是 124（180 秒逾時被截斷），題數差異只是逾時前跑到哪裡。把其中看起來「變差」的 4 檔在兩棵副本樹各自**單獨**重跑（300 秒上限、不與其他檔搶 CPU）：`task-continue` 兩邊都是 20 題 16 過 4 失敗、`task-history-auto` 兩邊都是 25 題 21 過 4 失敗、`queue-retreat` 兩邊都是 27 題 12 過 15 失敗（仍逾時）、`idea-erasure` 兩邊都逾時而改動後反而多跑完 13 題。失敗原因都是同一個與本 PR 無關的訊息「Windows補助の確認を実行できません」。通過數 2425→2414 的差（−11）就是 `task-continue`（−14）與 `task-history-auto`（−20）這兩檔在平行跑時被截斷造成的，單獨重跑即消失。結論：沒有可歸因於本次改動的退步。Windows 上大量失敗是因為沒有作者的 macOS 執行器與 Mac 專屬原生功能，改動前就是如此。

另外在 Git Bash 上實測：`bash.exe -c "cd 'D:\…\it'\''s here' && printf hello > local.txt; cat local.txt"` 搭配上面的最小環境可正確執行，`HOME` 落在工作區根目錄，路徑含單引號也正確（這就是 `chatgpt.js` 包命令的方式）。

### 5.1 送 PR 前建議 JAY 在真機補做（本次未做）

1. 已做過 `codex sandbox setup --elevated` 的機器上，啟動 Hub（開發版、非安裝版），建一個 ChatGPT 子作業，透過 `hub_run_command` 跑：
   - `printf hello > local.txt; cat local.txt` → exit 0、輸出 hello、檔案在子作業工作區。
   - 寫到父作業、本體、`.git` 底下 → exit 非 0、檔案沒變。
   - `node -e 'require("net").createConnection({host:"127.0.0.1",port:1})…'` → EPERM 或連線失敗。
2. 跑一個 `sleep 200` 讓 `WorkspaceSandbox` 逾時（預設 120 秒），確認 codex.exe 與沙箱內 bash 都消失。
3. 在 Mac 上跑作者的 `node hub/test/run.cjs`，確認新測試檔在 macOS 下通過（6 題中 2 題標 Windows only 會 skip）。

## 6. 新測試檔涵蓋

`hub/test/platform-win32-command-sandbox.test.js`（全部用 fixture fs／env，不碰真實磁碟與原生呼叫；前 4 題在 macOS 也會跑）：

1. 沒有 Codex／沒有 bash／`.cmd` 殼但沒有 vendored 執行檔／manifest 不是 `@openai/codex`／`.bat` 殼 → `available()` 為 false，`spawn()` 丟 `command_sandbox_unavailable`；兩者齊備 → true；hoisted 版型與 PATH 上直接的 `codex.exe` 都能解析。
2. `profile()` 的完整 argv（含 TOML 字串逐字比對）、readFiles 去重與濾掉工作區內的路徑、凍結、各種壞路徑（相對、UNC、ADS、`..`、引號、換行、NUL、POSIX、非字串）都丟 `command_sandbox_path`。
3. `spawn()`：檔案是 vendored codex.exe、argv 尾端是 `-- bash.exe -c <command>`、cwd／windowsHide／stdio／無 detached／無 shell、環境變數鍵集合逐一比對、`HOME／TEMP／TMP` 是工作區、PATH 三段、任何 `private` 值都沒漏進去；空命令、含 NUL、profile 與 root 不符、profile 不是物件 → 各自的錯誤碼。
4. `WorkspaceSandbox` 在 `killTree` 丟錯時仍能：正常結束解析結果、逾時時 `child.kill('SIGKILL')` 收尾、`stop()` 不丟。
5.（Windows only）用真實暫存目錄當工作區，整條 `WorkspaceSandbox → win32 adapter → spawn fixture` 走一遍。
6.（Windows only，且需 Codex 與 bash 都在，否則 skip）不經 Codex，直接用 argv 尾端的 `bash.exe -c <command>` 與最小環境真跑一次。

## 7. 日文概要（PR 本文用）

**タイトル案**：Windows: Codex CLI の sandbox で `commandSandbox` を実装（ChatGPT 子作業のコマンド隔離実行）

**概要**

4.126.95 の `hub/lib/platform/win32.js` は `commandSandbox` を `available: () => false` に固定しており、`WorkspaceSandbox.run()` は Windows で常に「Windowsでは未対応」を返します。この PR は Windows プラットフォーム層に `commandSandbox` の `available()/profile()/spawn()` を実装し、OS 境界として Codex CLI 付属の `codex sandbox` サブコマンド（elevated 方式）を使います。`darwin.js` の `sandbox-exec` プロファイルと同じ方針で、作業フォルダだけ書込み可、`.git` は読み取り専用、指定ファイルは読み取り可、ネットワーク無効、コマンドは Git for Windows の `bash.exe -c` で実行します。Issue #8 の (a) の最小の一片で、Claude／Grok・ブラウザログイン・資格情報 ACL・インストーラ・バージョン固定は含みません。

**変更点**

- `hub/lib/platform/win32-command-sandbox.js`（新規）：`findExecutable('codex')` で見つかった `codex.exe`、または npm の `codex.cmd` から vendored の `codex.exe` を解決（cmd.exe は経由しない）。プロファイルは固定の `-c permissions.project-hub-command.filesystem={…}`、`network.enabled=false`、`windows.sandbox="elevated"`。環境変数は最小限（Hub 設定・AI 資格情報は渡さない）、`HOME/TEMP/TMP` は作業フォルダ。
- `hub/lib/platform/win32.js`：`commandSandbox` を初回利用時に読み込み（`supervisorFiles` は不変）。`shellCandidates` を共用化。
- `hub/lib/workspace-sandbox.js`：Windows の `killTree` は終了済みの子を拒否するため、`close` 後と停止時は `killTree` 失敗時に `child.kill('SIGKILL')` へ退避（`chatgpt.js` の `run()` と同じ形）。Windows の拒否文言を前提条件の説明に変更。
- テスト：`hub/test/platform-win32-command-sandbox.test.js`（6 件）を追加。`platform-win32.test.js` と `platform-preparation.test.js` の Windows 拒否テストはホストの PATH に依存しないよう fixture 化。
- README（日・繁中）と `hub/app/windows/README.md` の前提条件の記述。

**既知の制限**

- `codex sandbox setup --elevated` を一度実行済みであることが前提。未設定の場合 Codex は非 0 で終了し（unsandboxed では実行しない）、Hub は事前に検出できません。
- Mac プロファイルの秘密ファイル拒否（`.env`、`*.pem` など）は Codex のパス単位の権限では表現できず、本 PR では `.git` の読み取り専用のみ。0.164.0 の `deny` は実機確認後に追加候補。
- 読み取り範囲は `:minimal` で作業フォルダより広く、`network.enabled=false` は完全なネットワーク境界ではありません。
- タイムアウト時の停止は直接の子（codex.exe）に対して行い、サンドボックス内プロセスの後始末は Codex 側に依存（実機未確認）。

**確認**

Windows 11 x64 / Node 24 で `platform-win32.test.js` 40/40、新規 6/6、`platform.test.js`・`platform-preparation.test.js`・`gpt-child.test.js`・`chatgpt-retired.test.js` は変更前後で同じ結果（失敗は Mac 専用または Windows の symlink 権限によるもの）。`hub/test` 全体の変更前後の件数は本文の表を参照。実機での Codex 実行（setup 済み環境での書込み・ネットワーク・タイムアウト確認）は PR 前に実施予定。
