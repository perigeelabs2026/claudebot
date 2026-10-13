import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface EngineConfig {
  home: string;            // runtime state root (never the source tree)
  dataDir: string;
  dbPath: string;
  secretsDir: string;
  runDir: string;
  logsDir: string;
  backupsDir: string;
  workspacesDir: string;
  claudeConfigDir: string;
  claudeExecutable: string;
  openclawBin: string;
  openclawProfile: string;
  gatewayPort: number;
  gatewayUrl: string;
  gatewayTokenFile: string;
  enginePort: number;
  /** DevTools port of the managed browser profile (from the OpenClaw profile config when present) */
  browserCdpPort: number;
  uiTokenFile: string;
  workerConcurrency: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  sourceRoot: string;
}

function readCdpPort(profile: string): number | null { try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), `.openclaw-${profile}`, 'openclaw.json'), 'utf8')) as { browser?: { profiles?: Record<string, { cdpPort?: number }> } }; return j.browser?.profiles?.claudebot?.cdpPort ?? null; } catch { return null; } }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const home = env.CLAUDEBOT_HOME ?? path.join(os.homedir(), '.claudebot');
  const gatewayPort = Number(env.CLAUDEBOT_GATEWAY_PORT ?? 48310);
  const sourceRoot = env.CLAUDEBOT_SOURCE ?? path.resolve(import.meta.dirname, '..', '..');
  return {
    home,
    dataDir: path.join(home, 'data'),
    dbPath: env.CLAUDEBOT_DB ?? path.join(home, 'data', 'claudebot.sqlite'),
    secretsDir: path.join(home, 'secrets'),
    runDir: path.join(home, 'run'),
    logsDir: path.join(home, 'logs'),
    backupsDir: path.join(home, 'backups'),
    workspacesDir: path.join(home, 'workspaces'),
    claudeConfigDir: env.CLAUDEBOT_CLAUDE_CONFIG_DIR ?? path.join(home, 'claude'),
    claudeExecutable: env.CLAUDEBOT_CLAUDE_EXECUTABLE ?? path.join(os.homedir(), '.local', 'bin', 'claude'),
    openclawBin: env.CLAUDEBOT_OPENCLAW_BIN ?? path.join(os.homedir(), '.local', 'bin', 'openclaw'),
    openclawProfile: env.CLAUDEBOT_OPENCLAW_PROFILE ?? 'claudebot',
    gatewayPort,
    gatewayUrl: env.CLAUDEBOT_GATEWAY_URL ?? `ws://127.0.0.1:${gatewayPort}`,
    gatewayTokenFile: path.join(home, 'secrets', 'gateway.token'),
    enginePort: Number(env.CLAUDEBOT_PORT ?? 48311),
    browserCdpPort: Number(env.CLAUDEBOT_BROWSER_CDP_PORT ?? readCdpPort(env.CLAUDEBOT_OPENCLAW_PROFILE ?? 'claudebot') ?? 48323),
    uiTokenFile: path.join(home, 'secrets', 'ui.token'),
    workerConcurrency: Number(env.CLAUDEBOT_WORKERS ?? 2),
    leaseSeconds: Number(env.CLAUDEBOT_LEASE_SECONDS ?? 90),
    heartbeatSeconds: Number(env.CLAUDEBOT_HEARTBEAT_SECONDS ?? 15),
    sourceRoot,
  };
}
