# Changelog

Fixes and improvements to ClaudeBot, newest first. Update with `claudebot update` (or run the install line again).

## 2026-10-13

### Added
- Assistants can open zip and tar archives you give them: files are extracted into a new folder inside the task. Links, paths that escape the folder, and oversized archives are refused. Documents and PDFs also get text copies the assistants can read.

### Fixed
- Voice stays off unless you start it. Replies are read aloud only during live voice, the app always opens in plain dictation, and live voice is never restored from a previous session.
- Pressing Send ends dictation, so late words no longer refill the message box.
- Blocked-task messages are written in plain words.
- Approval cards no longer crash after you decide ("Can't find variable: actionRow").
- Coding-task checks start correctly on macOS (the check sandbox failed to launch).

## 2026-10-13 — First public release
