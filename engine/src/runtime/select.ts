/**
 * Where Claude turns run: on this Mac (the original route) or inside the assistants' computer (phase 2). One setting,
 * `runtime_location` = mac | computer, read at worker/supervisor start; switching back to mac is the rollback.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/open.ts';
import type { EngineConfig } from '../config.ts';
import { GatewayClient } from '../gateway/client.ts';
import { ClaudeAcpRuntime } from './claude-acp.ts';
import { ComputerRuntime, VM_DATA, computerAuthStatus } from './computer.ts';
import type { ModelRuntime } from './types.ts';

export type RuntimeLocation = 'mac' | 'computer';
export function runtimeLocation(db: DB): RuntimeLocation {
  const v = (db.prepare("SELECT value FROM settings WHERE key = 'runtime_location'").get() as { value: string } | undefined)?.value;
  return v === 'computer' || v === '"computer"' ? 'computer' : 'mac';
}
export const COMPUTER_GATEWAY = { url: 'ws://127.0.0.1:48789', tokenFile: (cfg: EngineConfig) => path.join(cfg.secretsDir, 'computer-gateway.token') };

export function makeRuntime(cfg: EngineConfig, db: DB, log: ConstructorParameters<typeof GatewayClient>[0]['log']): { runtime: ModelRuntime; gateway: GatewayClient; location: RuntimeLocation } {
  const loc = runtimeLocation(db);
  if (loc === 'computer' && fs.existsSync(COMPUTER_GATEWAY.tokenFile(cfg))) {
    const gateway = new GatewayClient({ url: COMPUTER_GATEWAY.url, tokenFile: COMPUTER_GATEWAY.tokenFile(cfg), log });
    const inner = new ClaudeAcpRuntime({ gateway, log, claudeExecutable: '/home/lima.guest/.local/bin/claude', claudeConfigDir: `${VM_DATA}/claude`, authProbe: computerAuthStatus });
    return { runtime: new ComputerRuntime(inner, { hostWorkspaces: cfg.workspacesDir, runDir: cfg.runDir, enginePort: cfg.enginePort, log }), gateway, location: 'computer' };
  }
  const gateway = new GatewayClient({ url: cfg.gatewayUrl, tokenFile: cfg.gatewayTokenFile, log });
  return { runtime: new ClaudeAcpRuntime({ gateway, log, claudeExecutable: cfg.claudeExecutable, claudeConfigDir: cfg.claudeConfigDir }), gateway, location: 'mac' };
}
