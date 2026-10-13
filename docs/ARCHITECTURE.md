# ClaudeBot — Architecture

Status: design accepted 2026-10-06.
This file is the contract the code is held to. Deviations are recorded in PROGRESS.md.

## 1. What it is

A local-first macOS product that runs a small business's non-consequential work
continuously (research, analysis, drafting, internal records, tests) using the
owner's own Claude Max subscription through the official Claude Code install,
and stops at explicit owner gates for anything consequential (send, publish,
spend, delete, production change, new scope, new login).

Claude is the only enabled intelligence. There is no OpenAI route, no API-key
fallback, and no model substitution. A missing Claude login produces exactly one
state, `Reconnect Claude`, not a cascade of failed jobs.

## 2. Processes and boundaries

```
┌──────────────────────────────┐   launchd (KeepAlive)
│ ClaudeBot.app (Swift shell) │──opens──▶ http://127.0.0.1:48311/?t=<ui-token>
└──────────────────────────────┘
                                 ┌──────────────────────────────────────────────┐
  com.claudebot.engine          │ claudebotd  (supervisor, one process)        │
  (LaunchAgent, KeepAlive)       │  • control API + UI (loopback HTTP, SSE)      │
                                 │  • scheduler (cron-like + event triggers)     │
                                 │  • dispatcher (queued → leased, bounded N)    │
                                 │  • watchdog (gateway, claude, browser, leases)│
                                 │  • approval service, audit ledger, backups    │
                                 │  • spawns worker children, restarts on crash  │
                                 └───────┬───────────────────────────┬──────────┘
                                         │ child processes            │ loopback WS
                             ┌───────────▼───────────┐     ┌─────────▼──────────────┐
                             │ worker (×N)           │     │ OpenClaw Gateway (lab)  │
                             │ leases ONE job,       │────▶│ profile=lab, port 48310 │
                             │ runs stages,          │     │ acp.backend=acpx        │
                             │ heartbeats lease,     │     └─────────┬──────────────┘
                             │ checkpoints           │               │ ACP (stdio)
                             └───────────┬───────────┘     ┌─────────▼──────────────┐
                                         │ MCP (stdio,     │ claude-acp wrapper      │
                                         │ per job)        │ CLAUDE_CONFIG_DIR=~/.claudebot/claude
                             ┌───────────▼───────────┐     │ CLAUDE_CODE_EXECUTABLE=~/.local/bin/claude
                             │ capability broker     │◀────│ → @agentclientprotocol/claude-agent-acp
                             │ (claudebot-tools)    │     │ → official Claude Code → user's Max plan
                             └───────────────────────┘     └────────────────────────┘
```

Source tree: your clone of this repository. Runtime state: `~/.claudebot` (never in the
source tree). OpenClaw state: `~/.openclaw-claudebot` (profile `lab`). Claude config:
`~/.claudebot/claude` (dedicated `CLAUDE_CONFIG_DIR`).

Components (each a module under `engine/src/`):

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `db/` | SQLite (node:sqlite, WAL), migrations, transactional job store, append-only ledger | nothing |
| `jobs/` | state machine, lease/heartbeat/expiry, checkpoints (hashed, versioned), retry/backoff, success contracts, idempotency | db |
| `scheduler/` | cron-like schedules and event triggers → enqueue jobs with idempotency keys | jobs |
| `dispatcher/` | bounded concurrency; spawns/monitors worker children; stale-lease reclaim | jobs |
| `worker/` | leases a job, executes stages, heartbeats, checkpoints before/after external work | jobs, runtime, broker, browser |
| `runtime/` | `ModelRuntime` interface; `ClaudeAcpRuntime` (Gateway WS → ACP); stubs for API/Bedrock/Vertex/Work (`not configured`) | gateway |
| `gateway/` | OpenClaw Gateway WS client (connect, chat.send, events, health), token from file | nothing |
| `broker/` | MCP stdio server exposing per-agent allowed tools; capability tokens; audited writes | db, approvals |
| `approvals/` | approval records bound to a content hash; staleness; refusal + audit of unapproved consequential actions | db |
| `browser/` | OpenClaw managed profile `claudebot`; login health; screenshot attach | gateway |
| `watchdog/` | health of UI/queue/gateway/claude/browser; restarts; hung-tool cancel | all |
| `api/` | loopback HTTP + SSE; UI token; health endpoint per subsystem | all |
| `ui/` | static app (vanilla JS modules, no CDN) | api |
| `backup/` | versioned SQLite snapshots (`.backup` API) and rotation | db |

## 3. Runtime route (the only enabled one)

`ClaudeBot worker → OpenClaw Gateway (ws://127.0.0.1:48310, token auth) →
chat.send on session agent:<role>:job-<id> → OpenClaw agent entry with
runtime.type=acp, acp.agent=claude, backend=acpx, mode=persistent → acpx →
wrapper (sets CLAUDE_CONFIG_DIR + CLAUDE_CODE_EXECUTABLE) →
@agentclientprotocol/claude-agent-acp → ~/.local/bin/claude (official install)
→ user's Claude Max subscription`.

