// Disposable OS drag source/target and synthetic mouse driver. Never ships in Workspace.
import AppKit
import ApplicationServices

func output(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "geometry" {
    output(["primaryTop": NSScreen.screens[0].frame.maxY, "cgHeight": CGDisplayPixelsHigh(CGMainDisplayID()), "cgBoundsHeight": CGDisplayBounds(CGMainDisplayID()).height, "screens": NSScreen.screens.map { ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height] }]); exit(0)
}
if arguments.count == 6 && arguments[1] == "drag" {
    guard AXIsProcessTrusted(), let sx = Double(arguments[2]), let sy = Double(arguments[3]), let tx = Double(arguments[4]), let ty = Double(arguments[5]) else { fatalError("Existing Accessibility permission and coordinates are required") }
    let source = CGEventSource(stateID: .combinedSessionState)
    func post(_ type: CGEventType, _ x: Double, _ y: Double) {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
        event.post(tap: .cghidEventTap)
    }
    post(.mouseMoved, sx, sy); Thread.sleep(forTimeInterval: 0.15)
    post(.leftMouseDown, sx, sy); Thread.sleep(forTimeInterval: 0.2)
    for index in 1...45 {
        let ratio = Double(index) / 45
        post(.leftMouseDragged, sx + (tx - sx) * ratio, sy + (ty - sy) * ratio)
        Thread.sleep(forTimeInterval: 0.025)
    }
    Thread.sleep(forTimeInterval: 0.25); post(.leftMouseUp, tx, ty)
    output(["dragPosted": true]); exit(0)
}
guard arguments.count == 4 && arguments[1] == "serve" else { fatalError("serve <source file> <destination folder> | drag <sx> <sy> <tx> <ty>") }
let sourcePath = arguments[2], destination = URL(fileURLWithPath: arguments[3], isDirectory: true)
final class TransferView: NSView, NSDraggingSource {
    override init(frame: NSRect) { super.init(frame: frame); registerForDraggedTypes([.fileURL]) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill(); bounds.fill()
        ("Drag fixture.txt into Workspace" as NSString).draw(at: NSPoint(x: 12, y: 105), withAttributes: [.foregroundColor: NSColor.labelColor])
        ("Drop project files here" as NSString).draw(at: NSPoint(x: 12, y: 35), withAttributes: [.foregroundColor: NSColor.labelColor])
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        output(["sourceMouseDown": true, "x": event.locationInWindow.x, "y": event.locationInWindow.y])
        let url = NSURL(fileURLWithPath: sourcePath)
        let item = NSDraggingItem(pasteboardWriter: url)
        item.setDraggingFrame(NSRect(x: 25, y: 90, width: 40, height: 40), contents: NSWorkspace.shared.icon(forFile: sourcePath))
        beginDraggingSession(with: [item], event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { [.copy, .move] }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { output(["sourceDragEnd": true, "operation": operation.rawValue, "x": screenPoint.x, "y": screenPoint.y]) }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .move }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { true }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty else { return false }
        do {
            for url in urls { try FileManager.default.moveItem(at: url, to: destination.appendingPathComponent(url.lastPathComponent)) }
            output(["moved": urls.map { $0.lastPathComponent }]); return true
        } catch { output(["error": error.localizedDescription]); return false }
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let screen = NSScreen.screens[0].frame
let window = NSWindow(contentRect: NSRect(x: screen.maxX - 310, y: screen.maxY - 290, width: 290, height: 170), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Workspace File Transfer Fixture"
window.contentView = TransferView(frame: NSRect(x: 0, y: 0, width: 290, height: 170))
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
let content = window.contentView!.convert(NSPoint(x: 140, y: 115), to: nil)
let point = window.convertPoint(toScreen: content)
output(["ready": true, "sourceX": point.x, "sourceY": NSScreen.screens[0].frame.maxY - point.y, "targetX": point.x, "targetY": NSScreen.screens[0].frame.maxY - point.y + 75])
application.run()
