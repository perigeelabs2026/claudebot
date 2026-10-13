# ClaudeBot design system

Locked 2026-10-12 from design draft 1.1.
Every UI change from Phase 2 on is checked against this file. If a build needs something this file doesn't cover, add it here first and get it approved.

- Tokens: [`system/tokens.css`](system/tokens.css), the only place colors, type, spacing, radius and layout sizes are defined.
- Component styles: [`system/components.css`](system/components.css).
- Office renderer: [`system/office.js`](system/office.js) (canvas, no data of its own).

## 1. Principles
1. **Calm, dark, minimal.** One accent color. Hierarchy comes from type and spacing, not borders, shadows or color.
2. **ClaudeBot's own identity.** No Grok, xAI or other product branding, artwork, icons or copy.
3. **Truthful.** Every status, number, handoff and office animation comes from a real job, lease, heartbeat, approval or event. If a state is unknown or stale, the UI says "checking status" and never shows "working".
4. **Real data only.** Sample data is allowed only inside a throwaway mockup and is deleted when the design step ends. No fixtures, seed rows, placeholder names or demo cards ship. Empty states say plainly that nothing exists yet.
5. **Not "typical chatbot UI".** Avoid boxed dashboard tiles and checkbox lists for the morning report. Avoid grids of rounded cards for summaries; use editorial type, hairline rules and rows (see §5.1).

## 2. Tokens (summary; values in `tokens.css`)
| Group | Tokens | Use |
| --- | --- | --- |
| Surfaces | `--bg` frame, `--bg-rail` rail, `--surface-1` panes, `--surface-2` cards/composer, `--surface-3` hover/chips | Never add new greys; pick one of these |
| Lines | `--line` hairline, `--line-strong` emphasis | 1px only |
| Text | `--text`, `--text-2` secondary, `--text-3` meta | Body is `--text`; meta and labels are `--text-3` |
| Accent | `--accent` (periwinkle), `--accent-soft`, `--accent-ink` | Primary action, mentions, selection, focus ring. One primary button per view |
| States | `--ok` working/done, `--warn` needs you/paused/low power, `--danger` deny/expired/failed, each with a `-soft` background | Only for state, never decoration |
| Assistant identity | `--a-1` … `--a-6` | Assigned to assistants in creation order; used for avatar, mention tint and office sprite shirt |
| Type | `--font` Inter (system fallback), `--mono` JetBrains Mono; sizes `--fs-xs` 11 · `--fs-sm` 12.5 · `--fs-md` 14 · `--fs-lg` 16 · `--fs-xl` 20 · `--fs-2xl` 26 | Brief headline 34px/500 and figures 40px/300 are the only exceptions |
| Spacing | `--s1`…`--s8` on a 4px grid | No other values |
| Radius | `--r-sm` 6 buttons/inputs · `--r-md` 10 avatars/rows · `--r-lg` 14 cards/composer · `--r-pill` | Pixel elements (office, usage blocks, state squares) are square |
| Layout | `--rail-w` 64 · `--ctx-w` 44% (40% under 1180px) | |

Mono is used only for times, hashes, sizes and keyboard hints.

## 3. Layout
- **Frame:** a grid of rail plus main region at 100vh. The frame never scrolls; only the transcript and the context body scroll, each on its own.
- **Rail (left, 64px):** at the top, the lead assistant, then groups, a separator, then direct assistants. At the bottom: Create, Needs your review (with a count badge), Skills & connections, and the owner avatar for settings. The selected item has a `--surface-3` fill and a 3px left marker. A status dot shows working (`--ok`) or needs you (`--warn`), only from real state.
- **Main:** an optional full-width banner (low power, outages), then the workspace, then the composer.
- **Workspace:** chat pane (min 380px) · 6px splitter (drag or arrow keys) · context pane (`--ctx-w`, min 300px).
- **Identity pill:** floats at the top center of the chat pane and shows the avatar (or group mosaic), name, and a secondary line with role or state. A 56px fade sits behind it so text never collides with it. Clicking it opens details.
- **Context pane:** tabs at the top (Office, Task, Review, Browser, Files, Team, Members, depending on the conversation), then a scrolling body. Opening a context item never clears the chat draft or scroll position.
- **Composer:** fixed at the bottom of the main region, spanning chat and context, max 1100px centered. From left: attach, the textarea (`@` mentions, `/` skills), dictate, live voice, Send. While a reply is in progress Send becomes Stop. An optional reply bar above shows who is being replied to. A hint line below shows shortcuts or truthful status ("<assistant> keeps working while you chat").
- **Responsive:** under 1180px the context pane narrows to 40%, the brief figures shrink and team rows stack. Narrower still, the context pane collapses to a reversible tab or sheet before chat loses width.

