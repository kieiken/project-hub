// Project Hub のアプリ本体（Mac 用）
// - ダブルクリックで起動。ターミナルの窓は出ない
// - 本体（node server.js）が動いていなければ、自分で起動する
// - Mac 内蔵の WebKit で画面を出す
// - 何か失敗したら、黙らずに画面に理由を出す。記録は ~/Library/Logs/ProjectHub.log
import Cocoa
import WebKit
import UniformTypeIdentifiers


let home = FileManager.default.homeDirectoryForCurrentUser.path
let logPath = home + "/Library/Logs/ProjectHub.log"
let storageGuard = ProcessInfo.processInfo.environment["HUB_STORAGE_GUARD"]
    ?? (Bundle.main.object(forInfoDictionaryKey: "HubStorageGuard") as? String) ?? ""
let configuredHubRoot = (Bundle.main.object(forInfoDictionaryKey: "HubRoot") as? String) ?? ""
// Run before logging, reading the workspace, or starting Node. Unset means opt out.
func storageReady() -> Bool {
    if storageGuard.isEmpty { return true }
    let p = Process(); p.executableURL = URL(fileURLWithPath: storageGuard)
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
}


func log(_ s: String) {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
    let line = "[\(f.string(from: Date()))] \(s)\n"
    try? FileManager.default.createDirectory(atPath: home + "/Library/Logs", withIntermediateDirectories: true)
    if let h = FileHandle(forWritingAtPath: logPath) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
    } else {
        try? line.write(toFile: logPath, atomically: true, encoding: .utf8)
    }
}

// Info.plist に書いた本体の場所（build-app.sh が書き込む）
let hubLocation = (Bundle.main.object(forInfoDictionaryKey: "HubDir") as? String) ?? (home + "/Documents/AI-Workspace/System/ProjectHub/hub")
let hubDir = hubLocation.hasPrefix("@bundle/")
    ? Bundle.main.resourceURL!.appendingPathComponent(String(hubLocation.dropFirst("@bundle/".count))).path
    : hubLocation

func installedLanguage(_ requested: String) -> String {
    guard requested != "ja",
          requested.range(of: "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$", options: .regularExpression) != nil,
          let data = FileManager.default.contents(atPath: hubDir + "/locales/" + requested + "/pack.json"),
          let pack = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          pack["locale"] as? String == requested else { return "ja" }
    return requested
}
let hubLanguage = installedLanguage(ProcessInfo.processInfo.environment["HUB_LANG"]
    ?? (Bundle.main.object(forInfoDictionaryKey: "HubLanguage") as? String) ?? "ja")
let nativeMessages: [String: String] = {
    guard hubLanguage != "ja",
          let data = FileManager.default.contents(atPath: hubDir + "/locales/" + hubLanguage + "/native.json"),
          let messages = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return [:] }
    return messages
}()
let nativePlaceholderPattern = try! NSRegularExpression(pattern: "\\$\\{([0-9]+)\\}")
func tr(_ ja: String, _ values: String...) -> String {
    let message = nativeMessages[ja] ?? ja
    guard !values.isEmpty else { return message }
    var result = message
    for match in nativePlaceholderPattern.matches(in: message, range: NSRange(message.startIndex..., in: message)).reversed() {
        guard let numberRange = Range(match.range(at: 1), in: message),
              let index = Int(message[numberRange]), index < values.count,
              let range = Range(match.range, in: result) else { continue }
        result.replaceSubrange(range, with: values[index])
    }
    return result
}
let port = (Bundle.main.object(forInfoDictionaryKey: "HubPort") as? String) ?? "4545"
let baseURL = URL(string: "http://127.0.0.1:\(port)")!

// ログインした時と同じ PATH を取る（claude / codex / node の場所が分かるように）
func loginShellPath() -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lic", "printf '%s' \"$PATH\""]
    let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
    do { try p.run() } catch { return "" }
    p.waitUntilExit()
    let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    // 最後の行だけ使う（シェルの挨拶などを避ける）
    return s.split(separator: "\n").last.map(String.init) ?? ""
}

