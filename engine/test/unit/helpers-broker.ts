// Shared setup for broker tool tests: an in-memory engine with one project, the chat store and a broker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { loadConfig } from '../../src/config.ts';
import type { Capability } from '../../src/broker/capabilities.ts';

export function setupBroker() {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brk-'));
  const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test');
  const chat = new ChatStore(db, store); const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  const call = (job: { id: string; agent_role: string }, tool: string, args: Record<string, unknown>) => {
    const wsDir = path.join(tmp, 'turn', job.id); fs.mkdirSync(wsDir, { recursive: true });
    const cap: Capability = { token: 't', job_id: job.id, role: job.agent_role, workspace: wsDir, tools: [tool], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() };
    return broker.call(cap, tool, args);
  };
  return { db, store, defs, ws, chat, broker, call, tmp };
}
