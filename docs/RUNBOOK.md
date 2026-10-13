# Operator runbook

## Daily
- Open ClaudeBot. The top pills must read Claude: ready, Gateway: ok, Queue: ok, Workers: ok. Anything else is a blocker with an action on the Command Center.
- Approvals: every pending card shows the exact action, target, content and hash. Approve only what you read. A changed draft becomes `stale` automatically.
- Memory: accept or decline proposals. Nothing becomes a rule without you.

## Signals and what they mean
| Signal | Meaning | Action |
| --- | --- | --- |
| Claude: auth required | Claude Code is signed out in the ClaudeBot config dir | run the reconnect command in Connections |
| Claude: limited | plan limit; `reset_at` shown on the job | none; resumes automatically; if no reset time, probes 5/10/20/40/60 min |
| Queue: stale_leases | a worker died and the supervisor has not yet reclaimed | none; reclaim runs every 5 s |
| Workers: none | no worker alive | supervisor respawns; check `~/.claudebot/logs/worker.log` |
| Browser: profile_missing | managed profile not created | `openclaw --profile claudebot browser create-profile --name claudebot` |
| Chat: "still working on your previous message" | one reply per conversation at a time | wait for the reply; a paused reply (sign in / usage limit) does not block |
| Browser pane: "No new frames for N s" | Chrome sent no screencast frame (page idle or window hidden) | open the window; frames resume on change |
| Sign in to continue (browser:<site>) | the assistant hit a login wall | Chat → Take over → sign in in the real window → I'm done |
| Job: RETRY_BUDGET_EXHAUSTED | five retries failed | read failure detail; fix; Re-queue |
| Incident: CHECKPOINT_CORRUPT | a checkpoint hash did not verify | recovery already used the previous one; investigate disk |

## Chat and browser
- The owner talks to the lead assistant in Chat; it delegates with `create_job`. Delegation/result cards are derived from task rows every 5 s; if a card is missing, check `job_events` for the task.
- Lead sessions hold an adapter + Claude process each; idle ones close after 20 min. "Free memory" in a conversation closes it now; the next message replays the transcript.
- Live browser: `/api/browser/live` (status), `/api/browser/stream` (frames), takeover flag in `runtime_state.browser.takeover`. If frames never arrive, confirm `curl http://127.0.0.1:48323/json/version` answers.

## Halt and recovery
- **Halt everything safely:** `launchctl bootout gui/$(id -u)/com.claudebot.engine` stops the engine and its workers at the next checkpoint boundary (running Claude turns are abandoned; their tasks go back to the queue and resume from the last save point when the engine returns). Claude sessions still open in the gateway are closed by the next engine start's idle/finished-task sweeps. To stop the gateway too: `openclaw --profile claudebot gateway stop`. The desktop window can be closed at any time; it never stops work.
- **Stop one task:** Office → click the assistant → Stop (or `POST /api/tasks/<id>/cancel`). The running Claude turn is aborted, the lease released, save points and files kept, the task's browser tab closed.
- **Resume after a halt:** `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.engine.plist && launchctl kickstart -k gui/$(id -u)/com.claudebot.engine`. On start the engine reaps orphan workers and probes, reclaims stale leases, promotes due retries, closes browser tabs of finished tasks, takes a backup, and resumes queued work. Conversations, tasks and session bindings are in SQLite; nothing is lost by a halt.
- **Restore a database backup:** stop the engine, copy `~/.claudebot/backups/<file>.sqlite` over `~/.claudebot/data/claudebot.sqlite` (remove `-wal`/`-shm`), start the engine. Pre-migration snapshots are named `*-pre-migration-000N.sqlite`.
- **Memory emergency:** Settings → lower "Tasks that can run at once"; Chat → "Free memory" on idle conversations; close your own heavy browser tabs in the ClaudeBot browser (the product never closes owner tabs). The memory guard pauses new starts below the configured kernel level and never kills running work.
- **Roll back this build:** follow `~/.claudebot/backups/release-9e6751c-20261007T164044Z/ROLLBACK.md` (source bundle, app bundle, database copy, plists). Migrations 0005 (search index) and 0006 (actions rebuilt with `uncertain`, one-shot schedules, triggers) were applied after that backup; pre-migration copies are `~/.claudebot/backups/pre-0005-*.sqlite` and `pre-0006-*.sqlite`. The older engine runs on the newer database (it ignores the new tables and columns), so restoring the database is only needed if you want the old state exactly.
- **Approved actions:** decide in the app (Approve exactly this / Reject). An approved send or publish can be run once with "Run once (local outbox)", which writes the exact content to `~/.claudebot/outbox/<kind>/` — nothing is delivered to anyone. If a run's outcome is ever unknown the card says "Outcome unknown"; it is never retried; record "It happened" or "It did not happen". Purchases, deletions and production changes have no executor.
- **Event triggers:** `POST /api/triggers` (owner token) creates one and shows its secret once; local tools post `{"event_id": "...", "data": {...}}` to `http://127.0.0.1:48311/api/hooks/<id>` with header `x-claudebot-trigger-token`. One task per event id; the payload is treated as untrusted data. Disable with `DELETE /api/triggers/<id>`. Listens on this Mac only.
- **Delegation budgets** (Settings keys, owner only): `delegation_max_depth` (2), `delegation_max_children` (3), `delegation_max_auto_turns` (2). Stopping a task stops its child tasks.
- **Fault-injection tests never touch your gateway:** `node scripts/isolated-gateway.mjs setup|start|stop|status` runs a separate OpenClaw profile (claudebot-test, port 48410, browser off). It needs the official acpx plugin installed into that profile (`openclaw --profile claudebot-test plugins install clawhub:@openclaw/acpx@2026.9.7`, a download) before recovery scenarios 3 and 4 can run; until then they are blocked, not skipped silently.
- **Sign-in needed:** Office shows "Sign in to continue (site)" → Chat → Browser tab → Take over → sign in in the real window → I'm done. Nothing is typed by the product.

