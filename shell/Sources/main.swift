// ClaudeBot desktop shell: a native macOS window onto the local engine. Closing the window never stops the engine;
// the engine runs under launchd (com.claudebot.engine). The shell reads the UI token from ~/.claudebot/secrets/ui.token.
// The page can ask the shell (window.webkit.messageHandlers.claudebot) to bring the ClaudeBot browser window forward or to
// place it beside this window; the shell only ever activates a process by pid that the engine reported, nothing else.
import Cocoa
import CryptoKit
import WebKit

/// Accept the first click even when the window is not active, so a button (Stop, Talk) works on the first press.
final class AgentWebView: WKWebView { override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true } }

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate, WKUIDelegate {
    let voice = VoiceController()
    var window: NSWindow!
    var webView: WKWebView!
    var lastDownload: URL?
    var statusItem: NSStatusItem!
    let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claudebot")
    var port: Int { if let d = try? Data(contentsOf: home.appendingPathComponent("run/engine.json")), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let p = j["port"] as? Int { return p }; return Int(ProcessInfo.processInfo.environment["CLAUDEBOT_PORT"] ?? "48311") ?? 48311 }
    var token: String { (try? String(contentsOf: home.appendingPathComponent("secrets/ui.token"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        let cfg = WKWebViewConfiguration(); cfg.websiteDataStore = .default()
        cfg.preferences.tabFocusesLinks = true   // keyboard access: Tab reaches every button and link, not only text fields (WebKit's macOS default)
        cfg.userContentController.add(self, name: "claudebot")
        webView = AgentWebView(frame: .zero, configuration: cfg); webView.navigationDelegate = self; webView.uiDelegate = self
        voice.emit = { [weak self] ev in self?.sendVoice(ev) }
        voice.logURL = home.appendingPathComponent("run/voice-events.jsonl")
        voice.onChange = { [weak self] in self?.voiceChanged() }
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        window = ReviewableWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "ClaudeBot"; window.titlebarAppearsTransparent = false; window.minSize = NSSize(width: 960, height: 640)
        // The page sits below a dark title bar (nothing hidden under it), matching the approved dark design.
        window.appearance = NSAppearance(named: .darkAqua); window.backgroundColor = NSColor(srgbRed: 0.055, green: 0.063, blue: 0.075, alpha: 1)
        window.contentView = webView; window.center(); window.setFrameAutosaveName("ClaudeBotMain"); window.makeKeyAndOrderFront(nil)
        window.isReleasedWhenClosed = false; window.delegate = self; writeState(visible: true)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "CB"
        let m = NSMenu(); m.addItem(withTitle: "Open ClaudeBot", action: #selector(showWindow), keyEquivalent: "o"); m.addItem(withTitle: "System status…", action: #selector(openHealth), keyEquivalent: ""); m.addItem(.separator()); m.addItem(withTitle: "Quit ClaudeBot window (engine keeps running)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); statusItem.menu = m
        load()
        NSApp.activate(ignoringOtherApps: true)
    }
    func buildMenu() {
        let main = NSMenu(); let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r"); appMenu.addItem(withTitle: "Hide ClaudeBot", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"); appMenu.addItem(.separator()); appMenu.addItem(withTitle: "Quit (engine keeps running)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem); let edit = NSMenu(title: "Edit"); edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z"); edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"); edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"); edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"); edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"); editItem.submenu = edit
        let winItem = NSMenuItem(); main.addItem(winItem); let win = NSMenu(title: "Window"); win.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m"); win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"); win.addItem(withTitle: "Place browser beside", action: #selector(arrangeBeside), keyEquivalent: "b"); winItem.submenu = win
        NSApp.mainMenu = main
    }
    func load() {
        let t = token
        if t.isEmpty { webView.loadHTMLString(offlineHTML("The UI token at ~/.claudebot/secrets/ui.token is missing. Run install/install.sh."), baseURL: nil); return }
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/?t=\(t)")!))
    }
    @objc func reload() { load() }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func openHealth() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)/?t=\(token)&go=reliability")!) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) { w.loadHTMLString(offlineHTML("The ClaudeBot engine is not reachable on 127.0.0.1:\(port). It runs as a background service (com.claudebot.engine). Start it with: launchctl kickstart -k gui/$(id -u)/com.claudebot.engine — work is not affected by this window."), baseURL: nil); DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.load() } }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
    /// Normal reopen (Dock click, `open -a`, Launchpad) must bring the window back after the owner closed it with the red button.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { if !flag { showWindow() }; return true }
    func applicationDidBecomeActive(_ n: Notification) { if !window.isVisible { showWindow() } }
    func windowWillClose(_ n: Notification) { voice.end(); writeState(visible: false) }
    func applicationWillTerminate(_ n: Notification) { voice.end(); writeState(visible: false) }
    func windowDidBecomeKey(_ n: Notification) { writeState(visible: true); sendVoice(voice.snapshot()) }   // the page re-syncs with the real microphone state
    /// claudebot://show, claudebot://close-window, claudebot://arrange — the same code paths as the buttons, so the native behaviour can be driven and verified without UI automation.
    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls {
            switch u.host ?? u.path.replacingOccurrences(of: "/", with: "") {
            case "show": showWindow()
            case "close-window": window.performClose(nil)
            case "arrange": arrangeBeside()
            case "voice-caps": // claudebot://voice-caps → run/voice-caps.json (no permission prompt; reads what macOS reports)
                var c = voice.capabilities(locale: "en-US"); c["at"] = ISO8601DateFormatter().string(from: Date())
                if let d = try? JSONSerialization.data(withJSONObject: c) { try? d.write(to: home.appendingPathComponent("run/voice-caps.json")) }
            case "voice-selftest": // claudebot://voice-selftest?file=/path.aiff → writes run/voice-selftest.json
                let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems; let file = q?.first(where: { $0.name == "file" })?.value ?? ""
                // Only audio files in temporary folders may be self-tested (no arbitrary file transcription by other apps).
                let real = (URL(fileURLWithPath: file).resolvingSymlinksInPath().path); let tmpOK = real.hasPrefix("/private/tmp/") || real.hasPrefix("/tmp/") || real.hasPrefix(NSTemporaryDirectory().replacingOccurrences(of: "/var/", with: "/private/var/")) || real.hasPrefix(NSTemporaryDirectory())
                guard tmpOK, ["aiff", "aif", "wav", "m4a", "caf"].contains(URL(fileURLWithPath: real).pathExtension.lowercased()) else { break }
                voice.transcribeFile(URL(fileURLWithPath: file), locale: q?.first(where: { $0.name == "locale" })?.value ?? "en-US") { res in
                    var out = res; out["file"] = file; out["at"] = ISO8601DateFormatter().string(from: Date())
                    if let d = try? JSONSerialization.data(withJSONObject: out) { try? d.write(to: self.home.appendingPathComponent("run/voice-selftest.json")) }
                }
            case "voice-fixture": // claudebot://voice-fixture?file=/tmp/x.aiff[&done=1] → a labelled fixture voice turn through the page's real handler.
                // Test-only: requires the flag file run/voice-fixture.allow (created by the acceptance harness, never by the app), so a web page
                // opening this URL cannot make ClaudeBot send anything.
                guard FileManager.default.fileExists(atPath: home.appendingPathComponent("run/voice-fixture.allow").path) else { break }
                let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems; let file = q?.first(where: { $0.name == "file" })?.value ?? ""
                let done = q?.first(where: { $0.name == "done" })?.value == "1"
                guard let data = try? JSONSerialization.data(withJSONObject: ["file": file, "done": done]), let js = String(data: data, encoding: .utf8) else { break }
                showWindow(); webView.evaluateJavaScript("window.claudebotVoiceFixture && window.claudebotVoiceFixture(\(js))", completionHandler: nil)
            case "snapshot": // claudebot://snapshot?name=home-1440x900&w=1440&h=900[&route=home][&wait=3] → run/snapshots/<name>.png of the window's web content (design review)
                let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems
                let name = (q?.first(where: { $0.name == "name" })?.value ?? "snapshot").filter { "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".contains($0) }
                let w = Double(q?.first(where: { $0.name == "w" })?.value ?? "") ?? 0, h = Double(q?.first(where: { $0.name == "h" })?.value ?? "") ?? 0
                let reload = q?.first(where: { $0.name == "reload" })?.value == "1"
                if let route = q?.first(where: { $0.name == "route" })?.value { let r = route.filter { "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.".contains($0) }
                    // With reload, load the page fresh at that route (picks up UI files changed on disk); otherwise just change the hash.
                    if reload, let base = webView.url, var c = URLComponents(url: base, resolvingAgainstBaseURL: false) { c.fragment = r; var items = (c.queryItems ?? []).filter { $0.name != "_r" }; items.append(URLQueryItem(name: "_r", value: String(Int(Date().timeIntervalSince1970)))); c.queryItems = items; if let u2 = c.url { webView.load(URLRequest(url: u2, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)) } }
                    else { webView.evaluateJavaScript("location.hash = '#\(r)'", completionHandler: nil) } }
                else if reload { webView.reloadFromOrigin() }
                showWindow()
                if w >= 600 && h >= 400 && w <= 3000 && h <= 2000 { (window as? ReviewableWindow)?.allowOversize = true; window.setContentSize(NSSize(width: w, height: h)) }
                let delay = Double(q?.first(where: { $0.name == "wait" })?.value ?? "") ?? 3.0
                // Review states, from a fixed list only (no page script comes from the URL): focus a known field, or move the pointer to a point (CSS px) for hover.
                let focusSel = ["composer": "#chat-input", "create": ".plain-edit", "name": ".name-input input"][q?.first(where: { $0.name == "focus" })?.value ?? ""]
                let hoverPt = (q?.first(where: { $0.name == "hover" })?.value ?? "").split(separator: ",").compactMap { Double($0) }
                DispatchQueue.main.asyncAfter(deadline: .now() + min(max(delay, 0.5), 20)) {
                    if let sel = focusSel { self.webView.evaluateJavaScript("(() => { const e = document.querySelector('\(sel)'); if (e) { e.focus(); if (e.setSelectionRange) e.setSelectionRange(e.value.length, e.value.length); } })()", completionHandler: nil) }
                    // "reply": press Reply on the newest assistant message, as the owner would, so the composer shows its Replying-to bar.
                    if q?.first(where: { $0.name == "state" })?.value == "task" { self.webView.evaluateJavaScript("(() => { const b = [...document.querySelectorAll('.ctx-tab')].find((x) => x.textContent === 'Task'); if (b) b.click(); })()", completionHandler: nil) }
                    if q?.first(where: { $0.name == "state" })?.value == "browser" { self.webView.evaluateJavaScript("(() => { const b = [...document.querySelectorAll('.ctx-tab')].find((x) => x.textContent === 'Browser'); if (b) b.click(); })()", completionHandler: nil) }
                    if q?.first(where: { $0.name == "state" })?.value == "top" { self.webView.evaluateJavaScript("(() => { const t = document.querySelector('#transcript'); if (t) { t.dispatchEvent(new Event('wheel')); t.scrollTop = 0; } })()", completionHandler: nil) }
                    if q?.first(where: { $0.name == "state" })?.value == "question" { self.webView.evaluateJavaScript("(() => { const tb = [...document.querySelectorAll('.ctx-tab')].find((x) => x.textContent === 'Task'); if (tb) tb.click(); const c = [...document.querySelectorAll('.choice-list')].pop(); if (c) c.closest('.ev-card').scrollIntoView({ block: 'center' }); })()", completionHandler: nil) }
                    if q?.first(where: { $0.name == "state" })?.value == "reply" { self.webView.evaluateJavaScript("(() => { const b = [...document.querySelectorAll('.m:not(.me) .actions button')].filter((x) => x.textContent === 'Reply').pop(); if (b) b.click(); })()", completionHandler: nil) }
                    // "click": press at the hover point, as the owner would (opens a menu such as More).
                    if q?.first(where: { $0.name == "state" })?.value == "click", hoverPt.count == 2 { self.webView.evaluateJavaScript("(() => { const x = \(hoverPt[0]), y = \(hoverPt[1]); const e = document.elementFromPoint(x, y); if (e) e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })); })()", completionHandler: nil) }
                    // "menu": right-click at the hover point, as the owner would, so the widget's edit menu shows.
                    if q?.first(where: { $0.name == "state" })?.value == "menu", hoverPt.count == 2 { self.webView.evaluateJavaScript("(() => { const x = \(hoverPt[0]), y = \(hoverPt[1]); const e = document.elementFromPoint(x, y); if (e) e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })); })()", completionHandler: nil) }
                    // The page also gets a DOM mousemove at that point (a synthetic window event does not always reach WebKit's hover handlers).
                    if hoverPt.count == 2 { self.webView.evaluateJavaScript("(() => { const x = \(hoverPt[0]), y = \(hoverPt[1]); const e = document.elementFromPoint(x, y); if (e) { e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y })); e.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); } })()", completionHandler: nil) }
                    if hoverPt.count == 2 { let p = self.webView.convert(NSPoint(x: hoverPt[0], y: self.webView.isFlipped ? hoverPt[1] : self.webView.bounds.height - hoverPt[1]), to: nil)
                        if let ev = NSEvent.mouseEvent(with: .mouseMoved, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: self.window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0) { self.webView.mouseMoved(with: ev) } }
                    DispatchQueue.main.asyncAfter(deadline: .now() + (focusSel != nil ? 0.15 : (hoverPt.count == 2 || q?.first(where: { $0.name == "state" }) != nil) ? 0.6 : 0)) {   // a fresh focus shows the caret for its first half-second blink
                    let conf = WKSnapshotConfiguration(); conf.afterScreenUpdates = true
                    self.webView.takeSnapshot(with: conf) { image, _ in
                        guard let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return }
                        let dir = self.home.appendingPathComponent("run/snapshots"); try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                        try? png.write(to: dir.appendingPathComponent("\(name).png"))
                        // The whole native window as the window server composites it (title bar, traffic lights, web content). An app may
                        // capture its own windows; the call is looked up at run time because the SDK marks it deprecated.
                        // The window server leaves out another process's layers without Screen Recording permission, so the web
                        // content area comes back blank: draw this same moment's WKWebView snapshot into exactly that area.
                        if let frame = ownWindowImage(CGWindowID(self.window.windowNumber)), let web = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                            let scale = CGFloat(frame.width) / self.window.frame.width
                            let r = self.webView.convert(self.webView.bounds, to: nil)   // window coordinates, origin bottom-left
                            let cs = CGColorSpace(name: CGColorSpace.sRGB)!
                            if let ctx = CGContext(data: nil, width: frame.width, height: frame.height, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                                ctx.draw(frame, in: CGRect(x: 0, y: 0, width: frame.width, height: frame.height))
                                ctx.draw(web, in: CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale))
                                if let out = ctx.makeImage(), let p2 = NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:]) { try? p2.write(to: dir.appendingPathComponent("\(name)-window.png")) }
                            }
                        }
                        (self.window as? ReviewableWindow)?.allowOversize = false
                    }
                    }
                }
            case "go": // claudebot://go/workbench/<task id> → navigate the already-loaded page (hash only; never a different origin)
                let route = u.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).filter { "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.".contains($0) }
                showWindow(); webView.evaluateJavaScript("location.hash = '#\(route)'", completionHandler: nil)
            default: break
            }
        }
    }
    /// ~/.claudebot/run/shell.json: pid, whether the window is visible, last change. Read by acceptance tests; written only by this shell.
    func writeState(visible: Bool) {
        let f = home.appendingPathComponent("run/shell.json"); let iso = ISO8601DateFormatter().string(from: Date())
        let frame = window.frame; let dict: [String: Any] = ["pid": Int(ProcessInfo.processInfo.processIdentifier), "window_visible": visible, "voice_state": voice.state.rawValue, "mic_active": voice.micActive, "voice_on_device": voice.onDevice as Any? ?? NSNull(), "voice_last_error": voice.lastError as Any? ?? NSNull(), "frame": ["x": Int(frame.minX), "y": Int(frame.minY), "width": Int(frame.width), "height": Int(frame.height)], "updated_at": iso]
        if let d = try? JSONSerialization.data(withJSONObject: dict) { try? d.write(to: f, options: .atomic) }
    }
    /// If WebKit's page process dies (memory pressure, crash), reload instead of leaving a blank window.
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { voice.end(); DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.load() } }
    func offlineHTML(_ msg: String) -> String { "<html><body style='font-family:-apple-system;background:#0f1419;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div style='max-width:560px;padding:32px;border:1px solid #30363d;border-radius:12px'><h2 style='margin-top:0'>ClaudeBot</h2><p>\(msg)</p><p style='color:#8b949e'>Retrying automatically…</p></div></body></html>" }

    // ---- bridge from the page ----
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }   // only the app page itself, never an embedded frame
        switch type {
        case "activate": if let pid = body["pid"] as? Int { activate(pid: pid32(pid)) }
        case "arrange": arrangeBeside()
        case "voice.capabilities": sendVoice(["event": "capabilities"].merging(voice.capabilities(locale: body["locale"] as? String ?? "en-US")) { a, _ in a })
        case "voice.start": voice.start(locale: body["locale"] as? String ?? "en-US", allowServer: body["allowServer"] as? Bool ?? false, silenceSeconds: body["silence"] as? Double ?? 1.8, sid: body["sid"] as? String ?? "")
        case "voice.finish": voice.finish(sid: body["sid"] as? String ?? "")
        case "voice.state": sendVoice(voice.snapshot())
        case "owner.confirm":
            // Owner presence for consequential decisions: a native sheet the page and assistants cannot click. The sheet's text is
            // fetched here from the engine (never taken from the page) and shown in full; the shell checks that it hashes to the
            // stored content hash and signs "<action>|<id>|<hash>|<ts>" with the owner key (~/.claudebot/secrets/owner.key, readable
            // by the owner's processes, not by assistants). The engine accepts only a fresh, single-use signature over that hash.
            let id = body["id"] as? String ?? ""; let action = body["action"] as? String ?? ""
            guard !id.isEmpty, ["approve", "execute", "resolve_performed", "resolve_not_performed", "permit"].contains(action) else { break }
            let reply: ([String: Any]) -> Void = { [weak self] out in
                guard let self, let d = try? JSONSerialization.data(withJSONObject: out), let js = String(data: d, encoding: .utf8) else { return }
                self.webView.evaluateJavaScript("window.claudebotOwnerProof && window.claudebotOwnerProof(\(js))", completionHandler: nil)
            }
            let q = "action=\(action)&id=\(id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            engine("/api/owner/confirm-subject?\(q)", nil) { [weak self] sub in
                guard let self else { return }
                guard let sub, let binding = sub["binding"] as? String, binding.count == 64 else { reply(["id": id, "action": action, "confirmed": false, "error": "Nothing to confirm: this decision was not found."]); return }
                let kind = sub["kind"] as? String ?? ""; let target = sub["target"] as? String ?? ""; let content = sub["content"] as? String ?? ""; let note = sub["note"] as? String ?? ""
                if action == "approve" || action == "execute" || action == "permit" {
                    let h = SHA256.hash(data: Data(content.utf8)).map { String(format: "%02x", $0) }.joined()
                    guard h == binding else { reply(["id": id, "action": action, "confirmed": false, "error": "The content changed; nothing was confirmed."]); return }
                }
                let a = NSAlert(); a.messageText = action == "permit" ? "Always allow this, within these limits?" : action == "approve" ? "Approve exactly this?" : action == "execute" ? "Run this approved action once?" : action == "resolve_performed" ? "Record that this did happen?" : "Record that this did not happen?"
                a.informativeText = "\(kind) → \(target)\n\(content.count) characters · fingerprint \(binding.prefix(12))\(note.isEmpty ? "" : "\n\(String(note.prefix(300)))")"
                a.alertStyle = .warning; a.addButton(withTitle: "Confirm"); a.addButton(withTitle: "Cancel")
                if !content.isEmpty {
                    let sv = NSScrollView(frame: NSRect(x: 0, y: 0, width: 460, height: 220)); sv.hasVerticalScroller = true; sv.borderType = .bezelBorder
                    let tv = NSTextView(frame: sv.bounds); tv.isEditable = false; tv.isSelectable = true; tv.string = content
                    tv.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular); tv.autoresizingMask = [.width]; tv.textContainer?.widthTracksTextView = true
                    sv.documentView = tv; a.accessoryView = sv
                }
                let finish: (NSApplication.ModalResponse) -> Void = { [weak self] r in
                    guard let self else { return }
                    var out: [String: Any] = ["id": id, "action": action, "confirmed": r == .alertFirstButtonReturn]
                    if r == .alertFirstButtonReturn, let key = try? Data(contentsOf: self.home.appendingPathComponent("secrets/owner.key")) {
                        let ts = String(Int(Date().timeIntervalSince1970 * 1000)); let msg = "\(action)|\(id)|\(binding)|\(ts)"
                        out["ts"] = ts; out["proof"] = hmacSHA256Hex(key: key, message: Data(msg.utf8))
                    }
                    reply(out)
                }
                if let win = self.window, win.isVisible { a.beginSheetModal(for: win, completionHandler: finish) } else { finish(a.runModal()) }
            }
        case "voice.startFixture":
            // Only audio files in temporary folders (same rule as voice-selftest).
            let file = body["file"] as? String ?? ""; let real = URL(fileURLWithPath: file).resolvingSymlinksInPath().path
            if (real.hasPrefix("/private/tmp/") || real.hasPrefix("/tmp/")) && ["aiff", "aif", "wav", "m4a", "caf"].contains(URL(fileURLWithPath: real).pathExtension.lowercased()) { voice.startFixture(file: URL(fileURLWithPath: real), sid: body["sid"] as? String ?? "") }
        case "voice.speak": if let t = body["text"] as? String { voice.speak(t, voiceId: body["voice"] as? String) }
        case "voice.stopSpeaking": voice.stopSpeaking()
        case "voice.end": voice.end()
        default: break
        }
    }
    func sendVoice(_ ev: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: ev), let json = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.webView.evaluateJavaScript("window.claudebotVoiceEvent && window.claudebotVoiceEvent(\(json))", completionHandler: nil) }
    }
    func voiceChanged() { statusItem?.button?.title = voice.micActive ? "CB ● mic" : voice.state == .speaking ? "CB ♪" : "CB"; writeState(visible: window?.isVisible ?? false) }

    // ---- native JavaScript panels: without these WKWebView silently answers confirm() with false (the Stop button did nothing) ----
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = "ClaudeBot"; a.informativeText = message; a.addButton(withTitle: "OK")
        if let win = window, win.isVisible { a.beginSheetModal(for: win) { _ in completionHandler() } } else { a.runModal(); completionHandler() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = "ClaudeBot"; a.informativeText = message; a.alertStyle = .warning
        a.addButton(withTitle: "Confirm"); a.addButton(withTitle: "Cancel")
        if let win = window, win.isVisible { a.beginSheetModal(for: win) { r in completionHandler(r == .alertFirstButtonReturn) } } else { completionHandler(a.runModal() == .alertFirstButtonReturn) }
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = "ClaudeBot"; a.informativeText = prompt; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); field.stringValue = defaultText ?? ""; a.accessoryView = field
        let done: (NSApplication.ModalResponse) -> Void = { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
        if let win = window, win.isVisible { a.beginSheetModal(for: win, completionHandler: done); a.window.makeFirstResponder(field) } else { done(a.runModal()) }
    }
    func pid32(_ p: Int) -> pid_t { pid_t(truncatingIfNeeded: p) }
    func activate(pid: pid_t) { NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps]) }
    func engine(_ path: String, _ json: [String: Any]?, _ done: @escaping ([String: Any]?) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!); req.httpMethod = json == nil ? "GET" : "POST"
        req.setValue(token, forHTTPHeaderField: "x-claudebot-token"); req.setValue("application/json", forHTTPHeaderField: "content-type")
        if let j = json { req.httpBody = try? JSONSerialization.data(withJSONObject: j) }
        URLSession.shared.dataTask(with: req) { d, _, _ in DispatchQueue.main.async { done(d.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) } }.resume()
    }
    /// Tile: this window on the left 56% of the visible screen, the ClaudeBot browser window on the right 44% (via DevTools window bounds), then show both.
    @objc func arrangeBeside() {
        guard let screen = window.screen ?? NSScreen.main else { return }
        let v = screen.visibleFrame; let total = screen.frame
        // Keep the app at least 1100 pt wide when the screen allows (sidebar + chat + in-app browser pane), the real browser gets the rest (at least 420 pt).
        let leftW = max(min(v.width - 420, max(floor(v.width * 0.6), 1100)), floor(v.width * 0.5)); let rightW = v.width - leftW
        window.setFrame(NSRect(x: v.minX, y: v.minY, width: leftW, height: v.height), display: true, animate: true)
        // DevTools uses top-left screen coordinates; AppKit uses bottom-left.
        let top = Int(total.maxY - v.maxY); let left = Int(v.minX + leftW)
        engine("/api/browser/arrange", ["left": left, "top": top, "width": Int(rightW), "height": Int(v.height)]) { _ in
            self.engine("/api/browser/live", nil) { live in
                if let pid = live?["pid"] as? Int { self.activate(pid: self.pid32(pid)) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.window.orderFrontRegardless() }
            }
        }
    }
}
let app = NSApplication.shared; let delegate = AppDelegate(); app.delegate = delegate; app.run()

