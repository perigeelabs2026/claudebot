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

test('every turn carries its assistant\'s model; a refused model fails the turn instead of running on another', () => {
  const run = src('src/worker/run.ts'); assert.equal((run.match(/deps\.runtime\.startTurn\(\{[^\n]*model: (agent\?\.model|turnModel),/g) || []).length, 2, 'chat turns and workflow stages both pass the model');
  assert.match(run, /const turnModel = replan && replanModel \? replanModel : agent\?\.model;/, 'the lead re-plans on the opt-in replan_model when delegated work came back blocked or partial'); assert.match(run, /key = 'replan_model'/);
  const acp = src('src/runtime/claude-acp.ts');
  assert.match(acp, /if \(!req\.probeOnly\) await this\.ensureModel\(sessionKey, req\.model\);/);
  assert.match(acp, /throw new GatewayError\('MODEL_REFUSED'/);
});

test('the owner picks the model in Edit assistant > Advanced; new assistants default to Sonnet 5.5; Claude Code subagents are off (they ran hidden parallel Opus turns)', () => {
  const app = src('ui/app.js'); assert.match(app, /field\('Model \(on your Claude plan\)', model\)/); assert.match(app, /const curModel = a\?\.model \|\| 'claude-sonnet-5-5'/);
  assert.match(src('src/model/definitions.ts'), /input\.model \?\? existing\?\.model \?\? 'claude-sonnet-5-5'/, 'a new assistant without a choice gets Sonnet');
  const deny = JSON.parse(src('../install/claude-settings.json')).permissions.deny as string[]; assert.ok(deny.includes('Task') && deny.includes('Agent'));
});
