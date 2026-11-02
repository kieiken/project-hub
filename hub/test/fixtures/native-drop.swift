// Test adapter: real Foundation/AppKit URLs, files, bitmap and pasteboard data;
// simulated dragging session, promise producer and async WebKit bridge. No GUI drag.
import AppKit

final class TestDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard = NSPasteboard.withUniqueName()
    var receivers: [NSFilePromiseReceiver] = []
    var active = false
    var draggingDestinationWindow: NSWindow? { nil }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { .zero }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    var draggingFormation: NSDraggingFormation = .none
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func slideDraggedImage(to: NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination: URL) -> [String]? { nil }
    func resetSpringLoading() {}
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?, classes: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    deinit { draggingPasteboard.releaseGlobally() }
}

class DropTestWebView {
    struct World { static let page = World() }
    var begin: ((Any?, Error?) -> Void)?
    var pending: ((Result<Any, Error>) -> Void)?
    var delivered: [[String: Any]] = []
    var failures: [String] = []
    var supers = 0
    func evaluateJavaScript(_ code: String, completionHandler: @escaping (Any?, Error?) -> Void) { begin = completionHandler }
    func callAsyncJavaScript(_ code: String, arguments: [String: Any], in frame: Any?, in world: World, completionHandler: @escaping (Result<Any, Error>) -> Void) {
        if code.contains(".fail(") { failures.append(arguments["reason"] as? String ?? "unknown"); completionHandler(.success(false)) }
        else { delivered.append(arguments); pending = completionHandler }
    }
    func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
    func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
    func performDragOperation(_ sender: NSDraggingInfo) -> Bool { supers += 1; return false }
}

final class TestReceiver: NSFilePromiseReceiver {
    weak var drag: TestDrag?
    var called = 0
    let names: [String]
    var emit: (() -> Void)?
    var mode = "good"
    var destination: URL?
    override var fileNames: [String] { called == 0 ? [] : names }
    // Legacy providers can promise multiple files with only one unique type.
    override var fileTypes: [String] { ["public.png"] }
    init(_ names: [String], _ drag: TestDrag) { self.names = names; self.drag = drag; super.init() }
    required init?(pasteboardPropertyList propertyList: Any, ofType type: NSPasteboard.PasteboardType) { fatalError("not used by adapter") }
    override func receivePromisedFiles(atDestination destinationDir: URL, options: [AnyHashable: Any] = [:], operationQueue: OperationQueue, reader: @escaping (URL, Error?) -> Void) {
        precondition(drag?.active == true, "AppKit forbids receivePromisedFiles after performDragOperation returns")
        called += 1; destination = destinationDir
        emit = {
            for (i, name) in self.names.enumerated() {
                let file = destinationDir.appendingPathComponent(name)
                try! png.write(to: file)
                let error: Error? = self.mode == "error" && i == self.names.count - 1 ? CocoaError(.fileWriteUnknown) : nil
                if self.mode == "duplicate" { reader(destinationDir.appendingPathComponent(self.names[0]), error) }
                else { reader(file, error) }
            }
        }
    }
}

let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
func pump() { for _ in 0..<5 { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) } }
func check(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() { print("FAIL: " + message); exit(1) }
}

// INSERT PRODUCTION RECEIVER

// Verify the fake producer's empty-before-receive premise using AppKit itself.
// Fulfilling a real promise requires a real GUI drag, which this fixture avoids.
final class ProbeProvider: NSObject, NSFilePromiseProviderDelegate {
    func filePromiseProvider(_ provider: NSFilePromiseProvider, fileNameForType type: String) -> String { "probe.png" }
    func filePromiseProvider(_ provider: NSFilePromiseProvider, writePromiseTo url: URL, completionHandler: @escaping (Error?) -> Void) { completionHandler(CocoaError(.userCancelled)) }
}
let probeBoard = NSPasteboard.withUniqueName(), probeDelegate = ProbeProvider()
defer { probeBoard.releaseGlobally() }
let probeProvider = NSFilePromiseProvider(fileType: "public.png", delegate: probeDelegate)
check(probeBoard.writeObjects([probeProvider]), "probe pasteboard")
let realReceivers = probeBoard.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as! [NSFilePromiseReceiver]
check(realReceivers.count == 1 && realReceivers[0].fileNames.isEmpty, "actual AppKit fileNames initially empty")
print("PASS actual AppKit pre-receive empty names")