/// HMAC-SHA256 as lowercase hex (owner-presence signatures).
func hmacSHA256Hex(key: Data, message: Data) -> String {
    let mac = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key))
    return mac.map { String(format: "%02x", $0) }.joined()
}

/// A window that may be sized larger than the screen only while a design-review snapshot is taken (so 1440x900 content can be
/// captured exactly on a smaller display). Normal use keeps the standard on-screen constraint.
final class ReviewableWindow: NSWindow {
    var allowOversize = false
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { allowOversize ? frameRect : super.constrainFrameRect(frameRect, to: screen) }
}

/// Downloads (an owner pressing Download on a result): saved to ~/Downloads under a unique name, then shown in Finder.
extension AppDelegate: WKDownloadDelegate {
    func webView(_ w: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow) }
    func webView(_ w: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let r = navigationResponse.response as? HTTPURLResponse, (r.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment") { decisionHandler(.download); return }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ d: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? FileManager.default.homeDirectoryForCurrentUser
        let safe = suggestedFilename.replacingOccurrences(of: "/", with: "_"); let base = (safe as NSString).deletingPathExtension; let ext = (safe as NSString).pathExtension
        var url = dir.appendingPathComponent(safe); var i = 2
        while FileManager.default.fileExists(atPath: url.path) { url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)"); i += 1 }
        lastDownload = url; completionHandler(url)
    }
    func downloadDidFinish(_ d: WKDownload) { if let u = lastDownload { NSWorkspace.shared.activateFileViewerSelecting([u]) } }
}

/// CGWindowListCreateImage for one of this app's own windows, resolved with dlsym (deprecated in the SDK, still present at run time).
func ownWindowImage(_ id: CGWindowID) -> CGImage? {
    typealias Fn = @convention(c) (CGRect, UInt32, CGWindowID, UInt32) -> Unmanaged<CGImage>?
    guard let h = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW), let sym = dlsym(h, "CGWindowListCreateImage") else { return nil }
    let f = unsafeBitCast(sym, to: Fn.self)
    // CGRectNull, kCGWindowListOptionIncludingWindow (8), image options: ignore framing/shadow (1) | best resolution (8)
    return f(CGRect.null, 8, id, 9)?.takeRetainedValue()
}
