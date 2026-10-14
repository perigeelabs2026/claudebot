# Changelog

Fixes and improvements to ClaudeBot, newest first. Update with `claudebot update` (or run the install line again).

## 2026-10-13

### Usage
- **Much lower Claude usage.** Claude Code's own subagents are now turned off for ClaudeBot. They were silently running extra Opus sessions in parallel and used most of the plan.
- Each assistant runs on its own model: the Chief of Staff on Haiku (fast replies), the Researcher on Opus, everyone else on Sonnet. Change it in Edit assistant › Advanced › Model.
- At most 3 assistants work at the same time by default.
- Existing installs: run `claudebot update` to pick up these settings.

### Added
- Assistants keep a daily Work log in their memory note, rebuilt every night from what they actually did (no model call). The last 3 days are in every prompt.
- `node engine/src/ops/certify-cli.ts` gives a read-only go/no-go based on the last hours of real, non-test work.
- All work shows up in the team group chat: direct and Telegram chats are mirrored there, and background progress is posted there too.
- Fable 5.1 can be chosen as an assistant's model. Opt-in setting `replan_model` (or `CLAUDEBOT_REPLAN_MODEL`) makes the lead re-plan on that model when work comes back blocked. Defaults are unchanged.
- `lookup_answer`: assistants check your answer bank (bullet lines in `Owner.md` / `Owner/*.md` in your memory folder) before asking you a form question.
- Assistants can read the full record of a chat they belong to (the lead can read any), instead of asking you to export it.
- Assistants remember their other conversations: each turn sees recent messages from your other chats with them (a direct chat knows what went wrong in the group chat).
- Your Mac stays awake while assistants have work, and can sleep again when they are idle.
- In the private computer each assistant works in its own browser window on its own screen (3 screens, one shared sign-in). The Browser page shows All screens; a chat's browser pane shows that assistant's screen.
- Dry-run projects: set the project policy `dry_run` and assistants fill in and attach everything but never press the final submit, whatever permission is on. Off by default.
- The lead can make a task that has not started wait for other tasks (for example, applications wait for the tailored resumes). Background browser tasks can record verified applications too.
- Telegram quiet hours: notices are held while `telegram.quiet_until` is set, and projects with Telegram turned off in their policies never send.
- Assistants can know your name (Settings key `owner_name`, unset by default): work is made for you, and "Chief, …" reads as you talking to the Chief of Staff.
- **Assistants keep going until the goal is done.** An assistant can schedule its next round on the same goal (up to 6 per request). After a failed round it must try a different approach, and it checks its own result before stopping.
- **Team skills.** Assistants save what they learn about a site to `Skills/<site>.md` in the memory vault, and every turn reads the skills for the sites in play.
- **Verified job applications.** An application counts as submitted only when the site's confirmation page shows it: ClaudeBot saves a receipt screenshot and a verified record, and anything else is reported as "NOT submitted". A reply that claims a submission without one is flagged.
- In the private computer, all assistants share a team folder (`./shared`) and get a real shell.
- The lead can switch an assistant back on when you ask, from chat or Telegram.
- **Watch the private computer live, and take over.** The Computer card shows the assistants' screens live. Screens are view-only by default; **Take over** gives you the mouse and keyboard on that screen and pauses the assistants' browser, and **Hand back** returns it. When assistants run in the private computer, their browser runs there too (on screen 1), with uploads and downloads handed in and out. Opt-in; the default Mac setup is unchanged.
- **Assistants can work inside the private computer (opt-in).** In More › Browser › Computer, press **Run assistants here** to run their Claude turns inside the VM instead of on your Mac; each task folder is copied in and back, and the VM gets only that task's permissions. **Run on my Mac instead** switches back. New installs keep running on your Mac and never need Lima.
- **Submit job applications without asking (off by default).** Turn it on in More › Settings › Standing permissions, or ask the lead in your own words. It covers Apply/Next/Submit on job sites and applicant-tracking forms (Greenhouse, Lever, Ashby, Workday, LinkedIn Jobs, career pages); every submission is recorded. Emails, LinkedIn messages, purchases, posts, deletions, passwords, codes, CAPTCHAs and payments still ask you.
- Assistants can attach saved results (like a resume or cover letter) to application forms. Apply links count as navigation and attaching a file counts as preparation.
- **Private computer for the assistants (optional).** A private Linux VM on your Mac via Lima, with a browser and two screens, no shared folders, and reachable only from your Mac. `claudebot computer up|down|status|snapshot|reset|update`, plus a Computer card in More › Browser (Update, Reset to snapshot, Start/Recover). Nightly snapshots when idle and before every update. Needs `brew install lima` on an Apple silicon Mac; see the README.
- **Assistants keep improving.** Memory lives in a Markdown vault you can open in Obsidian (`~/Documents/ClaudeBot Memory`): a Team note, an Owner note, one note per assistant and daily Lessons. Every reply reads them in full; assistants remember your preferences and corrections, and forget things when you ask. Edit an assistant's memory in Edit assistant › Memory, or open it in Obsidian. Secrets are refused.
- **Telegram is a full command channel.** Decisions arrive with Allow once / Deny buttons and show exactly what will run (including the full email). Deciding in the app or on Telegram closes the other side. New commands: /help, /status, /stop <n>, /approvals. Only the lead posts on Telegram, files arrive as documents, and other chats are refused.
- Create and rename groups: right-click a group to rename it, and edit its name, purpose and members in the Members tab. Every member reads the group's purpose. The lead can create and edit groups when you ask.
- Paste images with ⌘V, drag and drop files, and attach several at once. PDFs, Word documents and images up to 10 MB are accepted, with thumbnails and PDF previews.
- Assistants can turn their writing into real Word (.docx) and PDF documents.
- Export a whole conversation from the conversation menu or with the `/export` command.
- Call assistants by first name in a group, or start a message with their name, and it goes to them.
- Assistants can post short progress updates and share files in the chat while they work. When you ask, the lead can rename or turn off an assistant, or add or remove group members.
- Ask for a new assistant in chat or Telegram and it is created right away: your message is the confirmation (up to 5 a day).
- Assistants can open zip and tar archives you give them: files are extracted into a new folder inside the task. Links, paths that escape the folder, and oversized archives are refused. Documents and PDFs also get text copies the assistants can read.

