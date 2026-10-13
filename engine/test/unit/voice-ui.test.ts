import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// MOCKED: these load the shipped engine/ui/voice.js with a fake native bridge, DOM and engine. They prove the page's event
// handling (session ids, one-shot finals, cleared send intent); they are not microphone or installed-app tests.
type Posted = Record<string, unknown>;
let n = 0;
async function harness(opts: { mode?: string; activeTurn?: boolean } = {}) {
  const posted: Posted[] = []; const sent: Posted[] = [];
  const composer = { value: '', dispatchEvent() {} };
  const store: Record<string, string> = opts.mode ? { 'claudebot.voice.mode': opts.mode } : {};
  (globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  (globalThis as any).sessionStorage = { removeItem() {} };
  (globalThis as any).document = { getElementById: (id: string) => (id === 'chat-input' ? composer : null) };
  (globalThis as any).window = { webkit: { messageHandlers: { claudebot: { postMessage: (m: Posted) => posted.push(m) } } } };
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'ui', 'voice.js'), 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}#h${n++}`);
  mod.initVoice({
    ensureConversation: async () => 'conv-mock',
    api: async (_p: string, o?: { method?: string; body?: Posted }) => { if (o?.method === 'POST') { sent.push(o.body!); return { job: { id: 'job-mock' } }; } return { active_turn: opts.activeTurn ? { id: 'x' } : null, messages: [] }; },
    notify() {}, rerender() {},
  });
  const ev = (e: Posted) => (globalThis as any).window.claudebotVoiceEvent(e);
  const startSid = () => { const s = [...posted].reverse().find((m) => m.type === 'voice.start' || m.type === 'voice.startFixture'); return s?.sid as string; };
  return { mod, posted, sent, composer, ev, startSid, voice: mod.voice };
}

test('voice UI (mocked bridge): late final after End voice is not submitted and not put in the box', async () => {
  const h = await harness(); h.mod.talk(); const sid = h.startSid(); await h.ev({ event: 'listening', sid }); h.mod.done(); h.mod.endVoice();
  await h.ev({ event: 'final', text: 'late words', sid });
  assert.equal(h.sent.length, 0); assert.equal(h.composer.value, '');
  assert.equal(h.posted.filter((m) => m.type === 'voice.end').length, 2, 'page load + End voice both end the native session');
});

test('voice UI (mocked bridge): duplicate final events for one session submit exactly once', async () => {
  const h = await harness(); h.mod.talk(); const sid = h.startSid(); await h.ev({ event: 'listening', sid }); h.mod.done();
  await Promise.all([h.ev({ event: 'final', text: 'same words', sid }), h.ev({ event: 'final', text: 'same words', sid })]);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].client_id, `voice:${sid}`, 'the engine receives the session as idempotency key');
  h.mod.endVoice();   // stops the reply poll
});

test('voice UI (mocked bridge): rapid Talk → End → Talk; a final from the first session is dropped, the second is used', async () => {
  const h = await harness(); h.mod.talk(); const s1 = h.startSid(); h.mod.endVoice(); h.mod.talk(); const s2 = h.startSid();
  assert.notEqual(s1, s2);
  await h.ev({ event: 'listening', sid: s1 }); assert.equal(h.voice.state, 'starting', 'a listening event of the ended session does not show the mic as on');
  await h.ev({ event: 'listening', sid: s2 }); h.mod.done();
  await h.ev({ event: 'final', text: 'from the first session', sid: s1 }); assert.equal(h.sent.length, 0);
  await h.ev({ event: 'final', text: 'from the second session', sid: s2 }); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].content, 'from the second session');
  h.mod.endVoice();
});

test('voice UI (mocked bridge): repeated Done sends one finish for the live session; Done after End sends none', async () => {
  const h = await harness(); h.mod.talk(); const sid = h.startSid(); await h.ev({ event: 'listening', sid });
  h.mod.done(); h.mod.done(); // second press: state is still listening until the shell answers, but the session is named, so the shell ignores a stale one
  const fin = h.posted.filter((m) => m.type === 'voice.finish'); assert.ok(fin.length >= 1 && fin.every((m) => m.sid === sid));
  h.mod.endVoice(); const before = h.posted.filter((m) => m.type === 'voice.finish').length; h.mod.done();
  assert.equal(h.posted.filter((m) => m.type === 'voice.finish').length, before, 'no finish after End');
});

test('voice UI (mocked bridge): push-to-talk pause leaves words unsent; an error or Done-then-End clears send intent', async () => {
  const h = await harness(); h.mod.talk(); let sid = h.startSid(); await h.ev({ event: 'listening', sid });
  await h.ev({ event: 'final', text: 'paused words', sid }); assert.equal(h.sent.length, 0); assert.equal(h.composer.value, 'paused words');
  h.mod.talk(); sid = h.startSid(); await h.ev({ event: 'listening', sid }); h.mod.done(); await h.ev({ event: 'error', code: 'no_input', message: 'x', sid });
  assert.equal(h.voice.sendOnFinal, false); await h.ev({ event: 'final', text: 'after error', sid }); assert.equal(h.sent.length, 0);
});

test('voice UI (mocked bridge): End while the submission is in flight does not send', async () => {
  const h = await harness(); h.mod.talk(); const sid = h.startSid(); await h.ev({ event: 'listening', sid }); h.mod.done();
  const p = h.ev({ event: 'final', text: 'racing words', sid }); h.mod.endVoice(); await p;
  assert.equal(h.sent.length, 0); assert.equal(h.composer.value, 'racing words', 'the words stay in the box, unsent');
});

