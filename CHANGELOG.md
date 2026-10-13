# Changelog

Fixes and improvements to ClaudeBot, newest first. Update with `claudebot update` (or run the install line again).

## 2026-10-13

### Usage
- **Much lower Claude usage.** Claude Code's own subagents are now turned off for ClaudeBot. They were silently running extra Opus sessions in parallel and used most of the plan.
- Each assistant runs on its own model: the Chief of Staff on Haiku (fast replies), the Researcher on Opus, everyone else on Sonnet. Change it in Edit assistant › Advanced › Model.
- At most 3 assistants work at the same time by default.
- Existing installs: run `claudebot update` to pick up these settings.

### Added
- Paste images with ⌘V, drag and drop files, and attach several at once. PDFs, Word documents and images up to 10 MB are accepted, with thumbnails and PDF previews.
- Assistants can turn their writing into real Word (.docx) and PDF documents.
- Export a whole conversation from the conversation menu or with the `/export` command.
- Call assistants by first name in a group, or start a message with their name, and it goes to them.
- Assistants can post short progress updates and share files in the chat while they work. When you ask, the lead can rename or turn off an assistant, or add or remove group members.
- Ask for a new assistant in chat or Telegram and it is created right away: your message is the confirmation (up to 5 a day).
- Assistants can open zip and tar archives you give them: files are extracted into a new folder inside the task. Links, paths that escape the folder, and oversized archives are refused. Documents and PDFs also get text copies the assistants can read.

### Fixed
- Long messages are never cut off for assistants: they can read the rest on demand.
- Approved browser actions now actually happen: allowing a click or form step (in the app or Telegram) resumes the assistant once instead of the approval being used up by the outbox.
- Files an assistant saves while replying in chat now appear in the conversation as result cards.
- Changing the model of a built-in assistant now saves (it was silently ignored).
- "Needs your review" no longer crashes when opened.
- Approval cards say exactly what will run: browser actions show the page, the action and the address; only real emails are labelled "Send email" and offer Always allow; long text wraps, with a Details section.
- Voice stays off unless you start it. Replies are read aloud only during live voice, the app always opens in plain dictation, and live voice is never restored from a previous session.
- Pressing Send ends dictation, so late words no longer refill the message box.
- Blocked-task messages are written in plain words.
- Approval cards no longer crash after you decide ("Can't find variable: actionRow").
- Coding-task checks start correctly on macOS (the check sandbox failed to launch).

## 2026-10-13 — First public release
