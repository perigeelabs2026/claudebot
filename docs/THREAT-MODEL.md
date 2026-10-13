# ClaudeBot — Threat model

Date: 2026-10-06. Scope: the local product on one Mac, one owner.

## Assets
1. Owner's Claude subscription credentials (Keychain + `~/.claudebot/claude`).
2. OpenClaw gateway token (`~/.claudebot/secrets/gateway.token`, 0600).
3. Browser sessions in the managed profile `claudebot` (cookies).
4. Business data: job ledger, artifacts, CRM-style records, approvals.
5. The owner's reputation: anything sent, published, bought, or deleted.

## Trust boundaries
- **Model ↔ host.** Claude Code runs on the host (ACP is not sandboxed by
  OpenClaw). Controls: Claude Code permission rules in the dedicated config
  dir (deny `Bash`, deny reads of `~/.claudebot/run` and `secrets`, allow
  edits only under `./`), acpx `approve-reads` + `nonInteractivePermissions=deny`,
  and the broker exposing only role-scoped tools. Residual risk: Claude Code's
  own tools can read files the rules do not deny; mitigation is the deny list
  plus not storing secrets in model-readable places.
- **Broker ↔ engine.** The MCP server authenticates with a per-job capability
  token (random 32 bytes, expires with the lease). Tools not in the capability
  are not registered, so prompt injection cannot discover them.
- **UI ↔ engine.** Loopback only; a UI token generated at install (0600) is
  required on every request; CORS denied; no remote bind.
- **Engine ↔ Gateway.** Loopback only; token auth; token stored as a file
  SecretRef, never printed.
- **Engine ↔ world.** No outbound consequential action has an enabled
  executor in this build. Reads (WebFetch/WebSearch by Claude, browser reads)
  are allowed.

## Threats and controls
| Threat | Control | Evidence |
| --- | --- | --- |
| Agent sends/publishes/buys/deletes without approval | No executor exists; `actions` require `approval_id` with matching `content_hash`; refusal is audited | recovery test 11 |
| Approved content is swapped after approval | Approval binds `content_hash`; mismatch → `stale` | recovery test 12 |
| Duplicate side effect after restart | `actions.idempotency_key` UNIQUE, `performed_at` checked before run | recovery test 10 |
| Agent widens its own permissions | Capability file is written by the engine only; broker has no tool to change it; policy tables have no model-facing write tool | unit tests on broker tool registry |
| Secret leakage into prompts/logs | Logger redacts `token`, `Bearer`, `sk-`, `oauth`; wrapper passes env only to the adapter; `claude auth status` output is filtered to booleans | log scrub test |
| Plaintext gateway token in config | Migrated to `{source:"file"}` SecretRef; `openclaw secrets audit` run | PROGRESS.md |
| Prompt injection from fetched web content | Broker tools are role-scoped; consequential actions impossible; reviewer role re-checks evidence; artifacts marked by provenance | role definitions |
| Fabricated evidence or leads | Evidence records require a source URL/hash; reviewer stage fails the contract otherwise | workflow contracts |
| Zombie worker keeps lease | Heartbeat is CAS on `lease_owner` | recovery test 2 |
| UI shows phantom activity | Busy = leased job + heartbeat < 60s; otherwise idle | UI contract test |
| Blocking on a human unattended | Owner-presence gates become `waiting_for_auth` blockers; nothing opens dialogs | design |
| Another local user | Out of scope (single-user Mac); files are 0600/0700 |

## Explicitly not protected
- A compromised host account can read everything the owner can.
- Claude's own web reads are not proxied or filtered.
- The managed browser's cookies are protected only by file permissions.