// Both ordering cases, multiple files per legacy receiver, all callbacks,
// duplicate/partial error/late callbacks, and cleanup after the JS save resolves.
for mode in ["early-ticket", "late-ticket", "error", "duplicate", "timeout", "no-target"] {
    let drag = TestDrag(), web = DropWebView()
    let receiver = TestReceiver(["first.png", "second.png"], drag)
    receiver.mode = mode; drag.receivers = [receiver]
    check(receiver.fileNames.isEmpty, "pre-receive names must be empty")
    drag.active = true; check(web.performDragOperation(drag), "native claims promise"); drag.active = false
    check(receiver.called == 1, "must invoke producer synchronously once; filenames are empty beforehand")
    let directory = receiver.destination!
    let attrs = try! FileManager.default.attributesOfItem(atPath: directory.path)
    check((attrs[.posixPermissions] as! NSNumber).intValue == 0o700, "private directory")
    if mode == "early-ticket" { web.begin?("ticket", nil) }
    if mode == "timeout" { testTimeouts.forEach { $0() }; testTimeouts.removeAll() }
    receiver.emit?(); pump()
    if mode != "early-ticket" { web.begin?(mode == "no-target" ? nil : "ticket", nil) }
    pump()
    if ["error", "duplicate", "timeout", "no-target"].contains(mode) {
        check(web.delivered.isEmpty, "failure must not deliver a partial batch")
        check(!FileManager.default.fileExists(atPath: directory.path), "finished failure cleans up")
    } else {
        check(web.delivered.count == 1, "one delivery")
        let args = web.delivered[0], paths = args["paths"] as! [String]
        check(paths.count == 2 && args["temporary"] as? Bool == true, "all promised files and temporary boundary")
        check(paths.allSatisfy { FileManager.default.fileExists(atPath: $0) }, "files live until async save returns")
        web.pending?(.success(true))
        check(!FileManager.default.fileExists(atPath: directory.path), "cleanup after save ack")
    }
    // Successful batches ignore a pending timeout. No duplicate native delivery.
    let failures = web.failures.count
    testTimeouts.forEach { $0() }; testTimeouts.removeAll()
    check(web.failures.count == failures, "no timeout failure after a completed batch")
    print("PASS promise " + mode)
}

let root = FileManager.default.temporaryDirectory.appendingPathComponent("Hub-drop-alias-" + UUID().uuidString, isDirectory: true)
try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: root) }
let file = root.appendingPathComponent("saved.png"); try! png.write(to: file)
let resolved = root.resolvingSymlinksInPath()
check(promisedDropPath(resolved.appendingPathComponent("saved.png"), in: root) != nil, "Foundation temp-parent alias")
let link = root.appendingPathComponent("link.png"); try! FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
check(promisedDropPath(link, in: root) == nil, "symlink file rejected")
let nested = root.appendingPathComponent("nested", isDirectory: true)
try! FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
let inner = nested.appendingPathComponent("inner.png"); try! png.write(to: inner)
check(promisedDropPath(inner, in: root) == nil, "nested file rejected")
check(promisedDropPath(file, in: nested) == nil, "outside file rejected")
print("PASS real URL alias and regular/symlink/nested/outside boundaries")
for type in [NSPasteboard.PasteboardType.png, .tiff] {
    let drag = TestDrag(), web = DropWebView()
    let data = type == .png ? png : NSBitmapImageRep(data: png)!.tiffRepresentation!
    check(drag.draggingPasteboard.setData(data, forType: type), "real pasteboard bitmap")
    drag.active = true; check(web.performDragOperation(drag), "native claims bitmap"); drag.active = false
    web.begin?("bitmap", nil); check(web.delivered.count == 1, "raw image delivered once")
    let paths = web.delivered[0]["paths"] as! [String]
    check(NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: paths[0]))) != nil, "actual bitmap readable until save")
    web.pending?(.success(true)); check(!FileManager.default.fileExists(atPath: paths[0]), "bitmap cleanup after ack")
    print("PASS raw " + type.rawValue)
}
let drag = TestDrag(), web = DropWebView()
check(drag.draggingPasteboard.writeObjects([file as NSURL]), "Finder URL pasteboard")
drag.active = true; check(web.performDragOperation(drag), "native claims URL"); drag.active = false
web.begin?("url", nil)
check(web.delivered.count == 1 && web.delivered[0]["temporary"] as? Bool == false, "Finder URL unchanged")
web.pending?(.success(true)); check(FileManager.default.fileExists(atPath: file.path), "Finder source remains")
print("PASS Finder URL")

// Keep the actual native paths alive until Node runs the real UI/API/saveImage
// chain and acknowledges its completed copy. No recreation of the source files.
let bridgeDrag = TestDrag(), bridgeWeb = DropWebView()
let bridgeReceiver = TestReceiver(["bridge.png"], bridgeDrag); bridgeDrag.receivers = [bridgeReceiver]
bridgeDrag.active = true; check(bridgeWeb.performDragOperation(bridgeDrag), "bridge native claimed"); bridgeDrag.active = false
bridgeWeb.begin?("bridge", nil); bridgeReceiver.emit?(); pump()
check(bridgeWeb.delivered.count == 1, "bridge prepared")
let bridgePaths = bridgeWeb.delivered[0]["paths"] as! [String]
print("BRIDGE " + String(data: try! JSONSerialization.data(withJSONObject: ["paths": bridgePaths, "base64": png.base64EncodedString()]), encoding: .utf8)!)
fflush(stdout)
check(readLine() == "saved", "JS must acknowledge the actual save")
bridgeWeb.pending?(.success(true))
check(!FileManager.default.fileExists(atPath: bridgePaths[0]), "source removed only after API copy")
print("PASS native-to-API save and cleanup")
