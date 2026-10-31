// Independent implementation using Apple's Accessibility API. Reference designs
// and their differences are recorded in docs/NORMAL_LAUNCH_MICROPHONE.md.
import AppKit
import ApplicationServices
import Darwin

enum ControlError: String, Error {
    case accessibility, ambiguous
    case appNotRunning = "app-not-running", composerNotFound = "composer-not-found"
    case alreadyRecording = "already-recording", startUnconfirmed = "start-unconfirmed"
    case stopUnconfirmed = "stop-unconfirmed", scopeLost = "scope-lost"
    case pressFailed = "press-failed", sessionMismatch = "session-mismatch"
}

let startLabels: Set<String> = ["dictate", "start dictation", "音声入力", "音声入力を開始"]
let stopLabels: Set<String> = ["stop dictation", "音声入力を停止"]

final class QueryBudget {
    private var remaining = 2000
    private let deadline = Date().addingTimeInterval(4)
    private(set) var exhausted = false
    func take() -> Bool {
        remaining -= 1
        if remaining < 0 || Date() >= deadline { exhausted = true }
        return !exhausted
    }
}
var queryBudget = QueryBudget()

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    guard queryBudget.take() else { return nil }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func text(_ element: AXUIElement, _ name: String) -> String? { attribute(element, name) as? String }
func equal(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { CFEqual(lhs, rhs) }
func isComposer(_ element: AXUIElement) -> Bool {
    guard text(element, kAXRoleAttribute) == kAXTextAreaRole as String else { return false }
    var settable = DarwinBoolean(false)
    guard queryBudget.take() else { return false }
    return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

// Only role and button metadata are inspected. Composer values, selected text,
// conversation text and audio are never read, returned or logged.
func walk(_ root: AXUIElement, limit: Int, deadline: Date, visit: (AXUIElement) -> Void) throws {
    guard text(root, kAXRoleAttribute) != nil else { throw ControlError.scopeLost }
    var stack = [root], seen = Set<AXUIElement>(), count = 0
    while let element = stack.popLast() {
        guard seen.insert(element).inserted else { continue }
        count += 1
        guard count <= limit, Date() < deadline else { throw ControlError.composerNotFound }
        visit(element)
        if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: children) }
    }
}
struct Controls {
    var start: [AXUIElement] = [], stop: [AXUIElement] = []
    var recording: Bool { stop.count == 1 && start.isEmpty }
    func validate() throws {
        if start.count > 1 || stop.count > 1 || (!start.isEmpty && !stop.isEmpty) { throw ControlError.ambiguous }
    }
}
func controls(in scope: AXUIElement) throws -> Controls {
    var result = Controls()
    try walk(scope, limit: 300, deadline: Date().addingTimeInterval(1.0)) { element in
        guard text(element, kAXRoleAttribute) == kAXButtonRole as String else { return }
        let labels = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].compactMap { text(element, $0) }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        if labels.contains(where: startLabels.contains), attribute(element, kAXEnabledAttribute) as? Bool != false { result.start.append(element) }
        if labels.contains(where: stopLabels.contains) { result.stop.append(element) }
    }
    guard !queryBudget.exhausted else { throw ControlError.composerNotFound }
    try result.validate()
    return result
}
func composerScope(_ composer: AXUIElement) -> AXUIElement? {
    var node: AXUIElement? = composer
    for _ in 0..<14 {
        guard let current = node else { return nil }
        // Never broaden to the entire window or app just to find a button.
        let role = text(current, kAXRoleAttribute)
        if role == kAXWindowRole as String || role == kAXApplicationRole as String || role == "AXWebArea" { return nil }
        if let found = try? controls(in: current), !found.start.isEmpty || !found.stop.isEmpty { return current }
        node = axElement(attribute(current, kAXParentAttribute))
    }
    return nil
}
func findScope() throws -> AXUIElement {
    guard AXIsProcessTrusted() else {
        throw ControlError.accessibility
    }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
    guard apps.count == 1, let app = apps.first else { throw ControlError.appNotRunning }
    app.activate(options: [.activateIgnoringOtherApps])
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.2)
    let deadline = Date().addingTimeInterval(0.5)
    while !app.isActive && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.03)) }
    guard app.isActive else { throw ControlError.composerNotFound }
    if let focused = axElement(attribute(root, kAXFocusedUIElementAttribute)), isComposer(focused), let scope = composerScope(focused) { return scope }
    guard let window = axElement(attribute(root, kAXFocusedWindowAttribute)) ?? axElement(attribute(root, kAXMainWindowAttribute)) else { throw ControlError.composerNotFound }
    var scopes: [AXUIElement] = []
    try walk(window, limit: 1200, deadline: Date().addingTimeInterval(2.0)) { element in
        if isComposer(element), let scope = composerScope(element), !scopes.contains(where: { equal($0, scope) }) { scopes.append(scope) }
    }
    guard !queryBudget.exhausted else { throw ControlError.composerNotFound }
    guard scopes.count == 1, let scope = scopes.first else { throw scopes.isEmpty ? ControlError.composerNotFound : ControlError.ambiguous }
    return scope
}
func press(_ control: AXUIElement) throws {
    guard attribute(control, kAXEnabledAttribute) as? Bool != false else { throw ControlError.pressFailed }
    guard queryBudget.take() else { throw ControlError.pressFailed }
    let result = AXUIElementPerformAction(control, kAXPressAction as CFString)
    // cannotComplete can mean the action ran but its callback timed out. Never
    // retry a toggle; prove the resulting phase instead.
    if result != .success && result != .cannotComplete { throw ControlError.pressFailed }
}

