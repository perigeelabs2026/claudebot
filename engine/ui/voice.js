// Voice in the conversation. The native shell does the listening (macOS speech recognition, on-device when supported) and
// the speaking (macOS speech synthesis). This module only moves text: a final transcript becomes one ordinary chat message
// to the same lead assistant; that assistant's saved reply is read aloud. Voice never approves anything.
const hasShell = () => !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.claudebot);
const post = (msg) => { try { window.webkit.messageHandlers.claudebot.postMessage(msg); return true; } catch { return false; } };
const ls = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

export const voice = {
  state: 'off',            // off | starting | listening | transcribing | thinking | speaking
  active: false,           // the owner pressed Talk and has not pressed End voice
  mode: ls.get('claudebot.voice.mode', 'ptt'),   // ptt | conversation
  onDevice: null, notice: '', caps: null, awaitingJob: null, partial: '',
  sendOnFinal: false,      // true only when the owner pressed Done, or chose hands-free conversation mode
  lastFinal: '',           // the last transcript left in the message box (so pressing Send still records it as spoken)
  sid: null,               // id of the live voice session; events carrying another id are from an ended session and are dropped
  fixture: false,          // the live session is fed from a recorded test file, not the microphone (labelled everywhere)
};
const consumed = new Set();   // sessions whose final transcript was already used (one-shot)
const newSid = () => { try { return crypto.randomUUID(); } catch { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2); } };
/** Forget the live session and any intent to send: End voice, errors, window events, reload. */
function retire() { voice.sid = null; voice.sendOnFinal = false; voice.fixture = false; }
let hooks = { conversation: () => null, ensureConversation: async () => null, api: null, notify: () => {}, rerender: () => {} };
// A freshly loaded page cannot see a capture started by an earlier page, so it ends any native voice session first: the microphone is never on without the Talk control showing it.
export function initVoice(h) { hooks = { ...hooks, ...h }; if (hasShell()) { post({ type: 'voice.end' }); post({ type: 'voice.capabilities', locale: 'en-US' }); } }

const LABEL = { off: 'Microphone off', starting: 'Asking macOS for permission…', listening: 'Listening… (microphone on)', transcribing: 'Transcribing…', thinking: 'Thinking… (the lead assistant is replying)', speaking: 'Speaking…' };
function set(state, notice) { voice.state = state; if (notice !== undefined) voice.notice = notice; render(); }

/** Start a push-to-talk turn (or the first turn of conversation mode). */
export function talk() {
  if (!hasShell()) { voice.notice = 'Voice works in the ClaudeBot app (it uses macOS speech recognition). Keep typing here.'; render(); return; }
  if (['starting', 'listening', 'transcribing'].includes(voice.state)) return;
  voice.active = true; voice.partial = ''; voice.sendOnFinal = voice.mode === 'conversation'; voice.sid = newSid(); voice.fixture = false; voice.base = voice.mode === 'ptt' ? (composer()?.value || '').replace(/\s+$/, '') : ''; set('starting', '');
  // Dictation listens until the owner taps the mic again (60 s of silence is only a safety stop); live voice ends a turn after 2 s of quiet.
  post({ type: 'voice.start', locale: 'en-US', allowServer: ls.get('claudebot.voice.serverConsent', '0') === '1', silence: voice.mode === 'ptt' ? 60 : 2.0, sid: voice.sid });
}
export function done() { if (voice.state === 'listening' && voice.sid) { voice.sendOnFinal = true; post({ type: 'voice.finish', sid: voice.sid }); } }
export function stopSpeaking() { post({ type: 'voice.stopSpeaking' }); }
export function endVoice() { voice.active = false; voice.awaitingJob = null; retire(); post({ type: 'voice.end' }); set('off', 'Voice ended. The microphone is off.'); }
/** Acceptance fixture (test-only, enabled by a flag file the app never creates): the same session flow fed from a recorded file. */
window.claudebotVoiceFixture = (o) => {
  if (!hasShell() || !o || !o.file || voice.state !== 'off') return;
  voice.active = true; voice.partial = ''; voice.sendOnFinal = !!o.done || voice.mode === 'conversation'; voice.sid = newSid(); voice.fixture = true; set('starting', '');
  post({ type: 'voice.startFixture', file: String(o.file), sid: voice.sid });
};
export function setMode(m) { voice.mode = m; ls.set('claudebot.voice.mode', m); render(); }

