// Voice for ClaudeBot: macOS speech recognition (SFSpeechRecognizer) and speech synthesis (AVSpeechSynthesizer).
// Claude stays the intelligence: recognized text is sent as an ordinary chat message to the same lead assistant through the
// engine; the spoken reply is that assistant's saved text read aloud. Nothing here talks to a model or a paid service.
//
// Privacy rules implemented here:
//  - the microphone is off until the owner presses Talk; macOS permission prompts appear only then;
//  - recognition runs on this Mac (requiresOnDeviceRecognition) whenever the recognizer supports it; if it does not, nothing
//    is started unless the page passes the owner's explicit consent to Apple's server recognition (allowServer);
//  - half duplex: capture is stopped before anything is spoken, so replies cannot be transcribed back;
//  - capture is released on End voice, on window close and on quit; the state is mirrored to run/shell.json.
import Cocoa
import AVFoundation
import Speech

/// macOS 26 on-device transcription (SpeechAnalyzer + SpeechTranscriber). Runs entirely on this Mac and does not depend on the
/// Siri/Dictation switch. Live microphone buffers are converted to the analyzer's format and streamed in.
@available(macOS 26.0, *)
final class AnalyzerSession {
    let transcriber: SpeechTranscriber; let analyzer: SpeechAnalyzer
    private var cont: AsyncStream<AnalyzerInput>.Continuation?
    private var format: AVAudioFormat?; private var converter: AVAudioConverter?
    private var finalized = ""; private var volatile = ""; private var resultsTask: Task<Void, Never>?
    init(locale: Locale) { transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: []); analyzer = SpeechAnalyzer(modules: [transcriber]) }
    static func usable(_ locale: Locale) async -> Bool { let inst = await SpeechTranscriber.installedLocales; return inst.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) } }
    func start(onText: @escaping (String) -> Void) async throws {
        format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
        let (stream, c) = AsyncStream<AnalyzerInput>.makeStream(); cont = c
        resultsTask = Task { [weak self] in
            guard let self else { return }
            do { for try await r in self.transcriber.results { let t = String(r.text.characters); if r.isFinal { self.finalized += t; self.volatile = "" } else { self.volatile = t }; let all = (self.finalized + self.volatile).trimmingCharacters(in: .whitespaces); DispatchQueue.main.async { onText(all) } } } catch { }
        }
        try await analyzer.start(inputSequence: stream)
    }
    func append(_ buf: AVAudioPCMBuffer) {
        guard let cont, let format else { return }
        if buf.format == format { cont.yield(AnalyzerInput(buffer: buf)); return }
        if converter == nil || converter?.inputFormat != buf.format { converter = AVAudioConverter(from: buf.format, to: format) }
        guard let converter else { return }
        let cap = AVAudioFrameCount(Double(buf.frameLength) * format.sampleRate / buf.format.sampleRate) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return }
        var fed = false; var err: NSError?
        converter.convert(to: out, error: &err) { _, status in if fed { status.pointee = .noDataNow; return nil }; fed = true; status.pointee = .haveData; return buf }
        if err == nil && out.frameLength > 0 { cont.yield(AnalyzerInput(buffer: out)) }
    }
    func finish() async -> String { cont?.finish(); try? await analyzer.finalizeAndFinishThroughEndOfInput(); await resultsTask?.value; return (finalized + volatile).trimmingCharacters(in: .whitespacesAndNewlines) }
    func cancel() { cont?.finish(); let a = analyzer; Task { await a.cancelAndFinishNow() }; resultsTask?.cancel() }
}

