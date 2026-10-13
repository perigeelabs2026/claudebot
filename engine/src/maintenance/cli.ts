/** `claudebot maintenance <command>`: explicit, logged maintenance operations against the installed runtime state. */
import { loadConfig } from '../config.ts';
import { openDatabase, integrityCheck } from '../db/open.ts';
import { purgeSyntheticData, businessCounts, markerHits, compact } from './purge.ts';

const cfg = loadConfig();
const [cmd, ...rest] = process.argv.slice(2);
const db = openDatabase(cfg.dbPath);
if (cmd === 'counts') { console.log(JSON.stringify({ counts: businessCounts(db), markers: markerHits(db), integrity: integrityCheck(db) }, null, 2)); }
else if (cmd === 'purge') {
  const mode = rest.includes('--markers') ? 'markers' : 'all';
  if (!rest.includes('--confirm')) { console.error(`purge (${mode}) needs --confirm; it removes business data (not auth, settings or definitions) after a pre-purge backup`); process.exit(2); }
  const removedIds = (db.prepare('SELECT id FROM jobs').all() as Array<{ id: string }>).map((x) => x.id);
  const r = await purgeSyntheticData({ db, dbPath: cfg.dbPath, backupsDir: cfg.backupsDir, workspacesDir: cfg.workspacesDir, claudeConfigDir: cfg.claudeConfigDir, runDir: cfg.runDir, mode });
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
else { console.error('usage: claudebot maintenance counts | purge [--markers] --confirm | compact'); process.exit(2); }
db.close();
