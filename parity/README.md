# Parity certification pack

Runs each case twice: natively (`claude -p` in the product's config dir) and through ClaudeBot (a `research.market_scan` style job whose claude stage carries the same prompt), then compares. It needs the owner login in `~/.claudebot/claude`; without it every case is reported as `HUMAN_CHECK_REQUIRED` with the exact command.

Dimensions compared per case: answer completeness (rubric keywords), tool availability (which tools the harness advertises), context retention (second turn references the first), skills/instructions (settings and CLAUDE.md loaded), browser capability (broker `browser_read`), session resume (second turn on the same session), long-job continuation (checkpoint after a turn), restart recovery (engine restart between turns), approval behavior (request_approval produced, nothing sent), usage/limit behavior (limit classification), final artifact integrity (sha256 of the written file matches the artifact record).

Run: `./parity/run.sh` → writes `parity/report.md`.
