// Project Hub のアプリ本体（Mac 用）
// - ダブルクリックで起動。ターミナルの窓は出ない
// - 本体（node server.js）が動いていなければ、自分で起動する
// - Mac 内蔵の WebKit で画面を出す
// - 何か失敗したら、黙らずに画面に理由を出す。記録は ~/Library/Logs/ProjectHub.log
import Cocoa
import WebKit
import CryptoKit
import UniformTypeIdentifiers



// Owner-only run files are capabilities, never printed or put in navigation URLs.
struct LocalOwner {
    let port: Int
    var directory: String { ProcessInfo.processInfo.environment["HUB_AUTH_DIR"] ?? NSHomeDirectory() + "/Library/Application Support/ProjectHub/run" }
    func record() -> [String: Any]? {
        let file = directory + "/owner-\(port).json"
        for p in [directory, file] {
            var st = stat()
            guard lstat(p, &st) == 0, st.st_uid == getuid(), st.st_mode & 0o077 == 0, st.st_mode & S_IFMT != S_IFLNK else { return nil }
        }
        var parent = (directory as NSString).deletingLastPathComponent
        while parent != "/" {
            var st = stat()
            guard lstat(parent, &st) == 0, st.st_mode & S_IFMT != S_IFLNK else { return nil }
            parent = (parent as NSString).deletingLastPathComponent
        }
        let fd = open(file, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { return nil }; defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, st.st_uid == getuid(), st.st_mode & 0o077 == 0, st.st_mode & S_IFMT == S_IFREG, st.st_nlink == 1, st.st_size < 8192 else { return nil }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        guard let obj = (try? JSONSerialization.jsonObject(with: handle.readDataToEndOfFile())) as? [String: Any],
              let token = obj["token"] as? String, token.count == 64, token.allSatisfy({ $0.isHexDigit }), obj["port"] as? Int == port else { return nil }
        return obj
    }
    func digest(_ text: String) -> String? {
        guard let token = record()?["token"] as? String else { return nil }
        let bytes = stride(from: 0, to: 64, by: 2).map { i -> UInt8 in
            let a = token.index(token.startIndex, offsetBy: i), b = token.index(a, offsetBy: 2)
            return UInt8(token[a..<b], radix: 16)!
        }
        return HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: SymmetricKey(data: Data(bytes))).map { String(format: "%02x", $0) }.joined()
    }
    var capability: String? { digest("local-api") }
    func matches(challenge: String, instance: String, proof: String) -> Bool {
        guard !instance.isEmpty, let expected = digest("\(challenge)\n\(instance)\n\(port)") else { return false }
        return expected == proof
    }
    func identity() -> String? {
        let challenge = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let url = URL(string: "http://127.0.0.1:\(port)/api/ping?challenge=\(challenge)")!
        var req = URLRequest(url: url); req.timeoutInterval = 3; req.cachePolicy = .reloadIgnoringLocalCacheData
        let sem = DispatchSemaphore(value: 0); var instance: String?
        let session = URLSession(configuration: .ephemeral, delegate: NoOwnerRedirect(), delegateQueue: nil)
        session.dataTask(with: req) { data, res, _ in
            defer { sem.signal() }
            guard (res as? HTTPURLResponse)?.statusCode == 200, let data = data,
                  let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let i = o["instance"] as? String, let proof = o["proof"] as? String,
                  self.matches(challenge: challenge, instance: i, proof: proof) else { return }
            instance = i
        }.resume()
        _ = sem.wait(timeout: .now() + 4); session.invalidateAndCancel(); return instance
    }
    func cookie(instance: String) -> HTTPCookie? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return nil }
        let value = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        // Parse Set-Cookie using Foundation's official HTTP attributes.
        return HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "hub_owner_\(port)=\(value); Path=/; HttpOnly; SameSite=Lax; Max-Age=28800"], for: url).first
    }
}
final class NoOwnerRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

