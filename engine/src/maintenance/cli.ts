/** `claudebot maintenance <command>`: explicit, logged maintenance operations against the installed runtime state. */
import { loadConfig } from '../config.ts';
import { openDatabase, integrityCheck } from '../db/open.ts';
import { purgeSyntheticData, businessCounts, markerHits, compact, fixtureJobs } from './purge.ts';

const cfg = loadConfig();
const [cmd, ...rest] = process.argv.slice(2);
const db = openDatabase(cfg.dbPath);
if (cmd === 'counts') { console.log(JSON.stringify({ counts: businessCounts(db), markers: markerHits(db), integrity: integrityCheck(db) }, null, 2)); }
else if (cmd === 'purge') {
  // --confirm alone is the safe mode (only tasks carrying the fixture token, in test projects). Removing every task needs --all and the
  // long flag; fixtures found in real projects are printed and refused unless --include-real-projects.
  const ALL_FLAG = '--yes-delete-every-task-and-result'; const mode = rest.includes('--all') ? 'all' : 'markers';
  if (!rest.includes('--confirm')) { console.error(`purge needs --confirm; it removes fixture tasks (marked with the fixture token) after a pre-purge backup. To remove ALL business data: purge --all ${ALL_FLAG} --confirm`); process.exit(2); }
  if (mode === 'all' && !rest.includes(ALL_FLAG)) { console.error(`purge --all removes every task, result and objective. Add ${ALL_FLAG} to confirm.`); process.exit(2); }
  if (mode === 'markers') { const hits = fixtureJobs(db); console.log(JSON.stringify({ fixture_tasks: hits }, null, 2)); }
  const removedIds = mode === 'all' ? (db.prepare('SELECT id FROM jobs').all() as Array<{ id: string }>).map((x) => x.id) : fixtureJobs(db).map((x) => x.id);
  const r = await purgeSyntheticData({ db, dbPath: cfg.dbPath, backupsDir: cfg.backupsDir, workspacesDir: cfg.workspacesDir, claudeConfigDir: cfg.claudeConfigDir, runDir: cfg.runDir, mode, allowRealProjects: rest.includes('--include-real-projects') }).catch((e) => { console.error((e as Error).message); process.exit(3); });
  // Close any gateway ACP session that still belongs to a purged task, so Claude Code cannot re-materialise session metadata later.
  const closed: string[] = [];
  try {
    const { GatewayClient } = await import('../gateway/client.ts'); const { createLogger } = await import('../log.ts'); const crypto = await import('node:crypto');
    const gw = new GatewayClient({ url: cfg.gatewayUrl, tokenFile: cfg.gatewayTokenFile, log: createLogger({ name: 'purge', stream: { write: () => true } as never }) });
    await gw.connect();
    const ctl = process.env.CLAUDEBOT_CONTROL_SESSION ?? 'agent:control:main';
    const command = async (message: string) => { let text = ''; const done = new Promise<void>((resolve) => { const off = gw.onEvent((e) => { if (e.event === 'chat' && e.payload.sessionKey === ctl && (e.payload.state === 'final' || e.payload.state === 'error')) { const m = e.payload.message as { content?: Array<{ text?: string }> } | undefined; text = (m?.content ?? []).map((b) => b.text ?? '').join(''); off(); resolve(); } }); setTimeout(() => { off(); resolve(); }, 20_000); }); await gw.call('chat.send', { sessionKey: ctl, message, idempotencyKey: crypto.randomUUID() }, 15_000); await done; return text; };
    const list = await command('/acp sessions');
    for (const line of list.split('\n')) { const key = (line.match(/agent:[a-z_]+:acp:[0-9a-f-]{36}/i) ?? [])[0]; if (!key) continue; if (mode === 'all' || removedIds.some((id) => line.includes(id))) { await command(`/acp close ${key}`); closed.push(key); } }
    gw.close();
  } catch (e) { console.error(`gateway session cleanup skipped: ${(e as Error).message}`); }
  console.log(JSON.stringify({ ...r, closed_sessions: closed, markers_after: markerHits(db), integrity: integrityCheck(db) }, null, 2));
} else if (cmd === 'compact') { console.log(JSON.stringify(compact(db))); }
else if (cmd === 'followup-requeue') {
  // A failed follow-up re-created on jobs.follow_up_email under the same followup:<record> key; refused when Sent already has one.
  const { JobStore } = await import('../jobs/store.ts'); const { requeueFollowUp, failedFollowUps } = await import('../jobs/followup.ts');
  const records = rest.includes('--all-failed') ? failedFollowUps(db) : rest.filter((x) => !x.startsWith('--'));
  if (!records.length) { console.error('usage: claudebot maintenance followup-requeue <application record id>... | --all-failed'); process.exit(2); }
  const store = new JobStore(db); console.log(JSON.stringify(records.map((r) => { const x = requeueFollowUp(db, store, r, 'owner:cli'); return x.ok ? { record: r, job: x.job.id, replaced: x.replaced } : { record: r, refused: x.reason }; }), null, 2));
}
else { console.error('usage: claudebot maintenance counts | purge --confirm [--include-real-projects] | purge --all --yes-delete-every-task-and-result --confirm | compact | followup-requeue <record>... | followup-requeue --all-failed'); process.exit(2); }
db.close();