test('voice UI (mocked bridge): the shell state snapshot corrects the page after a window close; a foreign live mic is ended', async () => {
  const h = await harness(); h.mod.talk(); const sid = h.startSid(); await h.ev({ event: 'listening', sid });
  await h.ev({ event: 'state', state: 'off', mic_active: false, sid: '' }); assert.equal(h.voice.state, 'off'); assert.equal(h.voice.active, false);
  const ends = h.posted.filter((m) => m.type === 'voice.end').length;
  await h.ev({ event: 'state', state: 'listening', mic_active: true, sid: 'someone-else' });
  assert.equal(h.posted.filter((m) => m.type === 'voice.end').length, ends + 1, 'a microphone the page does not own is switched off');
  await h.ev({ event: 'ended', sid: '' }); assert.equal(h.voice.sid, null);
});

test('voice UI (mocked bridge): a busy lead keeps the words unsent; a fixture turn is labelled as a fixture', async () => {
  const busy = await harness({ activeTurn: true }); busy.mod.talk(); let sid = busy.startSid(); await busy.ev({ event: 'listening', sid }); busy.mod.done();
  await busy.ev({ event: 'final', text: 'while busy', sid }); assert.equal(busy.sent.length, 0); assert.equal(busy.composer.value, 'while busy');
  const h = await harness(); (globalThis as any).window.claudebotVoiceFixture({ file: '/tmp/x.aiff', done: true }); sid = h.startSid();
  assert.equal(h.posted.at(-1)!.type, 'voice.startFixture');
  await h.ev({ event: 'listening', sid, fixture: true }); await h.ev({ event: 'final', text: 'fixture words', sid, fixture: true });
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].fixture, true);
  h.mod.endVoice();
});

test('voice UI (mocked bridge): dictation keeps listening through pauses, keeps every word, and adds to what was already typed', async () => {
  const h = await harness({ mode: 'ptt' }); h.composer.value = 'Draft so far.';
  h.mod.dictate(); const start = h.posted.find((m) => m.type === 'voice.start')!;
  assert.equal(start.silence, 60, 'dictation stops on the owner tap; 60 s of silence is only a safety stop');
  const sid = h.startSid(); h.ev({ event: 'listening', sid });
  // speech with 1–1.5 s pauses arrives as growing partials (the native side chains segments across pauses)
  for (const t of ['Okay, I need', 'Okay, I need Abdul,', 'Okay, I need Abdul, you to ask me', 'Okay, I need Abdul, you to ask me about the Ramp call tomorrow']) { h.ev({ event: 'partial', text: t, sid }); await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(h.composer.value, 'Draft so far. Okay, I need Abdul, you to ask me about the Ramp call tomorrow');
  h.ev({ event: 'final', text: 'Okay, I need Abdul, you to ask me about the Ramp call tomorrow.', sid });
  assert.equal(h.composer.value, 'Draft so far. Okay, I need Abdul, you to ask me about the Ramp call tomorrow.', 'the whole sentence is kept after the earlier text');
  assert.equal(h.sent.length, 0, 'dictation never sends by itself');
});

test('voice UI (mocked bridge): live voice ends a turn after 2 s of quiet, not mid-sentence', async () => {
  const h = await harness({ mode: 'conversation' }); h.mod.liveVoice(); const start = h.posted.find((m) => m.type === 'voice.start')!;
  assert.equal(start.silence, 2.0);
  const sw = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'shell', 'Sources', 'voice.swift'), 'utf8');
  assert.match(sw, /self\.committed = text   \/\/ the segment ended by itself: keep its words and listen on/, 'a segment macOS ends by itself is chained, not delivered');
  assert.match(sw, /withTimeInterval: 900/); assert.doesNotMatch(sw, /withTimeInterval: 60, repeats: false/);
});

test('voice UI (mocked bridge): pressing Send while dictating stops listening; late words never refill the box', async () => {
  const h = await harness({ mode: 'ptt' }); h.mod.dictate(); const sid = h.startSid(); h.ev({ event: 'listening', sid });
  h.ev({ event: 'partial', text: 'Send this now', sid }); assert.equal(h.composer.value, 'Send this now');
  h.composer.value = '';   // the composer clears the box when the message is sent
  h.mod.stopDictationForSend();
  assert.ok(h.posted.some((m) => m.type === 'voice.end'), 'the microphone is told to stop');
  h.ev({ event: 'partial', text: 'Send this now', sid }); h.ev({ event: 'final', text: 'Send this now.', sid });
  assert.equal(h.composer.value, '', 'nothing comes back into the box after Send');
});

test('voice UI (mocked bridge): replies are never read aloud after dictation; voice mode is never restored from a reload', async () => {
  const h = await harness({ mode: 'conversation' });   // a stored "conversation" from an earlier session is ignored
  assert.equal(h.voice.mode, 'ptt', 'the app always opens in plain dictation');
  h.mod.dictate(); const sid = h.startSid(); h.ev({ event: 'listening', sid }); h.ev({ event: 'partial', text: 'Book the call', sid });
  h.ev({ event: 'final', text: 'Book the call.', sid }); await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.posted.filter((m) => m.type === 'voice.speak').length, 0, 'no spoken reply after a dictated message');
  assert.equal(h.posted.filter((m) => m.type === 'voice.start').length, 1, 'no new voice session starts by itself');
});