- OpenClaw's text-only "CLI backend" (`agentRuntime.id: claude-cli`) is NOT
  used. `acp.allowedAgents = ["claude"]` only.
- `agents.defaults.model` is set to an Anthropic ref so nothing resolves to
  `openai/*`; the OpenAI/Codex plugins are disabled; no provider keys exist.
- The wrapper never reads or forwards tokens. Claude Code owns login/refresh
  inside the dedicated config dir. Logs never include credentials.
- Settings in `~/.claudebot/claude/settings.json` fix Claude Code's own
  permission rules (allow reads/edits inside the job workspace, deny Bash,
  deny reads of `~/.claudebot/run` and `~/.claudebot/secrets`, auto-enable
  the project `.mcp.json` so the broker is the only tool surface beyond files).
- acpx: `permissionMode=approve-reads`, `nonInteractivePermissions=deny` so any
  prompt that would require a human is denied, never auto-approved.

The adapter classifies failures (`quota_exhausted`, `rate_limited`,
`auth_required`, `access_denied`). The runtime maps them to job states:
`waiting_for_reset`, `retry_scheduled`, `waiting_for_auth`, `failed_terminal`.

## 4. Durable job model

States: `drafted, queued, leased, running, waiting_for_reset, waiting_for_auth,
waiting_for_approval, retry_scheduled, completed, failed_terminal, cancelled`.

Invariants enforced in `jobs/`:
1. Lease is acquired in one `BEGIN IMMEDIATE` transaction: `queued`→`leased`
   with `lease_owner`, `lease_expires_at`. Expired leases are reclaimed by the
   dispatcher (`leased|running` with `lease_expires_at < now` → `queued`,
   stage_attempt unchanged, event `lease.reclaimed`).
2. Heartbeat extends `lease_expires_at` only for the current `lease_owner`
   (compare-and-set), so a zombie worker cannot keep a lease alive.
3. Every stage writes `checkpoint(stage, attempt, phase=before|after, payload,
   sha256)` before and after external work. Recovery picks the latest
   checkpoint whose hash verifies; a corrupt one raises an `incident` and the
   previous verified checkpoint is used.
4. Side effects are rows in `actions` keyed by `idempotency_key`; an action
   with `performed_at` set is never re-run. Consequential actions additionally
   need an `approval_id` whose `content_hash` matches the action's.
5. `completed` requires `success_contract` evaluation to pass (stored
   predicate over artifacts/checkpoint); otherwise the job stays `running` or
   goes to `retry_scheduled`.
6. `failed_terminal` keeps `last_good_checkpoint_id`. Retryable vs terminal
   failure are distinct columns (`failure_kind`).
7. Plan limit → `waiting_for_reset` with `reset_at` (from the adapter when
   present) or bounded probe schedule (5m, 10m, 20m, 40m, cap 60m).
8. Auth failure pauses only jobs whose stage needs that identity
   (`claude` or `browser:<site>`), never deterministic stages.
9. `job_events` is append-only (no UPDATE/DELETE grants in code; a trigger
   blocks both), sufficient to reconstruct history.

## 5. Supervision and 24/7

- LaunchAgent `com.claudebot.engine` (KeepAlive, RunAtLoad) runs
  `claudebotd`. LaunchAgent for the OpenClaw gateway is installed by
  `openclaw --profile claudebot gateway install` (label `ai.openclaw.claudebot` managed by
  OpenClaw). The supervisor also checks gateway health and restarts it via
  `openclaw --profile claudebot gateway restart` if the watchdog sees it down.
- Workers are child processes; crash → respawn; lease expiry → reclaim.
- Graceful shutdown: SIGTERM → workers finish the current checkpoint boundary
  (bounded 20s) → leases released → exit.
- Backups: `backup/` snapshots the DB every 6h and before migrations to
  `~/.claudebot/backups/<ts>.sqlite` (keep 20).
- Startup integrity: `PRAGMA integrity_check`, migration version, checkpoint
  hash spot-check, orphan process reap (workers from a previous supervisor
  pid), stale leases.
- `/api/health` reports `ui`, `queue`, `gateway`, `claude`, `browser`
  separately with evidence timestamps; nothing reports ok because the UI loaded.

## 6. Capability broker and approvals