func findNode(path: String) -> String? {
    var dirs = path.split(separator: ":").map(String.init)
    dirs += ["/opt/homebrew/bin", "/usr/local/bin", home + "/.volta/bin", home + "/.local/bin"]
    let nvm = home + "/.nvm/versions/node"
    if let vs = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
        dirs += vs.sorted().reversed().map { nvm + "/" + $0 + "/bin" }
    }
    for d in dirs {
        let c = d + "/node"
        if FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    return nil
}

// 本体が動いているか。軽い /api/ping に聞き、何か答えが返れば動いているとみなす
// （前は一覧 /api/state に1.5秒で聞いていたため、台帳が大きいと「動いていない」と間違え、2つ目を起動して失敗していた）
func serverAlive() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var req = URLRequest(url: baseURL.appendingPathComponent("api/ping"))
    req.timeoutInterval = 4
    URLSession.shared.dataTask(with: req) { _, res, _ in
        ok = (res as? HTTPURLResponse) != nil
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 5)
    return ok
}
// 記録の最後の数行（止まった理由を画面に出すため）
func logTail(_ n: Int) -> String {
    guard let s = try? String(contentsOfFile: logPath, encoding: .utf8) else { return "" }
    return s.split(separator: "\n").suffix(n).joined(separator: "\n")
        .replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
}

// Mac の「ファイルとフォルダ」の許可（書類・デスクトップ・ダウンロード）
let privacyFolders: [(name: String, path: String, service: String)] = [
    (tr("書類"), home + "/Documents", "SystemPolicyDocumentsFolder"),
    (tr("デスクトップ"), home + "/Desktop", "SystemPolicyDesktopFolder"),
    (tr("ダウンロード"), home + "/Downloads", "SystemPolicyDownloadsFolder"),
]
// 中を読んでみる。まだ決めていなければ、ここで Mac が「アクセスを求めています」と確認を出す
func canRead(_ dir: String) -> Bool {
    return (try? FileManager.default.contentsOfDirectory(atPath: dir)) != nil
}
// 前に選んだ答え（許可しない など）を消す。次に読んだ時、確認がもう一度出る
func resetPrivacy() {
    let id = Bundle.main.bundleIdentifier ?? "local.projecthub"
    for f in privacyFolders {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        p.arguments = ["reset", f.service, id]
        do { try p.run(); p.waitUntilExit(); log("許可をやり直し: \(f.service)（\(p.terminationStatus)）") }
        catch { log("tccutil を動かせません: \(error)") }
    }
}

// 動いている本体が、台帳のフォルダを読めるか（前の起動のまま許可が効いていない時は false）
func serverCanRead() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var ok = true   // 答えが無い古い本体は、読めるものとして扱う
    var req = URLRequest(url: baseURL.appendingPathComponent("api/access"))
    req.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: req) { data, res, _ in
        if (res as? HTTPURLResponse)?.statusCode == 200, let d = data,
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let v = o["ok"] as? Bool { ok = v }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 2)
    return ok
}
// 本体を止めてもらう。AI が動いている時は断られる（false）
func quitServer(reason: String = "access") -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var req = URLRequest(url: baseURL.appendingPathComponent("api/quit"))
    req.httpMethod = "POST"
    req.setValue("1", forHTTPHeaderField: "X-Hub")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["reason": reason])
    req.timeoutInterval = 2
    URLSession.shared.dataTask(with: req) { _, res, _ in
        ok = ((res as? HTTPURLResponse)?.statusCode == 200)
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 3)
    if !ok { return false }
    for _ in 0..<30 { if !serverAlive() { return true }; Thread.sleep(forTimeInterval: 0.2) }
    return false
}