function composer() { return document.getElementById('chat-input'); }
function putInComposer(text) { const ta = composer(); if (ta) { ta.value = text; ta.dispatchEvent(new Event('input')); } }
/** Dictation adds to what is already in the box; it never replaces it. */
const withBase = (text) => [voice.base || '', String(text || '').trim()].filter(Boolean).join(' ');

/** Events from the native shell. */
const SESSION_EVENTS = new Set(['listening', 'partial', 'transcribing', 'final', 'no_speech', 'error', 'needs_server_consent']);
window.claudebotVoiceEvent = async (ev) => {
  // Events of a session this page did not start, or already ended, are dropped (late or duplicate callbacks).
  // (An event without an id comes from an older shell build and is treated as the live session's; one-shot consumption still applies.)
  if (SESSION_EVENTS.has(ev.event) && (!voice.sid || (ev.sid !== undefined && ev.sid !== voice.sid))) return;
  switch (ev.event) {
    case 'capabilities': voice.caps = ev; render(); return;
    case 'state':   // the shell's real state, sent when the window comes back: the page never shows a microphone that is off as on, or the reverse
      if (ev.state === 'off' && !ev.mic_active && ['starting', 'listening', 'transcribing', 'speaking'].includes(voice.state)) { voice.active = false; retire(); set('off', 'The microphone is off.'); }
      else if (ev.mic_active && (!voice.sid || ev.sid !== voice.sid)) post({ type: 'voice.end' });
      render(); return;
    case 'listening': voice.onDevice = ev.on_device; voice.engine = ev.engine || ''; set('listening'); return;
    case 'partial': voice.partial = ev.text; putInComposer(withBase(ev.text)); render(); return;
    case 'transcribing': set('transcribing'); return;
    case 'no_speech': retire(); set('off', ev.message); if (voice.mode === 'conversation' && voice.active) voice.notice += ' Press Talk to try again.'; voice.active = voice.mode === 'conversation' && voice.active ? false : voice.active; return;
    case 'needs_server_consent': retire(); set('off', ''); askServerConsent(ev.message); return;
    case 'error': voice.active = false; retire(); set('off', ev.message); hooks.notify(ev.message, true); return;
    case 'final': {
      // One-shot: a session's transcript is used once, and only while voice is on.
      const sid = voice.sid; if (!voice.active || consumed.has(sid)) return; consumed.add(sid);
      const send = voice.sendOnFinal; const fixture = voice.fixture; voice.sid = null; voice.sendOnFinal = false; voice.fixture = false;
      if (send) return submit(ev.text, ev.on_device, sid, fixture);
      // A pause only stops listening: the words stay in the message box, unsent, until the owner checks them and presses Send.
      voice.lastFinal = withBase(ev.text); putInComposer(voice.lastFinal); voice.base = ''; voice.active = false;
      set('off', voice.lastFinal ? 'Heard you. Check the words in the message box, then press Send (or Talk to say it again). Nothing was sent.' : "I didn't catch any words. Nothing was sent.");
      return; }
    case 'speaking': set('speaking'); return;
    case 'spoken': set('off', ev.interrupted ? 'Stopped speaking.' : ''); if (voice.active && voice.mode === 'conversation' && !ev.interrupted) setTimeout(() => { if (voice.active && voice.state === 'off') talk(); }, 500); return;
    case 'ended': voice.active = false; retire(); if (voice.state !== 'thinking') set('off'); return;
  }
};