### Fixed
- Status comes from the work record: the lead's prompt carries the live task count, the running count and the verified applications, all from the same queries as the morning report. A reply that states a different count ("nothing is running" while nine tasks run) gets a check note with the real numbers. The honesty check now covers more than "submitted": a claim of sent, verified, account created or signed in with no matching record also gets a check note.
- Assistants set new account passwords themselves: `set_account_password` generates a strong password and keeps it in the macOS Keychain (a 0600 file off macOS), and `browser_act` `fill_secret` types it into the password field. The value is never returned to the assistant or written to an event, log or chat; asking the owner for a new account password is sent back to the team.
- A task re-queued because the answer bank answers its blocker (or it is an essay) now sees that answer: its prompt carries a labelled system note with the saved answers, or the instruction to draft from the resume and memory, so it does not block again the same way.
- A task that gets stuck on something your saved answers already cover, or on an essay, goes back to the assistant once with the answer (or with "draft it from the resume and memory"). The team group shows it, and Telegram stays quiet. If it gets stuck again, you hear about it.
- Essay and free-text questions ("Why do you want to join?", "Tell us about yourself") are drafted by the team from your resume and memory, never sent to you. A quota, salary or work-authorization question reaches you only when your answer bank doesn't already have it. Passwords, codes, CAPTCHAs and payments still come to you.
- On a checkout page (card fields, or a Place order / Pay now / Complete purchase button; not a site-wide Donate or Upgrade link), a plain Confirm, Continue, Submit or Enter still asks you first, because there it is the payment.
- **Far fewer approval cards.** In the browser, only four kinds of action wait for you: a message to a person (Send, Connect, InMail, Reply), spending money (Buy, Pay, Place order), a public post (Post, Publish, Comment) and a delete. Apply, Submit, Next, Accept, Agree, Sign up, Register, Upload, Continue and Create account just happen and are recorded. Enter in a form whose button buys or deletes still asks. Dry-run projects still stop before the final submit. One table (`engine/src/approvals/allowlist.ts`) drives the browser, the Telegram cards and the "Needs you" list.
- The lead no longer refuses work it queued itself from your instructions as "automatic" and asks you again. Automatic reports and event triggers still cannot start work.
- Assistants stop asking "should I…?" about work the team can do themselves: the reply goes back to the assistant to do it, and the question is not pushed to Telegram. Questions about sending, spending, posting or deleting, and requests for passwords, codes or personal answers, still reach you.
- An assistant can only report "blocked" after trying at least two other routes, unless the block is a CAPTCHA, MFA, a sign-in or a spend.
- Every delegated task (not only chat turns) gets the try-alternatives-first rule and `lookup_answer`. When a task in a conversation comes back blocked or partial, the lead's automatic report may start one follow-up task to try another route.
- Telegram now sends only replies to messages you wrote on Telegram, decision cards, verified application receipts and the morning line. Everything else stays in the app's team group.
- Telegram sends one plain line when an assistant hits something only you can clear (a sign-in or a CAPTCHA, including hCaptcha). These lines are held during quiet hours.
- The app window no longer looks frozen after the engine restarts, because every reconnect refreshes the whole view.
- A Telegram blocker line is skipped when your answer bank already has the answer. Only a labelled fact whose label matches the question counts (a work-history line that names the company does not), and generic labels such as Company, Role, Name or Email never count as a match.
- The stuck-reply check ignores negated, "would"/"could" and question sentences when looking for a route that was tried.
- Recent-conversation timestamps shown to assistants use your Mac's time zone (they were fixed to Arizona time).
- A verified application now posts its "Applied:" receipt in the team group.
- The stuck-reply check now needs a route that was actually tried and named, and a sign-in or CAPTCHA mention only excuses its own sentence.
- Replies that say something "stays unsent" or "could not be verified" without listing other routes tried go back to the assistant to try other people and sources.
- Answers and work history the team saves in the private computer (`shared/profile`, `shared/resumes/master`) are copied into your memory folder every 10 minutes, so `lookup_answer` sees them.
- Work mirrored into the team group now shows in group context and transcripts, and a failed reply shows a plain status instead of a raw error line.
- The application-answers template now says that a blank line means "answer from the resume or skip", never "ask the owner".
- Assistants try other people, sources and routes before reporting they are stuck, and list what they tried. Form questions are answered from your resume, memory and a new `shared/profile/application-answers.md` in the private computer (an empty template you fill in once). Reports that hand you answers the team can find are sent back to the assistant.
- With "Submit job applications without asking" turned on, every field, dropdown and key press inside an application form on a job site is covered, so no more approval cards mid-application. The permission is still off until you turn it on.
- Telegram decision cards are one plain sentence (the email itself for emails), without page address, fingerprint or expiry; the lead's messages arrive as plain text, and link previews are off.
- Plain progress words everywhere ("Working on this step", "Using the browser"); ClaudeBot's instruction notes fold into one line; statuses read the same in every view; Members fits at 1024 px and the lead cannot be removed.
- Verified applications also recognise a thank-you shown inside an embedded application frame.
- A turn resumed after a restart carries on instead of stopping to ask you.
- The morning report is built from live tasks and verified applications, and "Needs you" only lists what truly needs you (passwords, codes, CAPTCHAs, personal answers, spending, approvals). Things the team can fix itself are listed separately.
- A note sent to a turned-off assistant waits and is delivered when it is turned back on.
- Office desk labels stay in their own column and say "Working"; Members shows the same live status as the Office; the header says "N waiting on a teammate".
- The message box is one centred row.
- Accepting or rejecting a result returns to Results, and a decided result no longer shows the buttons.
- Right-clicking the sidebar offers New assistant and New group chat.
- When Telegram quiet hours end, you get one good-morning summary plus the decision cards still waiting, with their buttons (held cards were never sent before). Notices from test projects are labelled as test instead of held.
- Assistants' replies no longer start with their mid-turn notes.
- Windows land on the right screen when two assistants open one at once, and the first browse after a computer restart opens the assistant's own window.
- A file that attached correctly is no longer reported as failed when the form re-renders and shows it by name (Greenhouse).
- No false "signed out" alarms from the private computer: a sign-in failure is re-checked against Claude's real sign-in there and retried if you are still signed in.
- The honesty check flags only real submission claims ("I submitted…") and accepts honest negatives ("nothing was applied for") and a teammate's verified submit.
- In the private computer, uploads reach the site (the browser's private /tmp could not read staged files), and the browser keeps track of the task's own tab.
- Upload results say plainly that the page holds the file.
- Work goes to the assistant you named: the lead hands each part to exactly that assistant (by name or first name), and an unknown or switched-off assistant is refused instead of the work silently going to someone else.
- File uploads really attach: ClaudeBot sets the file field directly, falls back to the file chooser, and only reports success when the page holds the file.
- Pages that time out the page reader fall back to the accessibility tree.
- Submits covered by "Submit job applications without asking" no longer post a decision card.
- Allowing a browser step no longer gets lost when the page reopens blank: the assistant carries on in the same tab, on the same filled form.
- Assistants know which standing permissions are already on, so they stop asking you to switch on one that is.
- In a chat's Browser tab, when assistants work in the private computer, you see its live screen with Take over / Hand back instead of window buttons that had nothing to open.
- Files saved by assistants now show as file cards in the chat instead of plain lines.
- Avatar initials follow the assistant's current name everywhere and update live.
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
