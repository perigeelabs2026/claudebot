/** Each assistant runs on its own model (owner direction 2026-10-13: Haiku for the lead's chat, Sonnet for browser/review/resume, Opus for deep research). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acpModel } from '../../src/runtime/claude-acp.ts';
import { AGENT_MODELS } from '../../src/api/server.ts';
import { openDatabase } from '../../src/db/open.ts';
import { migrate } from '../../src/db/open.ts';
import { Definitions } from '../../src/model/definitions.ts';

test('built-in assistants seed Haiku (lead) / Opus (research) / Sonnet (others), and the owner\'s model choice on a built-in sticks', () => {
  const db = openDatabase(':memory:'); migrate(db); const d = new Definitions(db); d.seedSystemDefaults();
  assert.equal(d.getAgent('coordinator')!.model, 'claude-haiku-5-5'); assert.equal(d.getAgent('researcher')!.model, 'claude-opus-5-5'); assert.equal(d.getAgent('reviewer')!.model, 'claude-sonnet-5-5');
  const a = d.getAgent('researcher')!; d.upsertAgent({ ...a, model: 'claude-sonnet-5-5' }, 'owner'); assert.equal(d.getAgent('researcher')!.model, 'claude-sonnet-5-5');
  d.seedSystemDefaults(); assert.equal(d.getAgent('researcher')!.model, 'claude-sonnet-5-5', 're-seeding never replaces the owner\'s choice');
});

const src = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', f), 'utf8');

test('model ids map to the aliases the ACP agent advertises (verified live: haiku, sonnet, opus); others pass through', () => {
  assert.equal(acpModel('claude-haiku-5-5'), 'haiku'); assert.equal(acpModel('claude-sonnet-5-5'), 'sonnet'); assert.equal(acpModel('claude-opus-5-5'), 'opus');
  assert.equal(acpModel('claude-fable-5-1[1m]'), 'claude-fable-5-1[1m]');
  assert.deepEqual(AGENT_MODELS, ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']);
});

test('every turn carries its assistant\'s model; a refused model falls back once, recorded and announced', () => {
  const run = src('src/worker/run.ts');
  assert.match(run, /withModelFallback\(deps, job\.id, agent, turnModel, /, 'chat turns pass their model (with a fallback if it is refused)');
  assert.match(run, /withModelFallback\(deps, job\.id, agent, agent\?\.model, ctx\.defs\.previousModel\(agentId\)/, 'workflow stages pass their model (with a fallback if it is refused)');
  assert.match(run, /const turnModel = replan && replanModel \? replanModel : agent\?\.model;/, 'the lead re-plans on the opt-in replan_model when delegated work came back blocked or partial'); assert.match(run, /key = 'replan_model'/);
  const acp = src('src/runtime/claude-acp.ts');
  assert.match(acp, /if \(!req\.probeOnly\) modelFallback = await this\.ensureModel\(sessionKey, req\.model, req\.fallbackModel, req\.role\);/);
  assert.match(acp, /throw new GatewayError\('MODEL_REFUSED'/);
});

test('the owner picks the model in Edit assistant > Advanced; new assistants default to Sonnet 5.5; Claude Code subagents are off (they ran hidden parallel Opus turns)', () => {
  const app = src('ui/app.js'); assert.match(app, /field\('Model \(on your Claude plan\)', model\)/); assert.match(app, /const curModel = a\?\.model \|\| 'claude-sonnet-5-5'/);
  assert.match(src('src/model/definitions.ts'), /input\.model \?\? existing\?\.model \?\? 'claude-sonnet-5-5'/, 'a new assistant without a choice gets Sonnet');
  const deny = JSON.parse(src('../install/claude-settings.json')).permissions.deny as string[]; assert.ok(deny.includes('Task') && deny.includes('Agent'));
});

test('every model an assistant can pick maps to a model the Claude connection advertises (Fable is "fable"; "claude-fable-5-1" was refused live)', async () => {
  const { AGENT_MODELS } = await import('../../src/api/server.ts'); const { acpModel } = await import('../../src/runtime/claude-acp.ts');
  const advertised = ['default', 'opus', 'fable', 'sonnet', 'haiku'];
  for (const m of AGENT_MODELS) assert.ok(advertised.includes(acpModel(m)), `${m} → ${acpModel(m)}`);
});

test('a refused model falls back to the assistant\'s previous model for the turn; with no usable fallback the turn fails MODEL_REFUSED', async () => {
  const { ClaudeAcpRuntime } = await import('../../src/runtime/claude-acp.ts');
  const log = { info: () => {}, warn: () => {}, error: () => {} } as never;
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; ensureModel: (k: string, m?: string, f?: string) => Promise<unknown> };
  const sent: string[] = []; rt.command = async (m) => { sent.push(m); return /model claude-mystery-9 /.test(m) ? 'ACP error: unknown model claude-mystery-9' : 'model set'; };
  assert.deepEqual(await rt.ensureModel('sk1', 'claude-mystery-9', 'claude-opus-5-5'), { requested: 'claude-mystery-9', used: 'claude-opus-5-5', reason: 'ACP error: unknown model claude-mystery-9' });
  assert.deepEqual(sent, ['/acp model claude-mystery-9 sk1', '/acp model opus sk1']);
  await assert.rejects(rt.ensureModel('sk2', 'claude-mystery-9'), /MODEL_REFUSED|was not accepted/);
  rt.command = async () => 'ACP error: unknown model'; await assert.rejects(rt.ensureModel('sk3', 'claude-mystery-9', 'claude-opus-5-5'), /was not accepted/, 'both refused: the turn fails');
});

test('the previous model is remembered when the owner changes it; without one the built-in default, else Sonnet', () => {
  const db = openDatabase(':memory:'); migrate(db); const d = new Definitions(db); d.seedSystemDefaults();
  assert.equal(d.previousModel('researcher'), 'claude-sonnet-5-5', 'opus is current and the default: Sonnet');
  d.upsertAgent({ ...d.getAgent('researcher')!, model: 'claude-fable-5-1' }, 'owner'); assert.equal(d.previousModel('researcher'), 'claude-opus-5-5');
  assert.equal(d.previousModel('coordinator'), 'claude-sonnet-5-5', 'haiku is current and the default: Sonnet');
});

test('startup check: every configured model must resolve; a bad alias is posted to the team group once a day', async () => {
  const { checkModelAliases, reportModelProblem, resolves } = await import('../../src/runtime/model-check.ts');
  const { JobStore } = await import('../../src/jobs/store.ts'); const { ChatStore } = await import('../../src/chat/store.ts');
  const db = openDatabase(':memory:'); migrate(db); const d = new Definitions(db); d.seedSystemDefaults(); const store = new JobStore(db);
  for (const m of AGENT_MODELS.filter((x) => x !== 'claude-fable-5-1')) assert.ok(resolves(m), m);
  assert.equal(resolves('claude-fable-5-1'), false, 'Fable is not in the offline list until verified live');
  assert.deepEqual(checkModelAliases(db, (id) => d.previousModel(id)), [], 'the shipped default models all resolve');
  d.upsertAgent({ ...d.getAgent('researcher')!, model: 'claude-fable-5-1[1m]' }, 'owner');
  db.prepare("INSERT INTO settings(key, value, updated_at, updated_by) VALUES ('replan_model', ?, ?, 'test') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify('claude-mystery-9'), new Date().toISOString());
  const probs = checkModelAliases(db, (id) => d.previousModel(id));
  assert.deepEqual(probs.map((p) => [p.agent, p.model, p.fallback]), [['researcher', 'claude-fable-5-1[1m]', 'claude-opus-5-5'], ['coordinator', 'claude-mystery-9', 'claude-sonnet-5-5']]);
  const chat = new ChatStore(db, store); const { Workspaces } = await import('../../src/model/workspaces.ts'); const os = await import('node:os');
  const ws = new Workspaces(db, fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'))).create({ name: 'Home' }, 't');
  chat.create({ workspace_id: ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  assert.equal(reportModelProblem(db, store, { ...probs[0], reason: 'not one of the models it offers' }), true);
  assert.equal(reportModelProblem(db, store, { ...probs[0], reason: 'not one of the models it offers' }), false, 'once per assistant, model and day');
  const team = chat.teamConversation()!; assert.match(chat.messages(team).map((m) => m.content).join('\n'), /model "claude-fable-5-1\[1m\]" is not accepted by the Claude connection[\s\S]*running on claude-opus-5-5 instead/);
});