Claude gets only: file tools inside the job workspace, and the MCP tools listed
for its agent role. The broker is `engine/src/broker/server.ts` launched by
Claude Code from the job workspace's `.mcp.json` with `--job <id>`; it reads a
per-job capability file (0600, outside the workspace, denied to Claude's Read)
and exposes only the tools in that capability. Writes go through the engine
API with the capability token and are audited.

Gates:
- automatic: research, analysis, drafting, workspace files, internal DB
  updates, read-only connectors, retries, internal tests;
- auto-review: a bounded local command from an exact allowlist (`run_allowlisted`);
  anything not on the list is refused and audited;
- owner approval: `send`, `publish`, `purchase`, `delete`, `production_change`,
  `new_scope`, `new_audience`, `budget_increase`, `policy_change`;
- owner presence: login/MFA/CAPTCHA/device auth (surfaced as a blocker, never
  automated).

Approval record = {action_kind, target, content_hash, evidence refs, budget,
expires_at}. Executing an action re-hashes the content; mismatch → `stale`.
In this build all consequential executors are disabled (`executor: disabled`)
so even an approved send cannot occur; the UI says so.

## 7. Agents (bounded roles)

Each role is a record in `agents` with purpose, allowed inputs, allowed tools,
prohibited actions, outputs, escalation, memory scope, concurrency, acceptance
tests. Roles: chief_of_staff, market_research, offer_product, gtm_strategy,
revenue_ops, content_campaigns, sales, customer_success, finance_ops,
reviewer. Definitions live in `engine/src/agents/roles.ts` and are rendered
in the Company Brain surface from the DB, not from UI constants.

## 8. Revenue loop

Workflows in `engine/src/workflows/` are ordered stage lists:
`observe → find_opportunity → validate_evidence → design_offer → build_assets
→ prepare_audience → review → approve → execute_within_bounds → measure →
learn → propose_next`. `approve` is a `waiting_for_approval` stage;
`execute_within_bounds` only runs actions with a matching, unexpired, unstale
approval and an idempotency record; `learn` writes proposals to `memory_proposals`
(never to policy).

## 9. Interface

Chat first. Primary navigation: Chat, Projects, Work, Results, Needs your review;
everything else (Overview, Assistants, Schedules, Browser, Connections, Saved
instructions, System status, Templates, Settings, Activity) sits under "More".
All data comes from `/api/*`; the UI holds no placeholder data. An assistant is
shown working only when a task it owns is `leased|running` with a heartbeat
< 60 s old. Connection pills are labelled "Connections" and never imply a task
succeeded; task state is worded in plain English (`Sign in to continue`,
`Trying again at …`, `Ready to review`) with technical identifiers (session,
lease, idempotency key, hashes, raw events) in collapsed "Technical details".

### 9.1 Conversations (`chat/`)

`conversations` and `messages` are durable tables (migration `0003_chat`).
An owner message creates exactly one `chat.turn` task (idempotency key
`chat:<message id>`, priority 3) that runs on an ordinary worker through the
same Claude Code → OpenClaw ACP route as every other task. The turn's `chat`
stage binds to the conversation's persistent ACP session (`conversations.session_ref`,
label = conversation id, cwd = `<project>/conversations/<id>`); turns resume it,
and a closed session is replaced with the durable transcript replayed into the
prompt. The lead assistant (system agent `coordinator`, shown as "Lead
assistant") can delegate with `create_job` (child task inherits
`conversation_id`), read results with `list_jobs`/`read_artifact`, and raise
`request_approval`. It has no send/publish/purchase/delete capability.

The broker capability for a conversation is keyed by the conversation id
(`run/jobs/<conv id>/capability.json`, `.mcp.json --job <conv id>`); it names
the turn job currently acting and is emptied (`tools: []`) between turns.
The engine verifies `x-capability-key` + token and refuses a capability bound
to a different job.

Delegation, result, decision and status messages are never written by the
model: `ChatStore.sync()` (every 5 s in the supervisor) derives them from job
and approval rows, exactly once per (job, state) or approval, so the
conversation shows "I assigned the work" (delegation card with live state) and,
separately, "the work finished" (result card with the registered file, its
hash verified on disk). One turn per conversation runs at a time (the API
answers 409 while a reply is in progress). Idle lead sessions are closed after
20 minutes (`CLAUDEBOT_CHAT_IDLE_CLOSE_MS`); finished specialist tasks close
their sessions immediately so no adapter/Claude process outlives its work.

### 9.2 Live browser (`browser/live.ts`)

The managed profile `claudebot` is a headed Google Chrome that OpenClaw starts
with a DevTools endpoint (port from the lab config, default 48323). The engine
attaches to the page the assistant is using (last URL opened by `browser_read`,
else the followed tab, else the first real tab) and streams Chrome's own
`Page.startScreencast` JPEG frames to the UI over SSE (`/api/browser/stream`),
only while someone is watching. Each frame carries its capture time; the pane
shows the age and says when frames stop. No mock, no stale capture.

Owner takeover: `POST /api/browser/takeover {active, site}` sets a durable flag
(`runtime_state.browser.takeover`, audited); while active the `browser_read`
tool refuses before spawning anything. "I'm done" with a site runs the
read-only sign-in marker check (never a login) and resumes tasks waiting on
`browser:<site>`. `POST /api/browser/front` activates the tab;
`POST /api/browser/arrange` places the real window via
`Browser.setWindowBounds`; the Swift shell tiles itself on the left and the
browser on the right ("Place beside") and activates the browser process by the
pid the engine reported (no accessibility permission needed). Embedding another
process's window inside the WKWebView is not possible on macOS, so the in-app
pane is a live screencast and the real window is attached beside it.

## 10. Commercial seam

`ModelRuntime` interface: `{ id, describe(), health(), startTurn(), resume(),
cancel() }`. Implementations: `claude-acp` (enabled), `claude-work`,
`anthropic-api`, `bedrock`, `vertex` (stubs returning `not_configured`). One
account per customer; no pooling.
