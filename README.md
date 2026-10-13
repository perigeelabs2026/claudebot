# ClaudeBot

**Your own AI team, running on your Mac and your Claude subscription.**

Install with one line in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/perigeelabs2026/claudebot/main/install.sh | bash
```

That's it. The installer sets up everything, opens your browser once to sign in to Claude, and launches the app.

ClaudeBot gives you a lead assistant (the Chief of Staff) and a team of specialists you talk to like colleagues. You chat in direct messages or groups, `@mention` assistants, keep talking while they work in the background, and get results, drafts and files delivered back into the conversation. A pixel-art office shows who is really working on what.

It is free and open source (MIT). No API keys, no extra model subscriptions: every model turn goes through the official Claude Code on your own Claude plan.

```
ClaudeBot app ─▶ ClaudeBot engine ─▶ OpenClaw gateway ─▶ acpx ─▶ Claude Code ─▶ your Claude subscription
```

## What you get

- **A team, not a chatbot.** Chief of Staff plus built-in Researcher, Writer & builder, Reviewer and Web reader. Create more from plain words; rename and edit any of them.
- **Direct chats and groups** of two to six assistants, with `@mentions`, `@everyone`, replies and visible handoffs.
- **Real background work.** Durable tasks with progress, Stop, redirect, blockers, questions and automatic result delivery. Survives closing the window, restarting the app or the engine.
- **Files and results.** Attach sources; preview, revise and download outputs with versions and hashes.
- **A browser you can watch.** A managed, separate browser profile the assistants use for research and form preparation. You take over for logins, passwords and CAPTCHAs.
- **Approvals.** Sending, publishing, buying and deleting always stop for your Allow once / Always allow / Deny.
- **Voice.** On-device dictation and live voice conversation (macOS speech; Claude only ever sees text).
- **Routines.** "Every weekday at 8:30" becomes a schedule; results land in the same chat. A morning report from the Chief of Staff.
- **Telegram.** Talk to your Chief of Staff and answer approvals from your phone.

## Requirements

- macOS 13 or newer (Apple silicon or Intel)
- A Claude subscription that includes Claude Code (Pro or Max)
- Xcode Command Line Tools (the installer prompts for them)
- About 1 GB of disk; 16 GB RAM or more recommended

## Quick start

1. Open **Terminal** (press ⌘ Space, type "Terminal", press Return).
2. Paste the install line above and press Return.
3. If macOS asks to install the **Command Line Tools**, click **Install**. The installer waits for it.
4. When your browser opens, sign in to Claude and approve. Come back to Terminal.
5. ClaudeBot opens. Say hello to your Chief of Staff.

Everything goes into your home folder (no `sudo`, no admin password): Node.js 24, Claude Code, the OpenClaw gateway and its acpx plugin in `~/.local`, the source in `~/ClaudeBot`, your data in `~/.claudebot`, and the app in Applications. Run the same line again any time; it updates and repairs.

Prefer to clone it yourself? `git clone https://github.com/perigeelabs2026/claudebot.git && cd claudebot && ./install.sh`

### Commands

| Command | What it does |
| --- | --- |
| `claudebot doctor` | Checks every part of the install and prints the exact fix for anything wrong |
| `claudebot login` | Signs in to Claude again |
| `claudebot update` | Gets the latest version and reinstalls |
| `claudebot start` / `stop` | Starts or stops the background engine |
| `claudebot logs` | Follows the engine log |

Uninstall: `~/ClaudeBot/install/uninstall.sh` (add `--purge` to also delete your data).

## Troubleshooting

Start with `claudebot doctor`. Common fixes:

| Problem | Fix |
| --- | --- |
| `claudebot: command not found` | Open a new Terminal window, or use `~/.local/bin/claudebot` |
| App says "Sign in to continue" | Run `claudebot login` and finish the browser sign-in |
| App says the engine is not reachable | Run `claudebot start`, then `claudebot doctor` |
| "Claude usage limit reached" | Your plan's limit was hit. ClaudeBot waits and resumes on its own when it resets |
| Installer stopped at Command Line Tools | Run `xcode-select --install`, finish it, then run the install line again |
| Port 48311 or 48310 already in use | Quit the app using it (`lsof -iTCP:48311`), then `claudebot start` |
| Microphone asks again after every update | See "Voice" in [docs/RUNBOOK.md](docs/RUNBOOK.md) to sign the app with a stable identity |

Still stuck? [Open an issue](https://github.com/perigeelabs2026/claudebot/issues) with the output of `claudebot doctor`.

## Telegram (optional)

1. In Telegram, open **@BotFather**, send `/newbot` and follow the prompts. Copy the bot token it gives you.
2. In ClaudeBot, open **More › Settings › Telegram**, paste the token and press **Save token**.
3. When Telegram accepts the token, press **Connect my chat**. ClaudeBot shows a `/start <code>` message.
4. Send that exact message to your new bot in Telegram. Your chat is now the only one connected.

The token is stored locally in `~/.claudebot/secrets` and never leaves your Mac except to talk to Telegram.

## Privacy and safety

- Everything runs locally. The engine and gateway listen on loopback only (`127.0.0.1:48311` and `:48310`) and require a local token.
- Your data lives in `~/.claudebot` (SQLite database, files, workspaces, logs). Claude Code uses its own config folder inside it, separate from your normal Claude Code login.
- Assistants have no shell. Coding checks run in a macOS sandbox with no network and no access to your keys.
- Consequential actions (send, publish, purchase, delete, production change) have no executor in this build: they are prepared and approval-bound, never carried out on their own.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) and [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Project layout

| Path | What it is |
| --- | --- |
| `shell/` | The native macOS app (Swift, WebKit, on-device speech) |
| `engine/src` | The engine: durable jobs, chat, coordination, broker, browser, approvals, routines, Telegram |
| `engine/ui` | The app's interface (plain JS/CSS served by the engine) |
| `engine/test` | Unit, integration, release and recovery tests |
| `install/` | Install, uninstall, OpenClaw profile and LaunchAgent template |
| `design/` | Design system: tokens, components, office art |
| `skills/` | Reviewed skills the assistants can use |

## Development

```bash
git clone https://github.com/perigeelabs2026/claudebot.git
cd claudebot/engine
npm ci
npm test              # unit, integration and release tests
npm run typecheck
npm run test:recovery # crash/restart recovery tests
```

Tests need Node.js 24+. A few sandbox tests only run on macOS and are skipped elsewhere.

## Community

ClaudeBot is built in the open and we want it to be yours too. Bug reports, ideas, new skills, assistant templates and pull requests are all welcome.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started.
- Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security issues privately as described in [SECURITY.md](SECURITY.md).
- See what changed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). ClaudeBot is an independent project and is not affiliated with Anthropic or OpenClaw. Claude and Claude Code are trademarks of Anthropic.
