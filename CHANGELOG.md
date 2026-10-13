# Changelog

Fixes and improvements to ClaudeBot, newest first. Update with `claudebot update` (or run the install line again).

## 2026-10-13

### Usage
- **Much lower Claude usage.** Claude Code's own subagents are now turned off for ClaudeBot. They were silently running extra Opus sessions in parallel and used most of the plan.
- Each assistant runs on its own model: the Chief of Staff on Haiku (fast replies), the Researcher on Opus, everyone else on Sonnet. Change it in Edit assistant › Advanced › Model.
- At most 3 assistants work at the same time by default.
- Existing installs: run `claudebot update` to pick up these settings.

### Added
- Ask for a new assistant in chat or Telegram and it is created right away: your message is the confirmation (up to 5 a day).
- Assistants can open zip and tar archives you give them: files are extracted into a new folder inside the task. Links, paths that escape the folder, and oversized archives are refused. Documents and PDFs also get text copies the assistants can read.

### Fixed
- Changing the model of a built-in assistant now saves (it was silently ignored).
- "Needs your review" no longer crashes when opened.
- Approval cards say exactly what will run: browser actions show the page, the action and the address; only real emails are labelled "Send email" and offer Always allow; long text wraps, with a Details section.
- Voice stays off unless you start it. Replies are read aloud only during live voice, the app always opens in plain dictation, and live voice is never restored from a previous session.
- Pressing Send ends dictation, so late words no longer refill the message box.
- Blocked-task messages are written in plain words.
- Approval cards no longer crash after you decide ("Can't find variable: actionRow").
- Coding-task checks start correctly on macOS (the check sandbox failed to launch).

## 2026-10-13 — First public release
