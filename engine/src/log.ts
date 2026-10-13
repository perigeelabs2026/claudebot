import fs from 'node:fs';
import path from 'node:path';

const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+\/=-]+/g, 'Bearer [REDACTED]'],
  [/(token|password|secret|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)(?!Bearer\b)([^\s"',}]+)/gi, '$1$2[REDACTED]'],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]'],
  [/oauth[_-]?token[^\s]*/gi, 'oauth_token=[REDACTED]'],
  [/\b[A-Za-z0-9+\/_-]{40,}={0,2}\b/g, '[REDACTED-BLOB]'],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(opts: { name: string; file?: string; stream?: NodeJS.WritableStream; base?: Record<string, unknown> }): Logger {
  let fileStream: fs.WriteStream | undefined;
  if (opts.file) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    fileStream = fs.createWriteStream(opts.file, { flags: 'a', mode: 0o600 });
  }
  const stream = opts.stream ?? process.stderr;
  const base = opts.base ?? {};
  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    const rec = { ts: new Date().toISOString(), level, name: opts.name, msg, ...base, ...(fields ?? {}) };
    const line = redact(JSON.stringify(rec, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))) + '\n';
    stream.write(line);
    fileStream?.write(line);
  }
  const make = (b: Record<string, unknown>): Logger => ({
    log: (l, m, f) => write(l, m, { ...b, ...(f ?? {}) }),
    info: (m, f) => write('info', m, { ...b, ...(f ?? {}) }),
    warn: (m, f) => write('warn', m, { ...b, ...(f ?? {}) }),
    error: (m, f) => write('error', m, { ...b, ...(f ?? {}) }),
    debug: (m, f) => write('debug', m, { ...b, ...(f ?? {}) }),
    child: (f) => make({ ...b, ...f }),
  });
  return make({});
}
