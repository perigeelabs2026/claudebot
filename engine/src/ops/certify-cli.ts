/** `node src/ops/certify-cli.ts [--hours N]`: read-only go/no-go from live evidence. Exit 0 = GO, 1 = NO-GO, 2 = usage/open error. */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { loadConfig } from '../config.ts';
import { certify, formatCertify } from './certify.ts';

const args = process.argv.slice(2);
const hi = args.indexOf('--hours');
const hours = hi >= 0 ? Number(args[hi + 1]) : 6;
if (!Number.isFinite(hours) || hours <= 0) { console.error('usage: certify-cli [--hours N]'); process.exit(2); }
const cfg = loadConfig();
if (!fs.existsSync(cfg.dbPath)) { console.error(`no database at ${cfg.dbPath}`); process.exit(2); }
// Opened read-only (no migrations, no pragmas that write): certification never changes the live database.
const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000');
const r = certify(db, { hours });
db.close();
console.log(formatCertify(r));
process.exit(r.go ? 0 : 1);