final class DictationController {
    private var session: String?
    private var scope: AXUIElement?
    private var safety: Timer?
    private var safetyFailures = 0
    var safetyStopped: (() -> Void)?
    var safetyFailed: (() -> Void)?
    func start(_ id: String) throws {
        queryBudget = QueryBudget()
        guard session == nil else { throw ControlError.alreadyRecording }
        let target = try findScope()
        let before = try controls(in: target)
        guard before.stop.isEmpty else { throw ControlError.alreadyRecording }
        guard before.start.count == 1 else { throw ControlError.composerNotFound }
        // Keep the exact originating composer. Stop never searches another chat.
        scope = target; session = id
        do {
            try press(before.start[0])
            let deadline = Date().addingTimeInterval(2.0)
            repeat {
                if (try? controls(in: target).recording) == true { scheduleSafety(seconds: 60); return }
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            } while Date() < deadline
            throw ControlError.startUnconfirmed
        } catch {
            // A delayed start may already be recording. Reconcile once using
            // only the exact Stop control in the scope we just pressed.
            if (try? controls(in: target).recording) == true { try? stop(id) }
            // Initial microphone permission or startup can delay recording.
            // Keep a watchdog for a late transition even after returning error.
            if session != nil { scheduleSafety(seconds: 3) }
            throw error
        }
    }
    func stop(_ id: String) throws {
        queryBudget = QueryBudget()
        guard let session else { return }
        guard session == id, let scope else { throw ControlError.sessionMismatch }
        safety?.invalidate()
        defer { if self.session != nil { scheduleSafety(seconds: 2) } }
        let state = try controls(in: scope)
        if state.stop.isEmpty { clear(); return }
        try press(state.stop[0])
        let deadline = Date().addingTimeInterval(1.5)
        repeat {
            if let next = try? controls(in: scope), next.stop.isEmpty { clear(); return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        } while Date() < deadline
        // Do not claim idle after a failed stop; retain the safety watchdog.
        scheduleSafety(seconds: 2)
        throw ControlError.stopUnconfirmed
    }
    func latch(_ id: String) throws {
        queryBudget = QueryBudget()
        guard session == id, let scope, try controls(in: scope).recording else { throw ControlError.sessionMismatch }
        scheduleSafety(seconds: 300)
    }
    func close() { if let session { try? stop(session) }; clear() }
    private func clear() { safety?.invalidate(); safety = nil; session = nil; scope = nil; safetyFailures = 0 }
    private func scheduleSafety(seconds: TimeInterval) {
        safety?.invalidate()
        safety = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self, let id = self.session else { return }
            do { try self.stop(id); self.safetyStopped?() }
            catch {
                self.safetyFailures += 1
                if self.safetyFailures >= 3 { self.clear(); self.safetyFailed?() }
                else { self.scheduleSafety(seconds: 2) }
            }
        }
    }
}