final class VoiceController: NSObject, AVSpeechSynthesizerDelegate {
    enum State: String { case off, starting, listening, transcribing, speaking }
    private(set) var state: State = .off { didSet { onChange?() } }
    private(set) var micActive = false { didSet { onChange?() } }
    private(set) var onDevice: Bool? = nil
    private(set) var lastError: String? = nil
    var onChange: (() -> Void)?
    var emit: (([String: Any]) -> Void)?

    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private let synth = AVSpeechSynthesizer()
    private var silenceTimer: Timer?
    private var maxTimer: Timer?
    private var lastText = ""
    private var analyzerBox: AnyObject?   // AnalyzerSession on macOS 26
    private(set) var engineName = "none"
    private var finished = false
    /// Session generation. Every start and every end bumps it; asynchronous work captures the value it started with and does
    /// nothing if it changed meanwhile (End during startup, a new Talk during transcription, a late recognizer callback).
    private(set) var gen = 0
    /// The page's id for the current session, echoed on every event so the page can drop events from ended sessions.
    private var sid: String = ""
    private(set) var fixture = false
    private func live(_ g: Int) -> Bool { g == gen }
    private func send(_ ev: [String: Any]) { var e = ev; e["sid"] = sid; e["gen"] = gen; if fixture { e["fixture"] = true }; log(e); emit?(e) }
    /// Audit trail of voice events (never transcript text) in ~/.claudebot/run/voice-events.jsonl, so microphone use can be
    /// accounted for afterwards. Rotated at 512 KB.
    var logURL: URL? = nil
    private func log(_ e: [String: Any]) {
        guard let url = logURL else { return }
        var row: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()), "event": e["event"] ?? "", "sid": sid, "gen": gen, "state": state.rawValue, "mic_active": micActive]
        for k in ["fixture", "interrupted", "code", "on_device"] { if let v = e[k] { row[k] = v } }
        if let t = e["text"] as? String { row["chars"] = t.count }
        guard var d = try? JSONSerialization.data(withJSONObject: row) else { return }; d.append(0x0a)
        if let a = try? FileManager.default.attributesOfItem(atPath: url.path), (a[.size] as? Int ?? 0) > 512_000 { try? FileManager.default.removeItem(at: url.appendingPathExtension("1")); try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("1")) }
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(d); try? h.close() } else { try? d.write(to: url) }
    }

    override init() { super.init(); synth.delegate = self }

    /// What this Mac can do, without prompting for anything.
    func capabilities(locale: String) -> [String: Any] {
        let r = SFSpeechRecognizer(locale: Locale(identifier: locale))
        return ["locale": locale, "recognizer": r != nil, "available": r?.isAvailable ?? false, "on_device": r?.supportsOnDeviceRecognition ?? false,
                "speech_auth": authName(SFSpeechRecognizer.authorizationStatus()), "mic_auth": micAuthName(AVCaptureDevice.authorizationStatus(for: .audio)),
                "input_device": AVCaptureDevice.default(for: .audio)?.localizedName ?? NSNull(), "synthesis": true, "speech_transcriber": { if #available(macOS 26.0, *) { return true } else { return false } }()]
    }
    private func authName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String { switch s { case .authorized: return "authorized"; case .denied: return "denied"; case .restricted: return "restricted"; case .notDetermined: return "not_determined"; @unknown default: return "unknown" } }
    private func micAuthName(_ s: AVAuthorizationStatus) -> String { switch s { case .authorized: return "authorized"; case .denied: return "denied"; case .restricted: return "restricted"; case .notDetermined: return "not_determined"; @unknown default: return "unknown" } }

    private func fail(_ code: String, _ message: String, _ g: Int? = nil) { if let g, !live(g) { return }; lastError = code; gen += 1; releaseCapture(); state = .off; send(["event": "error", "code": code, "message": message]) }

    /// Push-to-talk turn: permissions → on-device check → capture until silence (or `finish()`), then emit the final transcript.
    func start(locale: String, allowServer: Bool, silenceSeconds: Double, sid: String = "") {
        if state == .starting || state == .listening || state == .transcribing { return }
        if state == .speaking { state = .off; synth.stopSpeaking(at: .immediate) }
        lastError = nil; gen += 1; let g = gen; self.sid = sid; finished = false; fixture = false
        state = .starting
        if #available(macOS 26.0, *) {
            Task { @MainActor in
                let ok = await AnalyzerSession.usable(Locale(identifier: locale))
                guard self.live(g) else { return }          // ended while checking
                if ok { self.withMic(g) { self.beginAnalyzer(locale: locale, silenceSeconds: silenceSeconds, g: g) }; return }
                self.startLegacy(locale: locale, allowServer: allowServer, silenceSeconds: silenceSeconds, g: g)
            }
            return
        }
        startLegacy(locale: locale, allowServer: allowServer, silenceSeconds: silenceSeconds, g: g)
    }

    private func withMic(_ g: Int, _ go: @escaping () -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: go()
        case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { guard self.live(g) else { return }; ok ? go() : self.fail("mic_denied", "Microphone access was not allowed. Turn on ClaudeBot in System Settings › Privacy & Security › Microphone, or keep typing.", g) } }
        default: fail("mic_denied", "Microphone access is off for ClaudeBot. Turn it on in System Settings › Privacy & Security › Microphone, or keep typing.", g)
        }
    }

    @available(macOS 26.0, *)
    private func beginAnalyzer(locale: String, silenceSeconds: Double, g: Int) {
        guard live(g) else { return }
        let session = AnalyzerSession(locale: Locale(identifier: locale)); analyzerBox = session; engineName = "SpeechTranscriber (on-device)"; onDevice = true
        lastText = ""; finished = false
        let input = audio.inputNode; let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0 && fmt.channelCount > 0 else { fail("no_input", "No microphone input is available. Connect or select a microphone, or keep typing.", g); return }
        Task { @MainActor in
            do { try await session.start(onText: { [weak self] text in guard let self, self.live(g), self.state == .listening, text != self.lastText else { return }; self.lastText = text; self.send(["event": "partial", "text": text]); self.armSilence(silenceSeconds, g) }) }
            catch { self.fail("unavailable", "On-device speech recognition could not start: \(error.localizedDescription). Keep typing.", g); return }
            // End (or a newer Talk) may have happened while the analyzer was starting: never open the microphone for a dead session.
            guard self.live(g) else { session.cancel(); return }
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { buf, _ in session.append(buf) }; self.tapInstalled = true
            self.audio.prepare()
            do { try self.audio.start() } catch { self.fail("no_input", "The microphone could not start: \(error.localizedDescription)", g); return }
            self.micActive = true; self.state = .listening; self.log(["event": "mic_opened"])
            self.send(["event": "listening", "on_device": true, "engine": self.engineName])
            self.maxTimer?.invalidate(); self.maxTimer = Timer.scheduledTimer(withTimeInterval: 900, repeats: false) { [weak self] _ in self?.finish(g) }   // only a safety cap (15 min); the owner's tap or the silence rule ends a turn
            self.armSilence(max(silenceSeconds, 8), g)
        }
    }

    private func startLegacy(locale: String, allowServer: Bool, silenceSeconds: Double, g: Int) {
        engineName = "SFSpeechRecognizer"
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else { fail("unavailable", "Speech recognition is not available for \(locale) on this Mac. Type your message instead.", g); return }
        recognizer = r
        let go: () -> Void = { [weak self] in
            guard let self, self.live(g) else { return }
            guard r.isAvailable else { self.fail("unavailable", "macOS speech recognition is unavailable right now. Type your message instead.", g); return }
            if r.supportsOnDeviceRecognition { self.onDevice = true }
            else if allowServer { self.onDevice = false }
            else { self.onDevice = false; self.gen += 1; self.state = .off; self.send(["event": "needs_server_consent", "message": "This Mac cannot recognize \(locale) speech on the device. Apple's speech recognition service would receive the audio. Nothing was recorded."]); return }
            self.beginCapture(r, silenceSeconds: silenceSeconds, g: g)
        }
        let afterSpeech: () -> Void = {
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: go()
            case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { guard self.live(g) else { return }; ok ? go() : self.fail("mic_denied", "Microphone access was not allowed. Turn on ClaudeBot in System Settings › Privacy & Security › Microphone, or keep typing.", g) } }
            default: self.fail("mic_denied", "Microphone access is off for ClaudeBot. Turn it on in System Settings › Privacy & Security › Microphone, or keep typing.", g)
            }
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: afterSpeech()
        case .notDetermined: SFSpeechRecognizer.requestAuthorization { s in DispatchQueue.main.async { guard self.live(g) else { return }; s == .authorized ? afterSpeech() : self.fail("speech_denied", "Speech recognition was not allowed. Turn on ClaudeBot in System Settings › Privacy & Security › Speech Recognition, or keep typing.", g) } }
        default: fail("speech_denied", "Speech recognition is off for ClaudeBot. Turn it on in System Settings › Privacy & Security › Speech Recognition, or keep typing.", g)
        }
    }

    private func beginCapture(_ r: SFSpeechRecognizer, silenceSeconds: Double, g: Int) {
        guard live(g) else { return }
        let req = SFSpeechAudioBufferRecognitionRequest(); req.shouldReportPartialResults = true; req.requiresOnDeviceRecognition = onDevice == true
        if #available(macOS 13, *) { req.addsPunctuation = true }
        request = req; lastText = ""; finished = false
        let input = audio.inputNode; let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0 && fmt.channelCount > 0 else { fail("no_input", "No microphone input is available. Connect or select a microphone, or keep typing.", g); return }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in self?.request?.append(buf) }; tapInstalled = true
        audio.prepare()
        do { try audio.start() } catch { fail("no_input", "The microphone could not start: \(error.localizedDescription)", g); return }
        micActive = true; state = .listening; log(["event": "mic_opened"])
        send(["event": "listening", "on_device": onDevice == true])
        committed = ""; userFinishing = false; startSegment(r, req, silenceSeconds: silenceSeconds, g: g)
        armSilence(max(silenceSeconds, 8), g)   // allow time to begin speaking
    }
    /// One recognition segment. macOS can end a segment on its own (a pause, or its time limit): the words so far are kept and a new
    /// segment continues on the same microphone, so nothing is cut off. Only the owner's tap (finish) or the silence rule ends the turn.
    private var committed = ""; private var userFinishing = false
    private func startSegment(_ r: SFSpeechRecognizer, _ req: SFSpeechAudioBufferRecognitionRequest, silenceSeconds: Double, g: Int) {
        request = req
        task = r.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.live(g) else { return }
                if let result {
                    let seg = result.bestTranscription.formattedString
                    let text = [self.committed, seg].filter { !$0.isEmpty }.joined(separator: " ")
                    if text != self.lastText { self.lastText = text; self.send(["event": "partial", "text": text]); self.armSilence(silenceSeconds, g) }
                    if result.isFinal {
                        if self.userFinishing || self.finished { self.deliver(text, g); return }
                        self.committed = text   // the segment ended by itself: keep its words and listen on
                        let next = SFSpeechAudioBufferRecognitionRequest(); next.shouldReportPartialResults = true; next.requiresOnDeviceRecognition = self.onDevice == true
                        if #available(macOS 13, *) { next.addsPunctuation = true }
                        self.startSegment(r, next, silenceSeconds: silenceSeconds, g: g); return
                    }
                }
                if let error, !self.finished {
                    let ns = error as NSError
                    if ns.localizedDescription.localizedCaseInsensitiveContains("dictation") || ns.localizedDescription.localizedCaseInsensitiveContains("siri") { self.finished = true; self.fail("dictation_disabled", "macOS speech recognition is switched off on this Mac (Siri and Dictation are disabled). Turn on Dictation in System Settings › Keyboard, or keep typing.", g); return }
                    if self.lastText.isEmpty && ns.code == 1110 && !self.userFinishing {
                        // no speech yet in this segment: keep listening (the silence rule decides when to stop)
                        let next = SFSpeechAudioBufferRecognitionRequest(); next.shouldReportPartialResults = true; next.requiresOnDeviceRecognition = self.onDevice == true
                        self.startSegment(r, next, silenceSeconds: silenceSeconds, g: g); return
                    }
                    if self.lastText.isEmpty { self.finished = true; self.releaseCapture(); self.gen += 1; self.state = .off; self.send(["event": "no_speech", "message": "I didn't hear anything. Nothing was sent."]) }
                    else if ns.code == 1110 && !self.userFinishing { let next = SFSpeechAudioBufferRecognitionRequest(); next.shouldReportPartialResults = true; next.requiresOnDeviceRecognition = self.onDevice == true; self.committed = self.lastText; self.startSegment(r, next, silenceSeconds: silenceSeconds, g: g) }
                    else { self.deliver(self.lastText, g) }
                }
            }
        }
    }
    private func armSilence(_ secs: Double, _ g: Int) { silenceTimer?.invalidate(); silenceTimer = Timer.scheduledTimer(withTimeInterval: secs, repeats: false) { [weak self] _ in self?.finish(g) } }

    /// End capture now and produce the final transcript (the "Done" button, silence, or the 60 s limit).
    /// Controlled audio fixture: the same on-device SpeechTranscriber session as the microphone path, fed from a recorded file
    /// in a temporary folder instead of the microphone. Every event is marked fixture:true and the message is labelled as such;
    /// it is never presented as a microphone test. The microphone is not opened.
    func startFixture(file: URL, sid: String) {
        if state != .off { return }
        guard #available(macOS 26.0, *) else { fail("unavailable", "Fixture input needs macOS 26 on-device transcription."); return }
        gen += 1; let g = gen; self.sid = sid; finished = false; lastError = nil; state = .starting; fixture = true
        Task { @MainActor in
            guard await AnalyzerSession.usable(Locale(identifier: "en-US")), self.live(g) else { self.fail("unavailable", "No on-device speech model for en-US.", g); return }
            let session = AnalyzerSession(locale: Locale(identifier: "en-US")); self.analyzerBox = session; self.engineName = "SpeechTranscriber (on-device, fixture file)"; self.onDevice = true; self.lastText = ""
            do { try await session.start(onText: { [weak self] text in guard let self, self.live(g), text != self.lastText else { return }; self.lastText = text; self.send(["event": "partial", "text": text]) }) }
            catch { self.fail("unavailable", "Fixture transcription could not start: \(error.localizedDescription)", g); return }
            guard self.live(g) else { session.cancel(); return }
            self.state = .listening; self.send(["event": "listening", "on_device": true, "engine": self.engineName])
            do {
                let f = try AVAudioFile(forReading: file); let fmt = f.processingFormat
                while f.framePosition < f.length {
                    guard self.live(g) else { session.cancel(); return }
                    guard let b = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 4096) else { break }
                    try f.read(into: b, frameCount: 4096); if b.frameLength == 0 { break }
                    session.append(b); try await Task.sleep(nanoseconds: UInt64(Double(b.frameLength) / fmt.sampleRate * 1_000_000_000))   // real-time pace
                }
            } catch { self.fail("unavailable", "The fixture file could not be read: \(error.localizedDescription)", g); return }
            self.finish(g)
        }
    }
    /// The Done button: finish the current session only if the page names it (a stale Done does nothing).
    func finish(sid page: String) { if page.isEmpty || page == sid { finish(gen) } }
    func finish(_ g: Int) {
        guard live(g), state == .listening else { return }
        userFinishing = true
        silenceTimer?.invalidate(); maxTimer?.invalidate()
        releaseCapture()          // the microphone goes off as soon as listening ends
        state = .transcribing; send(["event": "transcribing"])
        if #available(macOS 26.0, *), let session = analyzerBox as? AnalyzerSession {
            Task { @MainActor in let text = await session.finish(); guard self.live(g) else { return }; self.analyzerBox = nil; self.deliver(text.isEmpty ? self.lastText : text, g) }
            return
        }
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in if let self, self.live(g), !self.finished, self.state == .transcribing { self.deliver(self.lastText, g) } }
    }
    /// Exactly one final (or no_speech) per session generation; the generation is retired before the event leaves.
    private func deliver(_ text: String, _ g: Int) {
        guard live(g), !finished else { return }; finished = true
        silenceTimer?.invalidate(); maxTimer?.invalidate(); releaseCapture(); task?.cancel(); task = nil; request = nil
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let ev: [String: Any] = t.isEmpty ? ["event": "no_speech", "message": "I didn't catch any words. Nothing was sent."] : ["event": "final", "text": t, "on_device": onDevice == true]
        send(ev); gen += 1; state = .off
    }

    /// Release the microphone completely (idempotent).
    /// Never touches the input device unless this controller installed a tap: merely reading `audio.inputNode` enables the
    /// microphone input in Core Audio (and, before the permission is decided, blocks the main thread on the privacy check).
    /// Found 7 Oct: End voice on page load did exactly that.
    func releaseCapture() {
        if audio.isRunning { audio.stop() }
        if tapInstalled { audio.inputNode.removeTap(onBus: 0); tapInstalled = false; audio.reset() }
        if micActive { micActive = false; log(["event": "mic_released"]) }
    }
    private var tapInstalled = false

    func speak(_ text: String, voiceId: String?) {
        if state == .starting || state == .listening || state == .transcribing { gen += 1; silenceTimer?.invalidate(); maxTimer?.invalidate(); task?.cancel(); task = nil; request = nil; finished = true; if #available(macOS 26.0, *), let a = analyzerBox as? AnalyzerSession { a.cancel(); analyzerBox = nil } }
        releaseCapture()          // half duplex: never listen while speaking
        let u = AVSpeechUtterance(string: text)
        if let v = voiceId, let voice = AVSpeechSynthesisVoice(identifier: v) { u.voice = voice } else { u.voice = AVSpeechSynthesisVoice(language: "en-US") }
        stopRequested = false; state = .speaking; send(["event": "speaking"])
        synth.speak(u)
    }
    /// macOS may report a stopped utterance through didFinish rather than didCancel, so the stop is remembered here.
    private var stopRequested = false
    func stopSpeaking() { stopRequested = true; if synth.isSpeaking { synth.stopSpeaking(at: .immediate) } else if state == .speaking { state = .off; send(["event": "spoken", "interrupted": true]) } }
    /// End voice / window close / quit / page load: retire the session first, so no pending callback can act after this.
    func end() { gen += 1; if #available(macOS 26.0, *), let a = analyzerBox as? AnalyzerSession { a.cancel(); analyzerBox = nil }; silenceTimer?.invalidate(); maxTimer?.invalidate(); finished = true; task?.cancel(); task = nil; request = nil; releaseCapture(); if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }; state = .off; send(["event": "ended", "mic_active": micActive]); sid = ""; fixture = false }
    /// Current native state, for a page that (re)appears.
    func snapshot() -> [String: Any] { ["event": "state", "state": state.rawValue, "mic_active": micActive, "sid": sid, "gen": gen] }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { DispatchQueue.main.async { guard self.state == .speaking else { return }; self.state = .off; self.send(["event": "spoken", "interrupted": self.stopRequested]) } }
    // Only a cancel while still speaking changes state: when Talk interrupts a reply, capture has already started and must keep its state.
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { DispatchQueue.main.async { guard self.state == .speaking else { return }; self.state = .off; self.send(["event": "spoken", "interrupted": true]) } }

    /// Self-test without the microphone: recognize an audio file on the device (used to prove on-device recognition works).
    func transcribeFile(_ url: URL, locale: String, completion: @escaping ([String: Any]) -> Void) {
        if #available(macOS 26.0, *) {
            Task {
                guard await AnalyzerSession.usable(Locale(identifier: locale)) else { completion(["ok": false, "error": "no on-device model installed for \(locale)", "engine": "SpeechTranscriber"]); return }
                do {
                    let t = SpeechTranscriber(locale: Locale(identifier: locale), transcriptionOptions: [], reportingOptions: [], attributeOptions: []); let a = SpeechAnalyzer(modules: [t])
                    let file = try AVAudioFile(forReading: url)
                    async let text: String = { var s = ""; for try await r in t.results { s += String(r.text.characters) }; return s }()
                    if let last = try await a.analyzeSequence(from: file) { try await a.finalizeAndFinish(through: last) } else { await a.cancelAndFinishNow() }
                    completion(["ok": true, "text": try await text, "on_device": true, "engine": "SpeechTranscriber"])
                } catch { completion(["ok": false, "error": error.localizedDescription, "engine": "SpeechTranscriber"]) }
            }
            return
        }
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else { completion(["ok": false, "error": "no recognizer for \(locale)"]); return }
        let run = {
            let req = SFSpeechURLRecognitionRequest(url: url); req.requiresOnDeviceRecognition = r.supportsOnDeviceRecognition
            var done = false
            _ = r.recognitionTask(with: req) { result, error in
                if done { return }
                if let result, result.isFinal { done = true; completion(["ok": true, "text": result.bestTranscription.formattedString, "on_device": r.supportsOnDeviceRecognition]) }
                else if let error { done = true; completion(["ok": false, "error": error.localizedDescription, "on_device": r.supportsOnDeviceRecognition]) }
            }
        }
        if SFSpeechRecognizer.authorizationStatus() == .authorized { run() }
        else { SFSpeechRecognizer.requestAuthorization { s in if s == .authorized { run() } else { completion(["ok": false, "error": "speech recognition not authorized"]) } } }
    }
}
