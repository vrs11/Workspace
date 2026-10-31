// Disposable native clipboard/key helper. Keep the user's clipboard only in RAM.
import AppKit
import ApplicationServices
func output(_ value: [String: Any]) { let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); FileHandle.standardOutput.write(data + Data([10])) }
let board = NSPasteboard.general
let args = CommandLine.arguments
if (args.count == 3 || args.count == 4) && args[1] == "key", let key = UInt16(args[2]) {
    guard AXIsProcessTrusted() else { fatalError("Existing Accessibility permission required") }
    let source = CGEventSource(stateID: .combinedSessionState)
    for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)!; event.flags = args.count == 4 && args[3] == "alt" ? .maskAlternate : .maskCommand; event.post(tap: .cghidEventTap) }
    output(["posted": true]); exit(0)
}
guard args.count == 3 && args[1] == "serve" else { fatalError("serve <fixture root> | key <code>") }
let root = URL(fileURLWithPath: args[2]).standardizedFileURL.path + "/"
var saved: [[NSPasteboard.PasteboardType: Data]] = []
var bytes = 0
for item in board.pasteboardItems ?? [] {
    var values: [NSPasteboard.PasteboardType: Data] = [:]
    for type in item.types {
        guard let value = item.data(forType: type) else { fatalError("Cannot preserve the current clipboard without loss") }
        bytes += value.count; guard bytes <= 16 * 1024 * 1024 else { fatalError("Current clipboard exceeds the test preservation bound") }
        values[type] = value
    }
    saved.append(values)
}
var ownedCount = board.changeCount
func restore() -> Bool {
    guard board.changeCount == ownedCount else { return false }
    board.clearContents()
    let items = saved.map { values -> NSPasteboardItem in let item = NSPasteboardItem(); for (type, data) in values { item.setData(data, forType: type) }; return item }
    return items.isEmpty || board.writeObjects(items)
}
output(["ready": true, "clipboardPreservedInMemory": true])
while let line = readLine(), let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
    switch command["action"] as? String {
    case "write":
        let paths = command["paths"] as? [String] ?? []
        guard !paths.isEmpty && paths.allSatisfy({ URL(fileURLWithPath: $0).standardizedFileURL.path.hasPrefix(root) }) else { output(["error": "Non-fixture clipboard request refused"]); continue }
        board.clearContents(); let ok = board.writeObjects(paths.map { NSURL(fileURLWithPath: $0) }); ownedCount = board.changeCount
        output(["written": ok, "count": paths.count])
    case "verify":
        let expected = command["paths"] as? [String] ?? []
        let actual = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []).map { $0.standardizedFileURL.path }
        let matches = actual == expected && actual.allSatisfy { $0.hasPrefix(root) }
        if matches { ownedCount = board.changeCount }
        output(["matches": matches, "count": actual.count])
    case "restore": output(["restored": restore()]); exit(0)
    default: output(["error": "Unknown test action"])
    }
}
_ = restore()