// BEGIN PACKAGED RECOVERY
// Foundation-only: the same path checks/rename recovery are exercised by fixtures.
struct PackagedRecovery {
    let root: String
    let app: String
    let version: String
    var statePath: String { root + "/_hub/updates/packaged/state.json" }
    enum Failure: Error { case unsafe }
    func checked(_ file: String, base: String) throws {
        // NSString.standardizingPath can rewrite an existing /private/var alias.
        // Check lexical components without changing the journal's exact path.
        guard file == base || file.hasPrefix(base + "/"), file.hasPrefix("/"),
              !file.split(separator: "/", omittingEmptySubsequences: false).dropFirst().contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { throw Failure.unsafe }
        var current = ""
        for part in file.split(separator: "/") {
            current += "/" + part
            var info = stat()
            if lstat(current, &info) == 0 {
                guard info.st_mode & S_IFMT != S_IFLNK else { throw Failure.unsafe }
                if current == base || current.hasPrefix(base + "/") {
                    guard info.st_uid == getuid(), info.st_mode & 0o022 == 0 else { throw Failure.unsafe }
                }
            } else if errno != ENOENT { throw Failure.unsafe }
        }
    }
    func read() throws -> [String: Any] {
        try checked(statePath, base: root)
        guard let bytes = FileManager.default.contents(atPath: statePath), bytes.count <= 262144,
              let data = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Failure.unsafe }
        return data
    }
    func validate(_ pending: [String: Any]) throws -> String {
        guard app.hasSuffix("/Project Hub.app"), pending["target"] as? String == app,
              let sibling = pending["sibling"] as? String,
              (sibling as NSString).deletingLastPathComponent == (app as NSString).deletingLastPathComponent,
              (sibling as NSString).lastPathComponent.range(of: #"^\.ProjectHub-update-[A-Za-z0-9]+$"#, options: .regularExpression) != nil,
              pending["old"] as? String == sibling + "/old.app", pending["fresh"] as? String == sibling + "/new.app",
              let token = pending["token"] as? String, UUID(uuidString: token) != nil else { throw Failure.unsafe }
        try checked(app, base: app); try checked(sibling, base: sibling)
        return sibling
    }
    func pending() throws -> [String: Any]? {
        let data = try read()
        guard let p = data["pendingConfirm"] as? [String: Any] else { return nil }
        _ = try validate(p)
        return p
    }
    func token() -> String? {
        guard let p = try? pending(), p["version"] as? String == version else { return nil }
        return p["token"] as? String
    }
    func matches(_ ping: [String: Any], pending: [String: Any]) -> Bool {
        return ping["version"] as? String == pending["version"] as? String
            && ping["runtimePath"] as? String == app + "/Contents/Resources/runtime/hub"
            && ping["updateConfirm"] as? String == pending["token"] as? String
            && ping["restored"] as? Bool == true
            && !(ping["instance"] as? String ?? "").isEmpty
    }
    func save(_ data: [String: Any]) throws {
        try checked(statePath, base: root)
        let bytes = try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
        let tmp = statePath + "." + UUID().uuidString + ".tmp"
        guard FileManager.default.createFile(atPath: tmp, contents: bytes, attributes: [.posixPermissions: 0o600]) else { throw Failure.unsafe }
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: tmp))
        try handle.synchronize(); try handle.close()
        try checked(statePath, base: root)
        if Darwin.rename(tmp, statePath) != 0 { throw Failure.unsafe }
    }
    // Recover an interrupted swap before starting Node from a partially replaced
    // bundle. This also works from a still-running launcher after Node exits.
    func interruptedInstall() throws -> Bool {
        var data = try read()
        guard var j = data["install"] as? [String: Any] else { return false }
        j["token"] = "00000000-0000-4000-8000-000000000000"
        let sibling = try validate(j), old = sibling + "/old.app", interrupted = sibling + "/interrupted-new.app"
        try checked(old, base: sibling); try checked(interrupted, base: sibling)
        let fm = FileManager.default
        if fm.fileExists(atPath: old) {
            if fm.fileExists(atPath: app) {
                guard !fm.fileExists(atPath: interrupted) else { throw Failure.unsafe }
                try fm.moveItem(atPath: app, toPath: interrupted)
            }
            try fm.moveItem(atPath: old, toPath: app)
        }
        data.removeValue(forKey: "install"); data.removeValue(forKey: "prepared")
        data["phase"] = "failed"; data["error"] = "前の更新は途中で止まったため、前のアプリへ戻しました"
        try save(data); return true
    }
    // First failure asks the native launcher to retry once. Second keeps failed.app
    // and restores old.app. A rollback journal makes a crash between renames resumable.
    func failed() throws -> Bool {
        var data = try read()
        guard var p = data["pendingConfirm"] as? [String: Any] else { return false }
        let sibling = try validate(p)
        let resuming = data["rollback"] as? Bool == true
        let attempts = resuming ? 2 : (p["attempts"] as? Int ?? 0) + 1
        p["attempts"] = attempts; data["pendingConfirm"] = p; try save(data)
        if attempts < 2 { return false }
        let fm = FileManager.default, old = sibling + "/old.app", failed = sibling + "/failed.app"
        try checked(old, base: sibling); try checked(failed, base: sibling)
        data["rollback"] = true; try save(data)
        if fm.fileExists(atPath: old) {
            if fm.fileExists(atPath: app) {
                guard !fm.fileExists(atPath: failed) else { throw Failure.unsafe }
                try fm.moveItem(atPath: app, toPath: failed)
            }
            do { try fm.moveItem(atPath: old, toPath: app) }
            catch {
                if !fm.fileExists(atPath: app), fm.fileExists(atPath: failed) { try? fm.moveItem(atPath: failed, toPath: app) }
                throw error
            }
        } else {
            // The old App was already restored, but saving the result was interrupted.
            let plist = NSDictionary(contentsOfFile: app + "/Contents/Info.plist")
            guard resuming, fm.fileExists(atPath: failed), plist?["CFBundleShortVersionString"] as? String == p["from"] as? String else { throw Failure.unsafe }
        }
        data["phase"] = "rolled-back"; data["reason"] = "新しい版が2回起動しなかったため前の版へ戻しました"
        if let m = data["manifest"] as? [String: Any], let a = m["asset"] as? [String: Any] {
            data["rejected"] = ["seq": m["seq"] ?? 0, "sha256": a["sha256"] ?? "", "reason": "startup"]
        }
        data.removeValue(forKey: "rollback"); data.removeValue(forKey: "pendingConfirm")
        try save(data); return true
    }
}
// END PACKAGED RECOVERY


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
// Optional native strings live beside the same data pack used by Node.
let configuredPackDir = ProcessInfo.processInfo.environment["HUB_LANGPACK_DIR"]
    ?? (Bundle.main.object(forInfoDictionaryKey: "HubLangpackDir") as? String) ?? ""
let defaultPackDir = configuredPackDir.hasPrefix("@bundle/")
    ? Bundle.main.resourceURL!.appendingPathComponent(String(configuredPackDir.dropFirst("@bundle/".count))).path
    : configuredPackDir
var hubPackDir = defaultPackDir
var requestedLanguage = ProcessInfo.processInfo.environment["HUB_LANG"]
    ?? (Bundle.main.object(forInfoDictionaryKey: "HubLanguage") as? String) ?? "ja"