func page(_ title: String, _ body: String) -> String {
    return """
    <!doctype html><meta charset="utf-8"><title>Project Hub</title>
    <style>body{font-family:-apple-system,"Hiragino Sans",sans-serif;background:#eef0f3;color:#1c2230;margin:0;display:grid;place-items:center;height:100vh}
    .b{background:#fff;border:1px solid #dde1e8;border-radius:12px;padding:24px 28px;max-width:560px;line-height:1.7}
    h1{font-size:18px;margin:0 0 8px}code{background:#f1f3f7;padding:2px 6px;border-radius:4px;word-break:break-all}
    @media (prefers-color-scheme:dark){body{background:#121520;color:#e6e9f0}.b{background:#1a1e29;border-color:#2c3241}code{background:#222735}}</style>
    <div class="b"><h1>\(title)</h1>\(body)</div>
    """
}

// ファイル・フォルダを落とした時、本当の場所（パス）を画面に渡す
// （Web の画面だけでは、落とした物の場所が分からないため）。スクショの一時画像など場所の無い物は、これまでどおり画面に任せる
class DropWebView: WKWebView {
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if urls.isEmpty { return super.performDragOperation(sender) }
        let paths = urls.map { $0.path }
        guard let data = try? JSONSerialization.data(withJSONObject: paths), let json = String(data: data, encoding: .utf8) else { return false }
        evaluateJavaScript("window.hubNativeDrop && window.hubNativeDrop(\(json))", completionHandler: nil)
        return true
    }
}