function askServerConsent(message) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="vc-t"><h3 id="vc-t" style="margin-top:0">Use Apple's speech recognition service?</h3><p></p><p class="hint">If you allow it, your recorded speech is sent to Apple for transcription each time you press Talk. Claude never receives audio, only the text. You can turn this off again in this dialog's place by choosing "Keep typing".</p><div class="row"><button class="btn primary" id="vc-yes">Allow on this Mac</button><button class="btn" id="vc-no">Keep typing</button></div></div>`;
  bg.querySelector('p').textContent = message; document.body.append(bg);
  bg.querySelector('#vc-yes').onclick = () => { ls.set('claudebot.voice.serverConsent', '1'); bg.remove(); talk(); };
  bg.querySelector('#vc-no').onclick = () => { ls.set('claudebot.voice.serverConsent', '0'); voice.active = false; bg.remove(); set('off', 'Voice is off. Typing still works.'); };
}

/** A final transcript becomes exactly one message, unless the lead is busy (then it stays in the box, unsent). */
async function submit(text, onDevice, sid, fixture) {
  const clean = String(text || '').trim();
  if (!clean) { set('off', "I didn't catch any words. Nothing was sent."); return; }
  putInComposer(clean);
  const conv = await hooks.ensureConversation();
  if (!conv) { set('off', 'Your words are in the message box. Press Send when ready.'); return; }
  if (!voice.active) { set('off', 'Voice ended before sending. Your words are in the message box, unsent.'); return; }
  const d = await hooks.api(`/api/conversations/${conv}`);
  if (!voice.active) { set('off', 'Voice ended before sending. Your words are in the message box, unsent.'); return; }
  if (d.active_turn) { voice.active = voice.mode === 'conversation' ? voice.active : false; set('off', 'The lead assistant is still answering your previous message. Your words are in the message box, unsent; press Send when the reply arrives.'); return; }
  set('thinking', '');
  let r;
  // client_id = the voice session: the engine stores one message per id, so a repeated submission cannot become a second message.
  try { r = await hooks.api(`/api/conversations/${conv}/messages`, { method: 'POST', body: { content: clean, source: 'voice', on_device: onDevice, client_id: `voice:${sid}`, fixture: !!fixture } }); }
  catch (e) { set('off', `Not sent: ${e.message} Your words are still in the message box.`); return; }
  putInComposer(''); try { sessionStorage.removeItem(`claudebot.chatdraft.${conv}`); } catch {}
  voice.awaitingJob = r.job.id; hooks.rerender();
  awaitReply(conv, r.job.id);
}

/** Wait for the lead's saved reply to this exact message, then read it aloud (only if voice is still on). */
async function awaitReply(conv, jobId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && voice.awaitingJob === jobId) {
    await new Promise((r) => setTimeout(r, 2000));
    let d; try { d = await hooks.api(`/api/conversations/${conv}`); } catch { continue; }
    const reply = d.messages.find((m) => m.role === 'assistant' && m.job_id === jobId);
    if (reply) { voice.awaitingJob = null; if (voice.active) speak(reply.content); else set('off'); return; }
    const status = d.messages.find((m) => m.kind === 'status' && m.job_id === jobId);
    if (status) { voice.awaitingJob = null; if (voice.active) speak(status.content); else set('off'); return; }
  }
  if (voice.awaitingJob === jobId) { voice.awaitingJob = null; set('off', 'The reply is taking a while. It will appear in the chat.'); }
}

/** What may be read aloud: the lead's words, minus code, links and anything that looks like a credential. */
export function speakable(t) {
  let s = String(t || '');
  if (/(sk-[A-Za-z0-9_-]{10,}|api[_-]?key|passw(or)?d|secret|bearer\s+[A-Za-z0-9]|token\s*[:=])/i.test(s)) return 'The reply contains something I will not read aloud. It is in the chat.';
  s = s.replace(/```[\s\S]*?```/g, ' (there is code in the chat) ').replace(/`[^`]*`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, 'a link').replace(/[A-Za-z0-9+/=_-]{32,}/g, 'a long code').replace(/^\s*#+\s*/gm, '').replace(/[*_>|]/g, '').replace(/\n{2,}/g, '. ').replace(/\n/g, ' ');
  if (s.length > 1200) s = s.slice(0, 1200).replace(/\s+\S*$/, '') + '. The rest is in the chat.';
  return s.trim();
}
function speak(text) { const t = speakable(text); if (!t) { set('off'); return; } post({ type: 'voice.speak', text: t }); }

