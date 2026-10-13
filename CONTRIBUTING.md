# Contributing to ClaudeBot

Thanks for helping build ClaudeBot. Every contribution counts: bug reports, docs, skills, assistant templates, design and code.

## Ground rules

These keep ClaudeBot trustworthy. Pull requests that break them will not be merged.

1. **Claude-only route.** Model turns go ClaudeBot → OpenClaw → acpx → official Claude Code → the user's Claude subscription. Do not add other model providers, API keys or paid services.
2. **Truthful UI.** Every status, message, number and office animation must come from a real job, lease, heartbeat, approval or recorded event. No fake progress, sample data or placeholder content in shipped code (`engine/test/release/contamination.test.ts` enforces this).
3. **Approvals stay approvals.** Sending, publishing, purchasing, deleting, permission and production changes must stay bound to an exact owner approval.
4. **Never handle secrets.** Never log, print or copy credentials or OAuth tokens. Passwords, MFA and CAPTCHA are always the owner's to enter.
5. **Local first.** The engine binds to loopback only. Data stays in `~/.claudebot`.

## Getting set up

```bash
git clone https://github.com/<you>/claudebot.git
cd claudebot/engine
npm ci
npm test
npm run typecheck
```

You need Node.js 24 or newer. To run the full app you need a Mac; run `./install.sh` from the repository root.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Create a branch from `main`.
3. Keep the change focused. Match the surrounding code style.
4. Add or update tests. Bug fixes should include a test that fails without the fix.
5. For UI changes, attach screenshots at 1440×900 and 1024×768 and follow `design/DESIGN-SYSTEM.md`.
6. Run `npm test` and `npm run typecheck` in `engine/` before opening the pull request.
7. Fill in the pull request template.

## Adding a skill

Skills live in `skills/<name>/SKILL.md`. A skill must declare its inputs, required access, process, validation, output and approval boundaries. New skills are reviewed before they are added to `skills/REVIEWED.json` with their hash.

## Reporting bugs

Use the bug report template. Include your macOS version, chip, ClaudeBot commit, what you did, what you expected and what happened. Relevant lines from `~/.claudebot/logs/engine.log` help a lot. Remove anything personal first.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