// 横に開く ChatGPT（ブラウザ版）。ログインは Mac に残る（次からはそのまま使える）
// Hub は ChatGPT の画面を操作しない。人が［コピー］を押した時だけ、その文を Hub に知らせる
class GptPanel: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    let web: WKWebView
    private var popupWindows: [ObjectIdentifier: NSWindow] = [:]
    private weak var copyPopupWindow: NSWindow?
    var onPopupCopyBoundary: (() -> Void)?
    override init() {
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: conf)
        super.init()
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        // 普通の Safari として開く（アプリの中の画面だと、ログインを断られることがあるため）
        web.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        web.load(URLRequest(url: URL(string: "https://chatgpt.com/")!))
    }
    // 渡された設定を使い、元の画面への window.opener / postMessage を保つ
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        let child = WKWebView(frame: .zero, configuration: c)
        child.customUserAgent = w.customUserAgent ?? web.customUserAgent
        child.navigationDelegate = self
        child.uiDelegate = self
        let popup = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 640),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        popup.title = "ChatGPT ログイン"
        popup.isReleasedWhenClosed = false
        popup.delegate = self
        popup.contentView = child
        popupWindows[ObjectIdentifier(child)] = popup
        copyPopupWindow = popup
        popup.center()
        popup.makeKeyAndOrderFront(nil)
        return child
    }
    func webViewDidClose(_ w: WKWebView) {
        popupWindows[ObjectIdentifier(w)]?.close()
    }
    func ownsPopupWindow(_ window: NSWindow) -> Bool {
        popupWindows.values.contains { $0 === window }
    }
    func windowDidBecomeKey(_ notification: Notification) {
        guard let popup = notification.object as? NSWindow, ownsPopupWindow(popup) else { return }
        copyPopupWindow = popup
    }
    func windowDidResignKey(_ notification: Notification) {
        guard let popup = notification.object as? NSWindow, copyPopupWindow === popup else { return }
        // 採取前に操作先を戻しても、小窓でのコピーを返事として拾わない
        onPopupCopyBoundary?()
        copyPopupWindow = nil
    }
    func windowWillClose(_ notification: Notification) {
        guard let popup = notification.object as? NSWindow, let child = popup.contentView as? WKWebView else { return }
        if copyPopupWindow === popup {
            onPopupCopyBoundary?()
            copyPopupWindow = nil
        }
        popupWindows.removeValue(forKey: ObjectIdentifier(child))
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKHTTPCookieStoreObserver {
    var window: NSWindow!
    var web: WKWebView!
    var updateTimer: Timer?
    var updateRequestInFlight = false
    var updateRelaunching = false
    var server: Process?
    var split: NSSplitView!
    var gpt: GptPanel?
    var clipTimer: Timer?
    var clipCount = NSPasteboard.general.changeCount

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        input.stringValue = defaultText ?? ""; alert.accessoryView = input
        alert.addButton(withTitle: tr("保存")); alert.addButton(withTitle: tr("キャンセル"))
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? input.stringValue : nil) }
    }

    // WebKitは標準のJavaScript確認ダイアログを自動では出さない。
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: tr("確認して進む")); alert.addButton(withTitle: tr("キャンセル"))
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        guard storageReady() else {
            let alert = NSAlert()
            alert.messageText = tr("データ用ディスクを使えません")
            alert.informativeText = tr("ストレージの確認に通りませんでした。データ用ディスクを接続してから、もう一度開いてください。")
            alert.runModal(); NSApp.terminate(nil); return
        }
        log("アプリを開きました（本体の場所: \(hubDir)）")
        let conf = WKWebViewConfiguration()
        conf.applicationNameForUserAgent = "ProjectHubApp/1"   // 画面側で「アプリの中」と分かるように
        web = DropWebView(frame: .zero, configuration: conf)
        web.navigationDelegate = self
        web.uiDelegate = self
        WKWebsiteDataStore.default().httpCookieStore.add(self)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Project Hub"
        window.minSize = NSSize(width: 720, height: 480)
        split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin
        split.addArrangedSubview(web)
        window.contentView = split
        window.center()
        window.setFrameAutosaveName("ProjectHubMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        buildMenu()
        updateTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.pollAppUpdate() }
        web.loadHTMLString(page(tr("起動しています…"), tr("<p>数秒お待ちください。</p>")), baseURL: nil)
        DispatchQueue.global().async { self.startAndLoad() }
    }

    func startAndLoad() {
        guard storageReady() else {
            showError(tr("データ用ディスクを使えません"), tr("<p>ディスクの確認に失敗したため、起動を止めました。</p>"))
            return
        }
        // 本体が台帳を読めている時は、その画面を先に開く。
        // 書類フォルダの確認がOS側で待たされても、稼働中の本体を表示できる。
        if serverAlive() && serverCanRead() {
            log("台帳を読める本体が動いています")
            DispatchQueue.main.async { self.web.load(URLRequest(url: baseURL)) }
            return
        }
        // 本体を新しく起動する時は、書類フォルダの許可を確かめる
        let workspace = ProcessInfo.processInfo.environment["HUB_ROOT"] ?? (configuredHubRoot.isEmpty ? home + "/Documents/AI-Workspace" : configuredHubRoot)
        let appCanRead = canRead(workspace)
        if !appCanRead { log("書類フォルダを読めません（許可が無い可能性）") }
        // 本体が前の起動のまま動いていて、許可が効いていない時は、止めてこのアプリから起動し直す
        if appCanRead && serverAlive() && !serverCanRead() {
            log("本体が書類フォルダを読めません。起動し直します")
            if !quitServer() { log("本体を止められませんでした（AI が作業中の可能性）。そのまま開きます") }
        }
        if serverAlive() {
            log("本体はすでに動いています")
            DispatchQueue.main.async { self.web.load(URLRequest(url: baseURL)) }
            return
        }
        let path = loginShellPath()
        log("PATH: \(path.isEmpty ? "（取れず）" : path)")
        guard let node = findNode(path: path) else {
            log("node が見つかりません")
            showError(tr("Node.js が見つかりません"), tr("<p><a href=\"https://nodejs.org\">https://nodejs.org</a> から入れてから、もう一度開いてください。</p>"))
            return
        }
        let serverJS = hubDir + "/server.js"
        // 実際に読んでみる（ここで Mac が「書類フォルダへのアクセス」の確認を出す）
        if FileManager.default.contents(atPath: serverJS) == nil {
            log("本体を読めません: \(serverJS)（書類フォルダの許可が必要な可能性）")
            showError(tr("本体のファイルを読めません"),
                      tr("<p>「システム設定 → プライバシーとセキュリティ → ファイルとフォルダ」で、<b>Project Hub</b> の「書類フォルダ」をオンにしてから、もう一度開いてください。</p><p>場所：<code>${0}</code></p>", serverJS))
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")!)
            }
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [serverJS]
        p.currentDirectoryURL = URL(fileURLWithPath: hubDir)
        var env = ProcessInfo.processInfo.environment
        env["HUB_LANG"] = hubLanguage
        let extra = [(node as NSString).deletingLastPathComponent, "/opt/homebrew/bin", "/usr/local/bin", home + "/.local/bin", home + "/.claude/local"]
        env["PATH"] = ([path] + extra + [env["PATH"] ?? "/usr/bin:/bin"]).filter { !$0.isEmpty }.joined(separator: ":")
        env["HUB_PORT"] = port
        if env["HUB_ROOT"] == nil && !configuredHubRoot.isEmpty { env["HUB_ROOT"] = configuredHubRoot }
        if !storageGuard.isEmpty { env["HUB_STORAGE_GUARD"] = storageGuard }
        let source = (hubDir as NSString).deletingLastPathComponent
        if FileManager.default.fileExists(atPath: source + "/.git") { env["HUB_UPDATE_SOURCE"] = source }
        env["HUB_UPDATE_APP"] = Bundle.main.bundleURL.path
        p.environment = env
        if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
        do {
            try p.run()
            server = p
            log("本体を起動しました（node: \(node)）")
        } catch {
            log("本体を起動できません: \(error)")
            showError(tr("本体を起動できません"), tr("<p>記録：<code>${0}</code></p>", logPath))
            return
        }
        for _ in 0..<50 {
            if serverAlive() {
                log("本体の準備ができました")
                DispatchQueue.main.async { self.web.load(URLRequest(url: baseURL)) }
                return
            }
            if !p.isRunning { break }
            Thread.sleep(forTimeInterval: 0.3)
        }
        log("本体が応答しません（本体は\(p.isRunning ? "動いています" : "止まりました（終了コード \(p.terminationStatus)）")）")
        let busyPort = logTail(8).contains("は使われています")
        showError(tr("本体が応答しません"), (busyPort ? "<p><b>前の本体が止まったまま残っています。</b>ターミナルで <code>pkill -f ProjectHub/hub/server.js</code> を実行してから、［再読み込み］（⌘R）を押してください。</p>" : "") + tr("<p>メニューの［再読み込み］（⌘R）で、もう一度試せます。直らない時は、下の記録を Claude に見せてください：<code>${0}</code></p><pre style=\"white-space:pre-wrap;font-size:12px;max-height:40vh;overflow:auto\">${1}</pre>", logPath, logTail(25)))
    }

    // This polls local status only. The server owns the persisted 24-hour GitHub limit.
    func pollAppUpdate() {
        guard !updateRequestInFlight && !updateRelaunching else { return }
        updateRequestInFlight = true
        var req = URLRequest(url: baseURL.appendingPathComponent("api/app-update"))
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] data, res, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.updateRequestInFlight = false
                guard (res as? HTTPURLResponse)?.statusCode == 200, let data = data,
                      let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      state["phase"] as? String == "installed", state["restartNeeded"] as? Bool == true else { return }
                self.updateRelaunching = true
                DispatchQueue.global().async {
                    // The server rejects this request if AI or queued work is active.
                    guard quitServer(reason: "update") else {
                        DispatchQueue.main.async { self.updateRelaunching = false }
                        return
                    }
                    DispatchQueue.main.async {
                        let config = NSWorkspace.OpenConfiguration()
                        config.createsNewApplicationInstance = true
                        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
                            DispatchQueue.main.async {
                                if let error = error {
                                    self.updateRelaunching = false
                                    log("更新したアプリを開けません: \(error)")
                                    DispatchQueue.global().async { self.startAndLoad() }
                                } else { NSApp.terminate(nil) }
                            }
                        }
                    }
                }
            }
        }.resume()
    }

    func showError(_ title: String, _ body: String) {
        DispatchQueue.main.async { self.web.loadHTMLString(page(title, body), baseURL: nil) }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        let reloadItem = appMenu.addItem(withTitle: tr("再読み込み"), action: #selector(reload), keyEquivalent: "r")
        reloadItem.target = self
        appMenu.addItem(withTitle: tr("記録を開く"), action: #selector(openLog), keyEquivalent: "l")
        let gptItem = appMenu.addItem(withTitle: tr("横の ChatGPT を開く・閉じる"), action: #selector(toggleGpt), keyEquivalent: "g")
        gptItem.keyEquivalentModifierMask = [.command, .shift]
        gptItem.target = self
        appMenu.addItem(withTitle: tr("ファイルの許可を確かめる…"), action: #selector(checkAccess), keyEquivalent: "")
        appMenu.addItem(withTitle: tr("ファイルの許可をやり直す（確認をもう一度出す）…"), action: #selector(redoAccess), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: tr("Project Hub を終了"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        // 編集メニュー（コピー・貼り付けを効かせる）
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: tr("編集"))
        edit.addItem(withTitle: tr("取り消す"), action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: tr("カット"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: tr("コピー"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        let pasteItem = edit.addItem(withTitle: tr("ペースト"), action: #selector(pasteFromMenu), keyEquivalent: "v")
        pasteItem.target = self
        edit.addItem(withTitle: tr("すべてを選択"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    // WKWebViewではファイル選択の窓をアプリ側で出す。
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.message = tr("参照する画像を選んでください（最大10枚）")
        panel.title = tr("画像を選ぶ")
        panel.prompt = tr("追加する")
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = ["png", "jpg", "jpeg", "webp", "gif", "heic"].compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    // スクショ・プレビューからの画像コピーをPNGにして渡す。文字の貼り付けはWebKitへ。
    @objc func pasteFromMenu() {
        // ログインの小窓では、その窓の入力欄へ通常どおり貼る
        if let keyWindow = NSApp.keyWindow, gpt?.ownsPopupWindow(keyWindow) == true {
            NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: self)
            return
        }
        // prompt の入力欄は WebKit ではなく、シートのフィールドエディタ。
        // ⌘V・編集メニューとも、名前を編集中ならその入力欄へ貼る。
        if let sheet = window.attachedSheet,
           let editor = sheet.firstResponder as? NSTextView, editor.isFieldEditor {
            editor.paste(self)
            return
        }
        // 横の ChatGPT を操作している時は、そちらにそのまま貼る（画像も ChatGPT 側が受け取る）
        if let g = gpt, let r = window.firstResponder as? NSView, r.isDescendant(of: g.web) {
            NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: self)
            return
        }
        let pasteboard = NSPasteboard.general
        if let image = NSImage(pasteboard: pasteboard), let tiff = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("hub-paste-" + UUID().uuidString + ".png")
            do {
                try png.write(to: url)
                web.callAsyncJavaScript("return window.hubNativePaste ? await window.hubNativePaste(paths) : false;",
                                        arguments: ["paths": [url.path]], in: nil, in: .page) { result in
                    // 始める欄へコピー済みの一時画像だけを片付ける。作業画面の参照元は残す。
                    if case .success(let value) = result, value as? Bool == true { try? FileManager.default.removeItem(at: url) }
                }
            } catch { log("貼り付け画像を保存できません: \(error)") }
            return
        }
        web.perform(#selector(NSText.paste(_:)), with: nil)
    }

    @objc func toggleGpt() { showGpt(gpt == nil || gpt!.web.superview == nil) }
    // 横の ChatGPT を開く・閉じる。開いている間だけ、ChatGPT の中でコピーした文を Hub に知らせる
    func showGpt(_ open: Bool) {
        if open {
            if gpt == nil {
                gpt = GptPanel()
                // 除外期間の更新回数だけを消費。コピーの中身は読まない
                gpt?.onPopupCopyBoundary = { [weak self] in self?.clipCount = NSPasteboard.general.changeCount }
            }
            guard let g = gpt, g.web.superview == nil else { return }
            split.addArrangedSubview(g.web)
            split.adjustSubviews()
            split.setPosition(split.bounds.width * 0.55, ofDividerAt: 0)
            clipCount = NSPasteboard.general.changeCount
            clipTimer?.invalidate()
            clipTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in self?.checkClip() }
            log("横の ChatGPT を開きました")
        } else {
            gpt?.web.removeFromSuperview()
            clipTimer?.invalidate(); clipTimer = nil
            log("横の ChatGPT を閉じました")
        }
    }
    func checkClip() {
        let pb = NSPasteboard.general
        if pb.changeCount == clipCount { return }
        clipCount = pb.changeCount
        // 新しいログイン小窓でコピーした内容は、Hub へ戻す対象に含めない
        if let keyWindow = NSApp.keyWindow, gpt?.ownsPopupWindow(keyWindow) == true { return }
        // ChatGPT の欄で操作していた時のコピーだけ（他のアプリや Hub の画面でのコピーは知らせない）
        guard let g = gpt, let r = window.firstResponder as? NSView, r.isDescendant(of: g.web),
              let text = pb.string(forType: .string), !text.isEmpty else { return }
        web.callAsyncJavaScript("window.hubGptClip && window.hubGptClip(text)", arguments: ["text": text], in: nil, in: .page, completionHandler: nil)
    }

    // Cookie の値は渡さず、ChatGPT のログイン済みの印の有無だけを知らせる
    func reportGptLogin() {
        let store = gpt?.web.configuration.websiteDataStore ?? WKWebsiteDataStore.default()
        store.httpCookieStore.getAllCookies { [weak self] cookies in
            let loggedIn = cookies.contains {
                let domain = $0.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
                return domain == "chatgpt.com" && $0.name.contains("session-token")
                    && ($0.expiresDate == nil || $0.expiresDate! > Date())
            }
            self?.web.callAsyncJavaScript("window.hubGptLogin && window.hubGptLogin(loggedIn)",
                                         arguments: ["loggedIn": loggedIn], in: nil, in: .page, completionHandler: nil)
        }
    }
    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) { reportGptLogin() }

    @objc func reload() {
        if serverAlive() { web.load(URLRequest(url: baseURL)) } else { DispatchQueue.global().async { self.startAndLoad() } }
    }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }

    // 画面から頼まれた場所を Finder で開く（フォルダはその中を、ファイルは選んだ状態で）
    func revealFromPage(_ u: URL) {
        let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let p = q.first(where: { $0.name == "path" })?.value, !p.isEmpty else { return }
        let isDir = q.first(where: { $0.name == "dir" })?.value == "1"
        let url = URL(fileURLWithPath: p, isDirectory: isDir)
        // open=1：Finder を通さず、ファイルをそのアプリ（.md ならテキスト、.png ならプレビュー）で開く
        if q.first(where: { $0.name == "open" })?.value == "1" {
            let ok = NSWorkspace.shared.open(url)
            log("アプリで開く: \(p)（\(ok ? "OK" : "失敗")）")
            return
        }
        log("Finder で開く: \(p)（\(isDir ? "フォルダ" : "ファイル")）")
        // まず Finder に直接頼む（AppleScript。初回は「Finder を制御することを許可」の確認が出る）。だめなら Mac の仕組み（NSWorkspace）で
        let quoted = p.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let body = isDir
            ? "tell application \"Finder\"\nactivate\nopen (POSIX file \"\(quoted)\" as alias)\nend tell"
            : "tell application \"Finder\"\nactivate\nreveal (POSIX file \"\(quoted)\" as alias)\nend tell"
        var err: NSDictionary?
        if let script = NSAppleScript(source: body) {
            _ = script.executeAndReturnError(&err)
            if err == nil { log("Finder に頼みました（AppleScript）"); return }
            log("AppleScript で開けません: \(err ?? [:])")
        }
        if isDir {
            let ok = NSWorkspace.shared.open(url)
            log("NSWorkspace でフォルダを開く: \(ok ? "OK" : "失敗")")
            if !ok { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([url])
            log("NSWorkspace でファイルを選ぶ形で開きました")
        }
    }
    @objc func checkAccess() { askAccess(reset: false) }
    @objc func redoAccess() { askAccess(reset: true) }

    // 許可を確かめる。reset の時は前の答えを消してから読むので、確認がもう一度出る
    func askAccess(reset: Bool) {
        DispatchQueue.global().async {
            if reset { resetPrivacy() }
            let result = privacyFolders.map { (name: $0.name, ok: canRead($0.path)) }
            log("許可: " + result.map { "\($0.name)=\($0.ok ? "あり" : "なし")" }.joined(separator: " "))
            if result.first?.ok == true && serverAlive() && !serverCanRead() {
                log("許可の後、本体を起動し直します")
                if quitServer() { self.startAndLoad() }
            }
            DispatchQueue.main.async { self.showAccess(result) }
        }
    }

    func showAccess(_ result: [(name: String, ok: Bool)]) {
        let a = NSAlert()
        a.messageText = tr("Mac のファイルの許可")
        let lines = result.map { "\($0.ok ? "✓" : "✕") \($0.name)フォルダ：\($0.ok ? tr("許可あり") : tr("許可なし"))" }.joined(separator: "\n")
        let allOK = result.allSatisfy { $0.ok }
        a.informativeText = lines + (allOK ? tr("\n\nすべて使えます。") : tr("\n\n［確認をもう一度出す］で Mac の確認が出たら「許可」を選んでください。出ない時は［フルディスクアクセスを開く］で、表示された Project Hub をリストに入れてオンにしてください。"))
        if allOK { a.addButton(withTitle: "OK"); a.runModal(); return }
        a.addButton(withTitle: tr("確認をもう一度出す"))
        a.addButton(withTitle: tr("フルディスクアクセスを開く"))
        a.addButton(withTitle: tr("閉じる"))
        let r = a.runModal()
        if r == .alertFirstButtonReturn { askAccess(reset: true) }
        else if r == .alertSecondButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
            NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])   // リストに落として入れられるように
        }
    }

    // 窓を閉じたら終了。本体（と作業中の AI）は裏で動き続ける
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    // 外のサイトへのリンクは通常のブラウザで開く
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // 画面の設定から：hubapp://access（確かめる）／ hubapp://access?reset=1（確認をもう一度出す）
        if let u = a.request.url, u.scheme == "hubapp" {
            if u.host == "access" { askAccess(reset: (u.query ?? "").contains("reset=1")) }
            if u.host == "reveal" { revealFromPage(u) }
            if u.host == "gpt" {
                let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
                if q.contains(where: { $0.name == "status" && $0.value == "1" }) { reportGptLogin() }
                else { showGpt(!q.contains(where: { $0.name == "open" && $0.value == "0" })) }
            }
            decisionHandler(.cancel); return
        }
        if let u = a.request.url, let host = u.host, host != "127.0.0.1", host != "localhost",
           let scheme = u.scheme, scheme.hasPrefix("http") {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