var nativeMessages: [String: String] = [:]
let hubWorkspace = ProcessInfo.processInfo.environment["HUB_ROOT"] ?? (configuredHubRoot.isEmpty ? home + "/Documents/AI-Workspace" : configuredHubRoot)
func validPackId(_ id: String) -> Bool {
    id != "ja" && id.range(of: #"^[a-z]{2,3}(-[A-Z][A-Za-z]{1,3})?$"#, options: .regularExpression) != nil
}
func validDateLocale(_ value: String) -> Bool {
    // Unicode locale identifiers: language, script, region, variants and extensions.
    let syntax = #"^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(-[0-9A-WY-Za-wy-z](-[A-Za-z0-9]{2,8})+)*(-x(-[A-Za-z0-9]{1,8})+)?$"#
    // Foundation's locale data omits aliases which Intl accepts. Resolve their
    // language component before checking availability (native does not format dates).
    let aliases = ["mo": "ro", "sh": "sr", "adp": "dz", "ars": "ar", "bih": "bho", "cls": "sa",
                   "cnr": "sr", "drh": "mn", "drw": "fa", "gom": "kok", "mao": "mi", "mol": "ro",
                   "npi": "ne", "ory": "or", "prp": "gu", "prs": "fa", "quz": "qu", "swc": "sw", "tnf": "fa"]
    let base = value.split(separator: "-").first.map { String($0).lowercased() } ?? ""
    guard value.range(of: syntax, options: .regularExpression) != nil,
          let language = Locale(identifier: aliases[base] ?? value).languageCode,
          Locale.availableIdentifiers.contains(where: { Locale(identifier: $0).languageCode == language }) else { return false }
    var variants = Set<String>(), extensions = Set<String>(), inExtension = false
    for part in value.lowercased().split(separator: "-").dropFirst() {
        if part == "x" { break }
        if part.count == 1 {
            guard extensions.insert(String(part)).inserted else { return false }
            inExtension = true
        } else if !inExtension && (part.count >= 5 || (part.count == 4 && part.first!.isNumber)) {
            guard variants.insert(String(part)).inserted else { return false }
        }
    }
    return true
}
func validPackMetadata(_ manifest: [String: Any], _ backend: [String: Any]) -> Bool {
    guard let id = manifest["id"] as? String, validPackId(id) else { return false }
    let date = manifest["dateLocale"] is NSNull ? id : manifest["dateLocale"] ?? id
    guard let date = date as? String, validDateLocale(date) else { return false }
    if let raw = backend["headings"] {
        guard let headings = raw as? [String: String] else { return false }
        let names = ["手順": ["手順", "步驟"], "やったこと": ["やったこと", "已完成的工作", "已完成的事"],
                     "次にやること": ["次にやること", "下一步", "接下來要做的事"],
                     "注意": ["注意", "注意事項"], "メモ": ["メモ", "備註"]]
        let reserved = names.flatMap { key, values in values.map { (key, $0) } }
            + ["成果", "確認結果", "残件申告", "最新の再開要約"].map { ($0, $0) }
        func overlaps(_ left: String, _ right: String) -> Bool {
            (left as NSString).range(of: right, options: .literal).location != NSNotFound
                || (right as NSString).range(of: left, options: .literal).location != NSNotFound
        }
        guard headings.allSatisfy({ key, value in names[key] != nil && !value.isEmpty
            && value.trimmingCharacters(in: .whitespacesAndNewlines) == value
            && value.rangeOfCharacter(from: CharacterSet(charactersIn: "#\r\n\u{2028}\u{2029}")) == nil
            && !(reserved + headings.map { ($0.key, $0.value) }).contains(where: { other, name in key != other && overlaps(value, name) })
        }) else { return false }
    }
    return true
}
func validPackMessages(_ messages: [String: String]) -> Bool {
    // Match langpack.js dataMessages: translated text cannot add markup/attributes.
    let tagPattern = try! NSRegularExpression(pattern: #"<[^>]*>"#)
    let nonASCII = try! NSRegularExpression(pattern: #"[^\x00-\x7f]"#)
    // JavaScript whitespace and word boundaries, rather than ICU's broader ones.
    let space = #"\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"#
    let literalSyntax = try! NSRegularExpression(pattern: "[" + space + "='\"/]")
    let presentation = try! NSRegularExpression(pattern: #"(?<![A-Za-z0-9_])(title|aria-label|aria-valuetext|placeholder)["# + space + #"]*=["# + space + #"]*(["'])[\s\S]*?\2"#)
    func range(_ text: String) -> NSRange { NSRange(text.startIndex..., in: text) }
    func tags(_ text: String) -> [[UInt16]] {
        tagPattern.matches(in: text, range: range(text)).map { match in
            let tag = (text as NSString).substring(with: match.range)
            if nonASCII.firstMatch(in: tag, range: range(tag)) != nil && literalSyntax.firstMatch(in: tag, range: range(tag)) == nil { return Array("<literal>".utf16) }
            // JS compares code units; Swift String equality normalizes Unicode.
            return Array(presentation.stringByReplacingMatches(in: tag, range: range(tag), withTemplate: "$1=\"\"").utf16)
        }
    }
    let slots = try! NSRegularExpression(pattern: #"\$\{[0-9]+\}"#)
    func placeholders(_ text: String) -> [String] {
        slots.matches(in: text, range: range(text)).map { (text as NSString).substring(with: $0.range) }.sorted()
    }
    for (source, value) in messages {
        if value.utf16.contains(0xE000) || value.utf16.contains(0xE001) || placeholders(source) != placeholders(value)
            || value.range(of: #"<\s*/?\s*\$\{"#, options: .regularExpression) != nil { return false }
        if !value.utf16.contains(0x3C) { continue }
        if tags(source) != tags(value) { return false }
        let remaining = tagPattern.stringByReplacingMatches(in: value, range: range(value), withTemplate: "")
        let original = tagPattern.stringByReplacingMatches(in: source, range: range(source), withTemplate: "")
        if remaining.utf16.filter({ $0 == 0x3C }).count != original.utf16.filter({ $0 == 0x3C }).count { return false }
    }
    return true
}
func loadNativeMessages() {
    // Called only after storageReady succeeds. No workspace reads in globals.
    nativeMessages = [:]
    let selection = hubWorkspace + "/_hub/language.json"
    if FileManager.default.fileExists(atPath: selection) {
        if let attributes = try? FileManager.default.attributesOfItem(atPath: selection),
           let size = attributes[.size] as? NSNumber, size.intValue <= 10000,
           let data = try? Data(contentsOf: URL(fileURLWithPath: selection)), data.count <= 10000,
           let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let language = saved["language"] as? String {
            requestedLanguage = language
        } else { requestedLanguage = "ja" }
    }
    guard validPackId(requestedLanguage) else { requestedLanguage = "ja"; return }
    let bundled = URL(fileURLWithPath: hubDir).deletingLastPathComponent().appendingPathComponent("langpacks/" + requestedLanguage).path
    let directories = [hubWorkspace + "/_hub/langpacks/" + requestedLanguage, defaultPackDir, bundled].filter { !$0.isEmpty }
    var seen = Set<String>()
    for directory in directories where seen.insert(directory).inserted {
        if !FileManager.default.fileExists(atPath: directory + "/pack.json") { continue }
        guard let manifestData = try? Data(contentsOf: URL(fileURLWithPath: directory + "/pack.json")),
              let manifest = (try? JSONSerialization.jsonObject(with: manifestData)) as? [String: Any], manifest["id"] as? String == requestedLanguage,
              let uiData = try? Data(contentsOf: URL(fileURLWithPath: directory + "/ui.json")),
              let ui = (try? JSONSerialization.jsonObject(with: uiData)) as? [String: String], validPackMessages(ui),
              let backendData = try? Data(contentsOf: URL(fileURLWithPath: directory + "/backend.json")),
              let backend = (try? JSONSerialization.jsonObject(with: backendData)) as? [String: Any],
              let messages = backend["messages"] as? [String: String], let labels = backend["labels"] as? [String: String],
              validPackMessages(messages), validPackMessages(labels), validPackMetadata(manifest, backend) else { continue }
        // Node may use a Web-only pack; native menus then keep their Japanese text.
        hubPackDir = directory
        if let data = try? Data(contentsOf: URL(fileURLWithPath: directory + "/native.json")),
           let messages = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
           validPackMessages(messages) { nativeMessages = messages }
        return
    }
    requestedLanguage = "ja"
}
var hubLanguage: String { requestedLanguage }
func tr(_ ja: String, _ values: String...) -> String {
    let text = nativeMessages[ja] ?? ja
    let matches = try! NSRegularExpression(pattern: #"\$\{(\d+)\}"#)
    var translated = text
    for match in matches.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
        if let index = Int((text as NSString).substring(with: match.range(at: 1))),
           index < values.count, let range = Range(match.range, in: translated) {
            let html = ja.range(of: #"</?[a-zA-Z][^>]*>"#, options: .regularExpression) != nil
            translated.replaceSubrange(range, with: html ? escapeNativeHTML(values[index]) : values[index])
        }
    }
    return translated
}
func escapeNativeHTML(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&#39;")
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
let packagedRecovery = PackagedRecovery(root: hubWorkspace, app: Bundle.main.bundleURL.path,
    version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
let localOwner = LocalOwner(port: Int(port) ?? 4545)
func localJSON(_ route: String) -> [String: Any]? {
    var request = URLRequest(url: baseURL.appendingPathComponent(route)); request.timeoutInterval = 3
    guard localOwner.identity() != nil, let token = localOwner.capability else { return nil }
    request.setValue(token, forHTTPHeaderField: "X-Hub-Token")
    let semaphore = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    URLSession.shared.dataTask(with: request) { data, response, _ in
        if (response as? HTTPURLResponse)?.statusCode == 200, let data = data {
            result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 4); return result
}
func updateServerReady() -> Bool {
    guard let pending = try? packagedRecovery.pending(), pending["version"] as? String == packagedRecovery.version else { return serverAlive() }
    guard let ping = localJSON("api/ping"), packagedRecovery.matches(ping, pending: pending), localJSON("api/state") != nil else { return false }
    // /api/state finishes before the backend commits the confirmation journal.
    guard let state = try? packagedRecovery.read(), state["pendingConfirm"] == nil,
          let installed = state["lastInstalled"] as? [String: Any] else { return false }
    return installed["version"] as? String == pending["version"] as? String && installed["instance"] as? String == ping["instance"] as? String
}

func serverAlive() -> Bool { localOwner.identity() != nil }
// 記録の最後の数行（止まった理由を画面に出すため）
func logTail(_ n: Int) -> String {
    guard let s = try? String(contentsOfFile: logPath, encoding: .utf8) else { return "" }
    return s.split(separator: "\n").suffix(n).joined(separator: "\n")
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
    guard localOwner.identity() != nil, let token = localOwner.capability else { return false }
    req.setValue(token, forHTTPHeaderField: "X-Hub-Token")
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
    guard localOwner.identity() != nil, let token = localOwner.capability else { return false }
    req.setValue(token, forHTTPHeaderField: "X-Hub-Token")
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

// BEGIN PROMISED DROP BATCH
// Foundation-only aggregation: never deliver partial/failed promises or twice.
final class PromisedDropBatch {
    private var expected: Int?
    private var received = 0
    private var paths: [String] = []
    private var failed = false
    private var finished = false
    private let complete: ([String]?) -> Void
    init(count: Int? = nil, complete: @escaping ([String]?) -> Void) {
        expected = count; self.complete = complete
    }
    // fileNames is populated only AFTER receivePromisedFiles has been called.
    func seal(count: Int) { guard expected == nil, count > 0 else { return }; expected = count; finishIfReady() }
    private func finishIfReady() {
        guard !finished, let expected = expected, received >= expected else { return }
        finished = true; complete(!failed && received == expected ? paths : nil)
    }
    func receive(_ path: String?) {
        guard !finished else { return }
        if let path = path, !paths.contains(path) { paths.append(path) } else { failed = true }
        received += 1; finishIfReady()
    }
    @discardableResult func cancel() -> Bool {
        guard !finished else { return false }; failed = true; return true
    }
}

func promisedDropPath(_ url: URL, in directory: URL) -> String? {
    guard url.isFileURL,
          let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
          values.isRegularFile == true, values.isSymbolicLink != true else { return nil }
    // Foundation may return /private/var for a /var destination. Compare the
    // resolved parents, while still rejecting symlinks and nested/outside files.
    let file = url.standardizedFileURL.resolvingSymlinksInPath()
    let parent = directory.standardizedFileURL.resolvingSymlinksInPath()
    return file.deletingLastPathComponent().path == parent.path ? file.path : nil
}
// END PROMISED DROP BATCH

// Receive promises during performDragOperation itself. AppKit does not permit
// receivePromisedFiles from a later asynchronous JavaScript completion handler.
class DropWebView: WKWebView {
    private let dropQueue: OperationQueue = {
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1; return queue
    }()
    private func promises(_ sender: NSDraggingInfo) -> [NSFilePromiseReceiver] {
        return sender.draggingPasteboard.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as? [NSFilePromiseReceiver] ?? []
    }
    private func hasBitmap(_ sender: NSDraggingInfo) -> Bool {
        return sender.draggingPasteboard.availableType(from: [.png, .tiff]) != nil
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !promises(sender).isEmpty || hasBitmap(sender) { return .copy }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if !promises(sender).isEmpty || hasBitmap(sender) { return .copy }
        return super.draggingUpdated(sender)
    }
    private func deliver(_ paths: [String], ticket: String, temporary: Bool = false, cleanup: (() -> Void)? = nil) {
        callAsyncJavaScript("return await window.hubNativeDrop(paths, ticket, {temporary})", arguments: ["paths": paths, "ticket": ticket, "temporary": temporary], in: nil, in: .page) { _ in cleanup?() }
    }
    private func failed(_ ticket: String, reason: String) {
        callAsyncJavaScript("window.hubNativeDrop.fail(ticket, reason)", arguments: ["ticket": ticket, "reason": reason], in: nil, in: .page) { _ in }
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let receivers = promises(sender)
        let board = sender.draggingPasteboard
        let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        let bitmapType = receivers.isEmpty && urls.isEmpty ? board.availableType(from: [.png, .tiff]) : nil
        if receivers.isEmpty && urls.isEmpty && bitmapType == nil { return super.performDragOperation(sender) }
        // Join asynchronous DOM capture with native preparation in either order.
        // Starting preparation here is synchronous; delivery waits for BOTH.
        var ticket: String?, ticketReady = false, resultReady = false
        var earlyFailure: String?
        var paths: [String]?, reason = "promise", cleanup: (() -> Void)?
        let temporary = !receivers.isEmpty || bitmapType != nil
        func finish() {
            guard ticketReady && resultReady else { return }; resultReady = false
            guard let ticket = ticket else { cleanup?(); return }
            if let paths = paths { self.deliver(paths, ticket: ticket, temporary: temporary, cleanup: cleanup) }
            else { self.failed(ticket, reason: reason); cleanup?() }
        }
        evaluateJavaScript("window.hubNativeDrop && window.hubNativeDrop.begin ? window.hubNativeDrop.begin() : null") { value, error in
            ticket = error == nil ? value as? String : nil; ticketReady = true
            if let reason = earlyFailure, let ticket = ticket { self.failed(ticket, reason: reason) }
            finish()
        }
        if !temporary {
            if urls.allSatisfy({ $0.isFileURL && FileManager.default.fileExists(atPath: $0.path) }) { paths = urls.map { $0.path } }
            reason = "file-url"; resultReady = true; finish(); return true
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ProjectHub-drop-" + UUID().uuidString, isDirectory: true)
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        catch { reason = "temporary-directory"; resultReady = true; finish(); return true }
        cleanup = { try? FileManager.default.removeItem(at: directory); return }
        if let type = bitmapType {
            reason = "image-data"
            do {
                guard let data = board.data(forType: type), let image = NSBitmapImageRep(data: data),
                      let png = image.representation(using: .png, properties: [:]) else { throw CocoaError(.fileReadCorruptFile) }
                let file = directory.appendingPathComponent("screenshot.png")
                try png.write(to: file, options: .withoutOverwriting)
                paths = promisedDropPath(file, in: directory).map { [$0] }
            } catch { reason = "image-data" }
            resultReady = true; finish(); return true
        }
        let batch = PromisedDropBatch { received in paths = received; resultReady = true; finish() }
        // Do not delete a directory while a producer may still be writing it.
        // Late callbacks clean up; a producer which never returns leaves a temp
        // directory for macOS to reclaim, never a path in an AI input field.
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            if batch.cancel() { earlyFailure = "timeout"; if let ticket = ticket { self.failed(ticket, reason: "timeout") } }
        }
        for receiver in receivers {
            receiver.receivePromisedFiles(atDestination: directory, options: [:], operationQueue: dropQueue) { url, error in
                let path = error == nil ? promisedDropPath(url, in: directory) : nil
                DispatchQueue.main.async {
                    if path == nil { reason = error == nil ? "file-location" : "promise" }
                    batch.receive(path)
                }
            }
        }
        let count = receivers.reduce(0) { $0 + $1.fileNames.count }
        if count > 0 { batch.seal(count: count) }
        else { batch.cancel(); reason = "promise-count"; earlyFailure = reason; if let ticket = ticket { failed(ticket, reason: reason) } }
        return true
    }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var updateTimer: Timer?
    var updateRequestInFlight = false
    var updateRelaunching = false
    var server: Process?
    var pageInstance: String?
    var navigationChallenge: String?
    var responseInstance: String?

    // Public WebKit media permission API only. Never grant camera or embedded/foreign origins.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let sameOrigin = origin.protocol == baseURL.scheme && origin.host == baseURL.host && origin.port == baseURL.port
        guard type == .microphone, frame.isMainFrame, sameOrigin,
              webView.url?.scheme == baseURL.scheme, webView.url?.host == baseURL.host,
              webView.url?.port == baseURL.port else { decisionHandler(.deny); return }
        webView.evaluateJavaScript("window.HubVoice?.permissionPending() === true") { value, error in
            // Prompt, rather than silently grant. OS permission remains under the person's control.
            let stillLocal = webView.url?.scheme == baseURL.scheme && webView.url?.host == baseURL.host && webView.url?.port == baseURL.port
            decisionHandler(error == nil && (value as? Bool) == true && stillLocal ? .prompt : .deny)
        }
    }

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
            alert.messageText = "データ用ディスクを使えません"
            alert.informativeText = "ストレージの確認に通りませんでした。データ用ディスクを接続してから、もう一度開いてください。"
            alert.runModal(); NSApp.terminate(nil); return
        }
        let languageBeforeLoad = requestedLanguage
        loadNativeMessages()
        if requestedLanguage == "ja" && languageBeforeLoad != "ja" {
            log("選んだ言語パックが読めない場合は、日本語で動作します。")
        }
        log("アプリを開きました（本体の場所: \(hubDir)）")
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .nonPersistent()
        let shellHash = Bundle.main.object(forInfoDictionaryKey: "HubShellHash") as? String ?? "unknown"
        conf.applicationNameForUserAgent = "ProjectHubApp/\(shellHash.prefix(12)) HubVoice/1"   // 音声入力の許可設定を持つ外側のアプリを画面で識別する
        web = DropWebView(frame: .zero, configuration: conf)
        web.registerForDraggedTypes(NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) } + [.png, .tiff])
        web.navigationDelegate = self
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Project Hub"
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("ProjectHubMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        buildMenu()
        updateTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.pollAppUpdate() }
        web.loadHTMLString(page(tr("起動しています…"), tr("<p>数秒お待ちください。</p>")), baseURL: nil)
        installLoopbackRules {
            DispatchQueue.global().async { self.startAndLoad() }
        }
    }

    func startAndLoad() {
        guard storageReady() else {
            showError("データ用ディスクを使えません", "<p>ディスクの確認に失敗したため、起動を止めました。</p>")
            return
        }
        if (try? packagedRecovery.read()["rollback"] as? Bool) == true { handleUpdateFailure(); return }
        if let state = try? packagedRecovery.read(), let journal = state["install"] as? [String: Any] {
            do {
                if serverAlive() {
                    guard let ping = localJSON("/api/ping"),
                          ping["runtimePath"] as? String == Bundle.main.bundlePath + "/Contents/Resources/runtime/hub",
                          let servedVersion = ping["version"] as? String,
                          servedVersion == journal["from"] as? String || servedVersion == journal["to"] as? String,
                          quitServer(reason: "update") else { throw PackagedRecovery.Failure.unsafe }
                }
                if try packagedRecovery.interruptedInstall() {
                    DispatchQueue.main.async {
                        let config = NSWorkspace.OpenConfiguration(); config.createsNewApplicationInstance = true
                        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
                            DispatchQueue.main.async {
                                if error == nil { NSApp.terminate(nil) }
                                else { self.showError(tr("前の版を開き直してください"), tr("<p>Finderで Project Hub.app を開き直してください。</p>")) }
                            }
                        }
                    }
                    return
                }
            } catch { showError(tr("前の版へ自動で戻せませんでした"), tr("<p>アプリの更新が途中で止まっています。前の版を保存したまま起動を止めました。</p>")); return }
        }
        // 本体が台帳を読めている時は、その画面を先に開く。
        // 書類フォルダの確認がOS側で待たされても、稼働中の本体を表示できる。
        let confirmingUpdate = packagedRecovery.token() != nil
        if !confirmingUpdate && serverAlive() && serverCanRead() {
            log("台帳を読める本体が動いています")
            DispatchQueue.main.async { self.loadOwned(URLRequest(url: baseURL)) }
            return
        }
        // 本体を新しく起動する時は、書類フォルダの許可を確かめる
        let workspace = ProcessInfo.processInfo.environment["HUB_ROOT"] ?? (configuredHubRoot.isEmpty ? home + "/Documents/AI-Workspace" : configuredHubRoot)
        let appCanRead = canRead(workspace)
        if !appCanRead { log("書類フォルダを読めません（許可が無い可能性）") }
        // 本体が前の起動のまま動いていて、許可が効いていない時は、止めてこのアプリから起動し直す
        if !confirmingUpdate && appCanRead && serverAlive() && !serverCanRead() {
            log("本体が書類フォルダを読めません。起動し直します")
            if !quitServer() { log("本体を止められませんでした（AI が作業中の可能性）。そのまま開きます") }
        }
        if !confirmingUpdate && serverAlive() {
            log("本体はすでに動いています")
            DispatchQueue.main.async { self.loadOwned(URLRequest(url: baseURL)) }
            return
        }
        let path = loginShellPath()
        log("PATH: \(path.isEmpty ? "（取れず）" : path)")
        guard let node = findNode(path: path) else {
            if confirmingUpdate { handleUpdateFailure(); return }
            log("node が見つかりません")
            showError(tr("Node.js が見つかりません"), tr("<p><a href=\"https://nodejs.org\">https://nodejs.org</a> から入れてから、もう一度開いてください。</p>"))
            return
        }
        let serverJS = hubDir + "/server.js"
        // 実際に読んでみる（ここで Mac が「書類フォルダへのアクセス」の確認を出す）
        if FileManager.default.contents(atPath: serverJS) == nil {
            if confirmingUpdate { handleUpdateFailure(); return }
            log("本体を読めません: \(serverJS)（書類フォルダの許可が必要な可能性）")
            showError(tr("本体のファイルを読めません"),
                      tr("<p>「システム設定 → プライバシーとセキュリティ → ファイルとフォルダ」で、<b>Project Hub</b> の「書類フォルダ」をオンにしてから、もう一度開いてください。</p><p>場所：<code>${0}</code></p>", String(serverJS)))
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
        env["HUB_LANGPACK_DIR"] = hubPackDir
        let extra = [(node as NSString).deletingLastPathComponent, "/opt/homebrew/bin", "/usr/local/bin", home + "/.local/bin", home + "/.claude/local"]
        env["PATH"] = ([path] + extra + [env["PATH"] ?? "/usr/bin:/bin"]).filter { !$0.isEmpty }.joined(separator: ":")
        env["HUB_PORT"] = port
        if env["HUB_ROOT"] == nil && !configuredHubRoot.isEmpty { env["HUB_ROOT"] = configuredHubRoot }
        if !storageGuard.isEmpty { env["HUB_STORAGE_GUARD"] = storageGuard }
        let source = (hubDir as NSString).deletingLastPathComponent
        if FileManager.default.fileExists(atPath: source + "/.git") { env["HUB_UPDATE_SOURCE"] = source }
        env["HUB_UPDATE_APP"] = Bundle.main.bundleURL.path
        if let token = packagedRecovery.token() { env["HUB_UPDATE_CONFIRM"] = token }
        else { env.removeValue(forKey: "HUB_UPDATE_CONFIRM") }
        p.environment = env
        if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
        do {
            try p.run()
            server = p
            log("本体を起動しました（node: \(node)）")
        } catch {
            if confirmingUpdate { handleUpdateFailure(); return }
            log("本体を起動できません: \(error)")
            showError(tr("本体を起動できません"), tr("<p>記録：<code>${0}</code></p>", String(logPath)))
            return
        }
        for _ in 0..<50 {
            if updateServerReady() {
                log("本体の準備ができました")
                DispatchQueue.main.async { self.loadOwned(URLRequest(url: baseURL)) }
                return
            }
            if !p.isRunning { break }
            Thread.sleep(forTimeInterval: 0.3)
        }
        if confirmingUpdate {
            if p.isRunning { p.terminate(); p.waitUntilExit() }
            handleUpdateFailure(); return
        }
        log("本体が応答しません（本体は\(p.isRunning ? "動いています" : "止まりました（終了コード \(p.terminationStatus)）")）")
        let busyPort = logTail(8).contains("は使われています")
        showError(tr("本体が応答しません"), (busyPort ? "<p><b>前の本体が止まったまま残っています。</b>ターミナルで <code>pkill -f ProjectHub/hub/server.js</code> を実行してから、［再読み込み］（⌘R）を押してください。</p>" : "") + tr("<p>メニューの［再読み込み］（⌘R）で、もう一度試せます。直らない時は、下の記録を Claude に見せてください：<code>${0}</code></p><pre style=\"white-space:pre-wrap;font-size:12px;max-height:40vh;overflow:auto\">${1}</pre>", String(logPath), String(logTail(25))))
    }

    func handleUpdateFailure() {
        do {
            let rolledBack = try packagedRecovery.failed()
            log(rolledBack ? "更新に失敗したため前のアプリへ戻しました" : "新版の起動を一度だけやり直します")
            DispatchQueue.main.async {
                let config = NSWorkspace.OpenConfiguration(); config.createsNewApplicationInstance = true
                NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
                    DispatchQueue.main.async {
                        if error == nil { NSApp.terminate(nil) }
                        else if !rolledBack { DispatchQueue.global().async { self.handleUpdateFailure() } }
                        else { self.showError(tr("前の版を開き直してください"), tr("<p>Finderで Project Hub.app を開き直してください。</p>")) }
                    }
                }
            }
        } catch {
            let old = (try? packagedRecovery.pending())?["old"] as? String ?? "更新前のアプリの保存場所"
            showError(tr("前の版へ自動で戻せませんでした"), tr("<p>前の版は ${0} に残っています。Finderで［アプリケーション］へ戻してください。</p>", old))
        }
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
                self.web.evaluateJavaScript("typeof appUpdateMayRestart === 'function' && appUpdateMayRestart()") { value, error in
                    guard error == nil, value as? Bool == true else { return }
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
                                    DispatchQueue.global().async {
                                        if (try? packagedRecovery.pending()) != nil { self.handleUpdateFailure() }
                                        else { self.startAndLoad() }
                                    }
                                } else { NSApp.terminate(nil) }
                            }
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
        // prompt の入力欄は WebKit ではなく、シートのフィールドエディタ。
        // ⌘V・編集メニューとも、名前を編集中ならその入力欄へ貼る。
        if let sheet = window.attachedSheet,
           let editor = sheet.firstResponder as? NSTextView, editor.isFieldEditor {
            editor.paste(self)
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

    @objc func reload() {
        if packagedRecovery.token() == nil && serverAlive() { loadOwned(URLRequest(url: baseURL)) } else { DispatchQueue.global().async { self.startAndLoad() } }
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


    func installLoopbackRules(_ completion: @escaping () -> Void) {
        // WebKit's rule compiler does not support regex disjunctions.
        // One scheme/host per rule; the final exception is our exact HTTP origin.
        var rules: [[String: Any]] = []
        // Reject credentials in every authority, before our exact-origin exception.
        rules.append(["trigger": ["url-filter": "^[a-z]+://[^/?#]*@"], "action": ["type": "block"]])
        for scheme in ["http", "https", "ws", "wss"] {
            for host in ["127\\.0\\.0\\.1", "localhost\\.?", "[a-z0-9.-]+\\.localhost\\.?", "\\[::1\\]", "\\[::ffff:127\\.0\\.0\\.1\\]", "\\[::ffff:7f00:1\\]"] {
                rules.append(["trigger": ["url-filter": "^\(scheme)://\(host)[:/]"], "action": ["type": "block"]])
            }
        }
        rules.append(["trigger": ["url-filter": "^http://127\\.0\\.0\\.1:\(baseURL.port ?? 4545)/"], "action": ["type": "ignore-previous-rules"]])
        guard let data = try? JSONSerialization.data(withJSONObject: rules), let json = String(data: data, encoding: .utf8) else { return }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "HubLoopback", encodedContentRuleList: json) { list, _ in
            guard let list = list else { self.showError("画面を開けません", "<p>接続先の制限を準備できませんでした。</p>"); return }
            self.web.configuration.userContentController.add(list); completion()
        }
    }
    func loadOwned(_ request: URLRequest, instance: String? = nil) {
        guard let instance = instance else { web.load(request); return } // Navigation delegate proves identity first.
        guard let token = localOwner.capability else { return }
        var request = request
        request.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        guard let cookie = localOwner.cookie(instance: instance) else { return }
        web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { self.web.load(request) }
    }
    func verifyNavigation(_ request: URLRequest, completion: @escaping (WKNavigationActionPolicy) -> Void) {
        DispatchQueue.global().async {
            let instance = localOwner.identity()
            DispatchQueue.main.async {
                guard let instance = instance else { completion(.cancel); return }
                if let nonce = request.value(forHTTPHeaderField: "X-Hub-Navigation"), nonce == self.navigationChallenge {
                    completion(.allow); return
                }
                completion(.cancel)
                var checked = request
                let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
                checked.setValue(nonce, forHTTPHeaderField: "X-Hub-Navigation"); checked.cachePolicy = .reloadIgnoringLocalCacheData
                self.navigationChallenge = nonce
                self.responseInstance = nil
                let load = { self.loadOwned(checked, instance: instance) }
                if self.pageInstance != instance {
                    self.pageInstance = nil
                    self.web.configuration.websiteDataStore.removeData(ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache], modifiedSince: .distantPast, completionHandler: load)
                } else { load() }
            }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard response.isForMainFrame, let r = response.response as? HTTPURLResponse else { decisionHandler(.allow); return }
        guard let nonce = navigationChallenge, let instance = r.value(forHTTPHeaderField: "X-Hub-Instance"),
              let proof = r.value(forHTTPHeaderField: "X-Hub-Proof"), localOwner.matches(challenge: nonce, instance: instance, proof: proof) else { self.pageInstance = nil; self.responseInstance = nil; decisionHandler(.cancel); return }
        responseInstance = instance; navigationChallenge = nil; decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { if let instance = responseInstance { pageInstance = instance }; responseInstance = nil }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { responseInstance = nil }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { responseInstance = nil }

    // 外のサイトへのリンクは通常のブラウザで開く
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // 画面の設定から：hubapp://access（確かめる）／ hubapp://access?reset=1（確認をもう一度出す）
        if let u = a.request.url, u.scheme == "hubapp" {
            // Hub 本体（最上位の画面）からの依頼だけ受ける。PDF などを表示した iframe や、別の場所の画面からは何もしない
            let source = a.sourceFrame
            guard source.isMainFrame, a.targetFrame?.isMainFrame == true,
                  source.securityOrigin.protocol == baseURL.scheme, source.securityOrigin.host == baseURL.host,
                  source.securityOrigin.port == baseURL.port else {
                log("Hub 本体以外からの hubapp の依頼を断りました（\(u.host ?? "")）")
                decisionHandler(.cancel); return
            }
            let loaded = pageInstance
            DispatchQueue.global().async {
                let instance = localOwner.identity()
                DispatchQueue.main.async {
                    guard let loaded = loaded, instance == loaded, self.pageInstance == loaded else { return }
                    if u.host == "access" { self.askAccess(reset: (u.query ?? "").contains("reset=1")) }
                    if u.host == "reveal" { self.revealFromPage(u) }
                }
            }
            decisionHandler(.cancel); return
        }
        if let u = a.request.url, ["127.0.0.1", "localhost", "::1", "[::1]"].contains(u.host ?? ""),
           u.scheme != baseURL.scheme || u.host != baseURL.host || u.port != baseURL.port {
            decisionHandler(.cancel); return
        }
        if let u = a.request.url, a.targetFrame?.isMainFrame == true, let current = w.url,
           pageInstance != nil, (a.request.httpMethod ?? "GET") == "GET", u.fragment != nil,
           (u.fragment != current.fragment || a.navigationType == .linkActivated),
           var to = URLComponents(url: u, resolvingAgainstBaseURL: false), var from = URLComponents(url: current, resolvingAgainstBaseURL: false) {
            to.fragment = nil; from.fragment = nil
            if to == from { decisionHandler(.allow); return }
        }
        if let u = a.request.url, let host = u.host, host != "127.0.0.1", host != "localhost",
           let scheme = u.scheme, scheme.hasPrefix("http") {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        if let u = a.request.url, a.targetFrame?.isMainFrame == true, u.scheme == baseURL.scheme, u.host == baseURL.host, u.port == baseURL.port {
            verifyNavigation(a.request, completion: decisionHandler); return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