## Voice
- Talk uses macOS speech recognition inside the ClaudeBot app; on macOS 26 it uses `SpeechTranscriber` (SpeechAnalyzer), which runs on the device and works with Siri and Dictation turned off; older systems fall back to `SFSpeechRecognizer` with `requiresOnDeviceRecognition`, which needs Dictation enabled and says so if it is not. If a Mac cannot recognize on the device, ClaudeBot asks before using Apple's server recognition. Replies are spoken with macOS speech synthesis. Claude only ever receives text, through the same lead session as typed messages.
- Push-to-talk: a pause stops listening and leaves the words in the message box, unsent; press Send (or Done while listening) to send. Hands-free conversation mode sends after a pause. Reloading the window ends any voice session.
- The microphone is off until Talk; it turns off when listening ends, on End voice, when the window closes and when the app quits (state in `~/.claudebot/run/shell.json`: `mic_active`, `voice_state`).
- Permissions: System Settings › Privacy & Security › Speech Recognition and › Microphone. The app is ad-hoc signed, so macOS may ask again after an update of the app binary.
- Voice log: `~/.claudebot/run/voice-events.jsonl` records every voice event and microphone open/release (never what was said).
- Test hook: `claudebot://voice-fixture?file=/tmp/x.aiff&done=1` runs a labelled fixture voice turn only while `~/.claudebot/run/voice-fixture.allow` exists (acceptance tests create it and remove it afterwards); messages it creates say "from a recorded test file, not the microphone".
- Sign the app with a stable local identity (create a self-signed code-signing certificate in Keychain Access, then build with `CLAUDEBOT_SIGN_IDENTITY="<certificate name>" shell/build.sh`) so macOS keeps the microphone permission across rebuilds; an ad-hoc build loses it.
- Self-check without the microphone: `say -o /tmp/t.aiff "hello there"; open "claudebot://voice-selftest?file=/tmp/t.aiff"` → `~/.claudebot/run/voice-selftest.json`. Capabilities: `open claudebot://voice-caps` → `run/voice-caps.json`.

## Commands
```bash
openclaw --profile claudebot gateway status --deep     # service + health
openclaw --profile claudebot secrets audit            # must be clean
launchctl print gui/$(id -u)/com.claudebot.engine | head -20
curl -s -H "x-claudebot-token: $(cat ~/.claudebot/secrets/ui.token)" http://127.0.0.1:48311/api/health | jq .
cd claudebot/engine && npm test && npm run test:recovery
```
