// Independent negative probes of the shipped voice event handler.
// No microphone, credentials, real engine requests or model calls are used.
import fs from 'node:fs';

async function probe(name, invoke, expected) {
  const sent = [];
  const composer = { value: '', dispatchEvent() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.sessionStorage = { removeItem() {} };
  globalThis.document = { getElementById: (id) => id === 'chat-input' ? composer : null };
  globalThis.window = { webkit: { messageHandlers: { claudebot: { postMessage() {} } } } };
  const source = fs.readFileSync(new URL('../engine/ui/voice.js', import.meta.url), 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${name}`);
  mod.initVoice({
    ensureConversation: async () => 'mock-conversation',
    api: async (_path, options) => {
      if (options?.method === 'POST') {
        sent.push(options.body);
        return { job: { id: 'mock-job' } };
      }
      return { active_turn: null, messages: [{ role: 'assistant', job_id: 'mock-job', content: 'Mock reply' }] };
    },
  });
  mod.talk();
  await window.claudebotVoiceEvent({ event: 'listening', on_device: true });
  mod.done();
  await invoke(mod, window.claudebotVoiceEvent);
  mod.endVoice();
  const passed = sent.length === expected;
  console.log(JSON.stringify({ name, expected_submissions: expected, actual_mock_submissions: sent.length, passed, real_network_requests: 0 }));
  return passed;
}

const late = await probe('late-final-after-end', async (mod, event) => {
  mod.endVoice();
  await event({ event: 'final', text: 'Late synthetic test transcript', on_device: true });
}, 0);
const duplicate = await probe('duplicate-final-events', async (_mod, event) => {
  await Promise.all([
    event({ event: 'final', text: 'Same synthetic transcript', on_device: true }),
    event({ event: 'final', text: 'Same synthetic transcript', on_device: true }),
  ]);
}, 1);
process.exitCode = late && duplicate ? 0 : 1;