## 4. Components
| Component | Rules |
| --- | --- |
| Avatar `.av` | 32px (`.sm` 22, `.xs` 16, `.lg` 40), `--r-md`, identity color fill, one or two initials. Group = 2×2 mosaic of member colors |
| Message `.msg` | Avatar, then meta (name 600, role `--text-3`, time `--fs-xs`), then text. The owner's messages are right-aligned in a `--surface-3` bubble. Max width 760px |
| Event line `.event` | Deterministic ledger events (routing, finished, started), indented to the text column, `--text-3`, a 6px dot. Never written as if a model said it |
| Mention `.mention` | `@Name` in `--accent` on `--accent-soft` |
| Quote (reply) `.quote` | 2px left rule, author name, excerpt |
| Reactions | Pill chips with emoji and count; the owner's own chips use the accent tint |
| Card `.card` | `--surface-2`, `--r-lg`, hairline border. Header row: label `--text-2` plus a state tag on the right. Used only for structured objects in a conversation: file, question, handoff, approval |
| File card | Type tile (36×44, mono label), name, mono meta (pages · size · version · short sha256), Preview / Download |
| Question card | Title plus single-choice rows (`.choice`, selected = accent border and soft fill), a primary answer button, and a ghost "Ask why" |
| Handoff card | From-avatar → to-avatar, the request in quotes, and a state tag (In progress / Delivered at time) |
| Approval card | Warn border while pending. Shows the exact action, target, short hash and expiry, with buttons **Allow once** (primary), **Always allow …** (scoped wording), **Deny** (danger). Expired = neutral border, danger tag, plain "Nothing was sent", **Retry**. Allowing always goes through the native Mac confirmation that shows the full content |
| Tag `.tag` | Pill, `--fs-xs`, `ok` / `warn` / `danger` / `accent` variants; working tags carry a pulse dot |
| Button `.btn` | 30px, `--r-sm`. Variants: default outline, `primary` (accent fill, one per view), `danger`, `ghost` |
| Task inspector | Header (avatar · "task" · live state with heartbeat age), title, key-value list (Asked, Expected, Doing now, Depends on, Next), then Add direction / Stop / Details, a preview section, and a mono-time timeline |
| Banner `.banner` | Full width above the workspace: warn tint, a short bold label, a meter, one sentence, one action, Dismiss. Secondary text hides under 1180px |
| Create assistant | Plain-words box, then a Chief of Staff draft card: portrait, **Name it** input (accent border, suggested tag), and a spec list (Job, Routine, Hands off to, Can use, Never without you as warn chips). Buttons: Create (primary), Try one run first, Change something. The context pane shows where the new assistant fits and a usage estimate |

## 5. Screens
### 5.1 Morning brief (home)
An editorial page, max 720px. No boxed tiles, no checkboxes.
1. **Kicker:** uppercase `--fs-xs`, items separated by "/": date · project/week · "written <time> by <lead avatar> Chief of Staff".
2. **Headline:** 34px/500, one sentence naming what matters most today.
3. **Lede:** `--fs-lg`, `--text-2`, two or three sentences on what happened overnight.
4. **Figures strip:** four columns between top and bottom hairlines, separated by vertical hairlines. The number is 40px/300 tabular, then the label and a delta (`--ok` when up). Usage shows as 10 square pixel blocks (accent; `--warn` from 90%).
5. **Today:** a vertical timeline with mono times on the left and square markers. The item that needs the owner is first, with a warn marker and an inline primary action. Done items are dimmed.
6. **The team:** one row per assistant between hairlines: identity pixel square, name and role, one sentence of real work, and a state word (working / needs you / paused / idle) with a square marker.
The context pane opens on the Office.

### 5.2 Conversation (1:1 and group)
Transcript plus cards (§4). Group conversations show a routing event when the coordinator picks who acts. The context pane opens on Task (1:1) or Office (group).

### 5.3 Review
Approval cards in the conversation where they were requested. The context pane shows the full detail: recipient, sender, subject, why, content hash, the exact text, and what "Always allow" would cover.

### 5.4 Low power
The banner shows from 90% usage. Paused assistants show "paused" everywhere (rail, brief, office) and their routines stop.

## 6. Office
- A side-view pixel world drawn on a 240×136 canvas scaled with `image-rendering: pixelated`: night sky, hills, grass and dirt layers, a two-floor wooden house, torches, and a ladder.
- Station types: `desk`, `table` (lead), `mailroom`, `library`, `stage`. Each assistant record names its station.
- States: **working** = gentle bob, typing hands and "…" dots (only with an active job, valid lease and fresh heartbeat). **waiting** = yellow "!" bubble. **idle/paused** = still.
- Below the canvas, an "In the office now" list shows avatar, name, the real current action and a state tag. Clicking a person or station opens the task inspector without losing the draft.
- With `prefers-reduced-motion` it draws a single frame.

## 7. Interaction and accessibility
- Visible focus ring (2px accent), keyboard reachable everywhere, the splitter adjustable with arrow keys.
- Accessible names on every icon button. The office canvas has a text label listing each assistant and state.
- Contrast: body text on `--surface-1` stays AA or better. Don't place `--text-3` on `--surface-3`.
- Drafts, selection, focus and scroll position survive navigation and live updates.
- Dictation fills the composer and never sends on a pause. Live voice is a separate mode with visible Listening / Transcribing / Thinking / Speaking states.

## 8. Review checklist (every UI change)

**Rule:** every UI change ships side-by-side screenshots at 1440×900 and 1024×768, and any visible mismatch with this system fails review.

- [ ] Uses only tokens from `tokens.css`; no new colors, sizes or radii.
- [ ] Layout rules in §3 hold at 1440×900 and 1024×768 (screenshots attached to the review).
- [ ] Every status, number and animation traces to real data; stale shows "checking status".
- [ ] No sample, fixture or placeholder data in the shipped tree.
- [ ] No boxed-tile dashboards or checkbox lists in summaries.
- [ ] Keyboard, focus, accessible names and reduced motion checked.