/** The voice bar shown under the composer; re-rendered in place. */
export function voiceBar() { const el = document.createElement('div'); el.id = 'voice-bar'; el.className = 'voice-bar'; fill(el); return el; }
function render() {
  const el = document.getElementById('voice-bar'); if (el) fill(el);
  // Composer icons (design system): the mic is dictation, the waveform is live voice; only their state changes here.
  for (const [id, mode] of [['dictate-btn', 'ptt'], ['live-btn', 'conversation']]) { const b = document.getElementById(id); if (b) { const on = voice.active && voice.mode === mode && voice.state !== 'off'; b.classList.toggle('live', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } }
}
/** Dictation: speech fills the message box; nothing is sent until the owner presses Send. */
export function dictate() { if (voice.active && voice.mode === 'ptt' && voice.state !== 'off') { done(); return; } setMode('ptt'); talk(); }
/** Live voice: a spoken conversation in this chat (sends after a pause, listens again after each spoken reply). */
export function liveVoice() { if (voice.active && voice.mode === 'conversation') { endVoice(); return; } setMode('conversation'); talk(); }
let noticeTimer = null;
function fill(el) {
  const caps = voice.caps; const mic = voice.state === 'listening';
  el.replaceChildren();
  // The bar exists only while voice is in use (or for a short notice); the composer stays as designed otherwise.
  const idle = voice.state === 'off' && !voice.active;
  if (idle && !voice.notice) { el.hidden = true; return; }
  el.hidden = false;
  if (idle && voice.notice) { const n = document.createElement('div'); n.className = 'hint'; n.setAttribute('role', 'status'); n.textContent = voice.notice; el.append(n); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { voice.notice = ''; render(); }, 6000); return; }
  const status = document.createElement('div'); status.className = `voice-status ${voice.state}`; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.textContent = (mic ? '🔴 ' : '') + LABEL[voice.state] + (voice.state === 'listening' && voice.onDevice === true ? ' · on this Mac' : voice.state === 'listening' && voice.onDevice === false ? ' · Apple server' : '');
  const head = document.createElement('div'); head.className = 'row'; head.append(status); el.append(head);
  const btn = (label, fn, cls = 'btn small') => { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.onclick = fn; return b; };
  const row = document.createElement('div'); row.className = 'row';
  if (voice.state === 'listening') row.append(btn(voice.mode === 'conversation' ? 'Done — send now' : 'Done — send what I said', done, 'btn small primary'));
  if (voice.state === 'speaking') row.append(btn('Stop speaking', stopSpeaking));
  if (voice.active || voice.state !== 'off') row.append(btn('End voice', endVoice, 'btn small danger'));
  const modeTag = document.createElement('span'); modeTag.className = 'hint'; modeTag.textContent = voice.mode === 'conversation' ? 'Live voice' : ['thinking', 'speaking'].includes(voice.state) ? 'Voice turn (you pressed Done)' : 'Push to talk: press Done to send, or pause to edit first'; head.append(modeTag);
  if (row.childNodes.length) el.append(row);
  const info = document.createElement('div'); info.className = 'hint';
  info.textContent = voice.notice || (!hasShell() ? 'Voice needs the ClaudeBot app.' : caps ? ((caps.speech_transcriber || (caps.recognizer && caps.on_device)) ? 'Speech is recognized on this Mac and replies are spoken by macOS. Claude only receives the text.' : caps.recognizer ? 'This Mac cannot recognize speech on the device; ClaudeBot will ask before using Apple\'s server.' : 'Speech recognition is not available on this Mac. Keep typing.') : 'Checking voice support…');
  el.append(info);
}
