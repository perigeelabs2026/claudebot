// claudebot computer up|down|status|snapshot|reset [id]|update — the assistants' computer (see host.ts). Prints status, never the token.
import { loadConfig } from '../config.ts';
import { LimaHost } from './host.ts';

const cfg = loadConfig(); const host = new LimaHost({ home: cfg.home, secretsDir: cfg.secretsDir });
const [cmd, arg] = process.argv.slice(2);
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
try {
  if (cmd === 'up') show(await host.up());
  else if (cmd === 'down') { await host.down(); show(await host.status()); }
  else if (cmd === 'status' || !cmd) show(await host.status());
  else if (cmd === 'snapshot') show(await host.snapshot(arg ?? 'manual'));
  else if (cmd === 'reset') show(await host.reset(arg));
  else if (cmd === 'update') show(await host.update());
  else { console.error('usage: claudebot computer up|down|status|snapshot [reason]|reset [snapshot-id]|update'); process.exit(2); }
} catch (e) { console.error(`computer ${cmd}: ${(e as Error).message}`); process.exit(1); }