func connectSocket(path: String) throws -> FileHandle {
    var endpoint = stat(), directory = stat()
    let parent = (path as NSString).deletingLastPathComponent
    guard lstat(path, &endpoint) == 0, lstat(parent, &directory) == 0,
          (endpoint.st_mode & S_IFMT) == S_IFSOCK, (directory.st_mode & S_IFMT) == S_IFDIR,
          endpoint.st_uid == getuid(), directory.st_uid == getuid(),
          (endpoint.st_mode & 0o077) == 0, (directory.st_mode & 0o077) == 0 else { throw ControlError.sessionMismatch }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw ControlError.sessionMismatch }
    withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw ControlError.sessionMismatch }
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard result == 0 else { Darwin.close(descriptor); throw ControlError.sessionMismatch }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
}

// These tests use no AX queries, no permission prompt, and no running app.
if CommandLine.arguments.contains("--self-test") {
    precondition(startLabels.contains("Dictate".lowercased()))
    precondition(startLabels.contains("音声入力"))
    precondition(!startLabels.contains("transcribe and send"))
    precondition(!stopLabels.contains("stop voice chat"))
    print("Codex Deck Controls: semantic label checks passed (no UI access).")
    exit(0)
}
if CommandLine.arguments.contains("--permission-status") {
    print("{\"accessibility\":\(AXIsProcessTrusted())}")
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
// Complete Launch Services startup before showing a modal setup alert. Otherwise
// callers can time out and relaunch even though an alert is already on screen.
application.finishLaunching()
let args = CommandLine.arguments
if let index = args.firstIndex(of: "--connect"), index + 1 < args.count,
   let tokenIndex = args.firstIndex(of: "--token"), tokenIndex + 1 < args.count {
    let controller = DictationController()
    do {
        let connection = try connectSocket(path: args[index + 1])
        func send(_ value: [String: Any]) {
            if let data = try? JSONSerialization.data(withJSONObject: value) { try? connection.write(contentsOf: data + Data([10])) }
        }
        send(["token": args[tokenIndex + 1]])
        controller.safetyStopped = { send(["event": "safety-stop"]) }
        controller.safetyFailed = { send(["event": "safety-stop-failed"]) }
        var buffer = Data()
        connection.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                if data.isEmpty { controller.close(); application.terminate(nil); return }
                buffer.append(data)
                if buffer.count > 16_384 { controller.close(); application.terminate(nil); return }
                while let end = buffer.firstIndex(of: 10) {
                    let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
                    guard let packet = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                          let id = packet["id"] as? Int, let command = packet["command"] as? String,
                          let session = packet["session"] as? String, UUID(uuidString: session) != nil else { controller.close(); application.terminate(nil); return }
                    do {
                        switch command {
                        case "start": try controller.start(session)
                        case "stop": try controller.stop(session)
                        case "latch": try controller.latch(session)
                        default: throw ControlError.sessionMismatch
                        }
                        send(["id": id, "ok": true])
                    } catch { send(["id": id, "ok": false, "error": (error as? ControlError)?.rawValue ?? "press-failed"]) }
                }
            }
        }
        application.run()
        controller.close()
        try? connection.close()
    } catch { exit(1) }
} else if args.contains("--setup") {
    // Only the explicit setup action reaches this branch. Concurrent setup
    // launches share a lock; the background microphone service has no setup UI.
    let cache = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/net.tobitti.codexdeck.controls")
    try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let lock = Darwin.open(cache.appendingPathComponent("setup.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { exit(0) }
    defer { Darwin.close(lock) }
    application.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Codex Deck microphone setup"
    alert.informativeText = "Allow Codex Deck Controls in System Settings → Privacy & Security → Accessibility. Add this app if it is missing. Then use the microphone key in OpenDeck: hold to talk, release to transcribe into the composer. Double-press within 350 ms for hands-free recording; press again to stop. ChatGPT keeps responsibility for microphone permission. No prompt is sent automatically."
    alert.addButton(withTitle: "Open Accessibility Settings")
    alert.addButton(withTitle: "Close")
    if alert.runModal() == .alertFirstButtonReturn {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
}
