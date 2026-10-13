# OpenClaw `claudebot` profile as configured by ClaudeBot

Applied by `install/openclaw-profile.sh` (idempotent; backs up `openclaw.json` to `~/.claudebot/backups/` first).

- `gateway`: mode local, bind loopback, port 48310, auth token = `{source:"file", provider:"claudebot", id:"value"}` → `~/.claudebot/secrets/gateway.token` (0600). `openclaw secrets audit` reports plaintext=0.
- `acp`: enabled, backend `acpx`, defaultAgent `claude`, allowedAgents `["claude"]`.
- `plugins.entries.acpx.config`: `permissionMode=approve-reads`, `nonInteractivePermissions=deny`, `probeAgent=claude`, both MCP bridges off, `agents.claude.command = <repo>/bin/claude-acp` (wrapper sets `CLAUDE_CONFIG_DIR=~/.claudebot/claude` and `CLAUDE_CODE_EXECUTABLE=~/.local/bin/claude`).
- Disabled plugins: `codex`, `agentsapi`, `openai`, `llama-cpp`, `migrate-claude`.
- `agents.defaults.model = anthropic/claude-opus-5-5` (no credential; native turns fail loudly: "No API key found for provider anthropic", model-fallback `candidate_failed` with no candidates). The product never issues native turns.
- `agents.entries.claude` and one entry per role: `runtime.type=acp`, `acp.agent=claude`, `backend=acpx`, `mode=persistent`, `sandbox.mode=off` (ACP runs on the host and is blocked from sandboxed requesters; Claude Code's confinement is its own permission rules plus the broker).
- `browser`: enabled, `defaultProfile=claudebot`, `allowSystemProfileImport=false`.
- `cron.enabled=false` (the engine owns schedules), `tools.elevated.enabled=false`, `memory.search.enabled=false`, `telemetry.enabled=false`.

Runtime route used per job: `chat.send "/acp spawn claude --mode persistent --thread off --label <job> --cwd <job workspace>"` on the control session, then `agent` RPC with `acpTurnSource=manual_spawn` on the returned `agent:claude:acp:<uuid>` key; completion via `agent.wait`; text via `chat` final event or `chat.history`.
