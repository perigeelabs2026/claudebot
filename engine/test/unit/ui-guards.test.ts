// Regression guards for owner-reported UI defects (2026-10-13 14:00Z): dead dashed group tile, misplaced rail tooltip,
// clipped menus and rail, a deleted conversation opening "Not found", invented settings and developer status pills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const ui = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '../../ui', f), 'utf8');

test('no dashed outlines anywhere in the stylesheets (dashed is reserved for an active drag, and nothing drags yet)', () => {
  for (const f of ['styles.css', 'theme.css', 'tokens.css']) assert.doesNotMatch(ui(f), /dashed/, f);
});
test('rail tooltips are positioned beside their own button; rail buttons carry no native title tooltip', () => {
  const app = ui('app.js'); const rail = app.slice(app.indexOf('function renderRail'), app.indexOf('function renderNav'));
  assert.doesNotMatch(rail, /\btitle: /, 'native titles drift to the pointer');
  assert.match(app, /railTip\.style\.left = `\$\{r\.right \+ 8\}px`; railTip\.style\.top = `\$\{r\.top \+ r\.height \/ 2\}px`/);
});
test('menus fit the window or scroll, and the rail bottom controls never get cut off', () => {
  const css = ui('theme.css');
  assert.match(css, /\.rail-menu \{ max-height: calc\(100vh - 24px\); overflow-y: auto;/);
  assert.match(css, /\.ctx-menu \{ max-height: calc\(100vh - 8px\); overflow-y: auto;/);
  assert.match(css, /\.rail-top \{ flex: 1 1 auto; overflow-y: auto;/); assert.match(css, /\.rail-bottom \{ flex: none; \}/);
  assert.doesNotMatch(css, /\.rail-top \{ overflow: visible; \}/);
});
test('a deleted conversation falls back to Home, never to a Not found page', () => {
  const app = ui('app.js'); assert.doesNotMatch(app, /does not exist \(any more\)/); assert.match(app, /location\.replace\('#home'\)/);
});
test('Settings and the More menu hold only the core screens; no developer status pills', () => {
  const app = ui('app.js'); const settings = app.slice(app.indexOf('  async settings() {'), app.indexOf('  async workflow(id)'));
  for (const gone of ['How much runs at once', 'Types of work', "h('h3', {}, 'Product')", 'worker_limit']) assert.ok(!settings.includes(gone), gone);
  assert.match(settings, /permCard, tgCard\)/);
  assert.match(app, /const MENU = \[\['artifacts', 'Results'\], \['agents', 'Assistants'\], \['automations', 'Routines'\], \['browser', 'Browser'\], \['settings', 'Settings'\]\];/);
  const pills = app.slice(app.indexOf('function renderPills'), app.indexOf('async function refreshChrome'));
  assert.doesNotMatch(pills, /Queue|Workers|Connections/); assert.match(pills, /not reachable right now/);
});
test('the rail drops conversations deleted elsewhere (focus and a 30 s re-check)', () => {
  const app = ui('app.js'); assert.match(app, /addEventListener\('focus', syncConvs\); setInterval\(syncConvs, 30000\);/);
});
test('screen help lines describe what is on the screen (no removed controls)', () => {
  const app = ui('app.js'); assert.doesNotMatch(app, /Limits and work types/);
});
test('polish guards: send and save stay disabled while empty; Start group needs 2; the stop hint shows only while running; no debug port in the browser status', () => {
  const app = ui('app.js');
  assert.match(app, /const syncSend = \(\) => \{ sendBtn\.disabled = !ta\.value\.trim\(\); \}/);
  assert.match(app, /class: 'btn2 primary tg-save', disabled: true/);
  assert.match(app, /go\.disabled = picked\.size < 2;/);
  assert.match(app, /liveHere \? \[h\('span', \{\}, `\$\{agent\.name\} keeps working while you chat`\)/);
  const live = fs.readFileSync(path.join(import.meta.dirname, '../../src/browser/live.ts'), 'utf8'); assert.doesNotMatch(live, /DevTools on/);
  assert.match(app, /const byRail = /); assert.match(app, /'Built-in'/); assert.doesNotMatch(app, /'built in'/);
});
test('empty slots never print "null": replaceChildren/append/prepend skip them', () => {
  assert.match(ui('app.js'), /for \(const fn of \['replaceChildren', 'append', 'prepend'\]\)/);
});
test('sweep 3 guards: report job is not assistant work; tooltips avoid page text; one pill style; create draft button needs text; one browser empty state', () => {
  const app = ui('app.js'); const wb = fs.readFileSync(path.join(import.meta.dirname, '../../src/model/workbench.ts'), 'utf8'); const srv = fs.readFileSync(path.join(import.meta.dirname, '../../src/api/server.ts'), 'utf8');
  assert.match(wb, /NOT_WORK = new Set\(\['report\.morning', 'priority\.rank', 'owner\.upload'\]\)/); assert.match(srv, /kind NOT IN \('report\.morning','priority\.rank','owner\.upload'\)/);
  assert.match(app, /function placeTip\(tip, r\)/); assert.match(app, /`Finished: \$\{lr\.title\}/); assert.doesNotMatch(app, /charAt\(0\)\.toLowerCase\(\)/);
  assert.match(app, /class: `tag crew-tag /);
  assert.match(app, /class: 'btn2 primary draft-go', disabled:/); assert.match(app, /browser-empty-page/);
  assert.doesNotMatch(app, /summarise/);
});
test('sweep 4 guards: one pill class on Home; no usage panel on Create; short status text never cut; descriptions kept at narrow widths', () => {
  const app = ui('app.js'); const css = ui('theme.css');
  assert.match(app, /class: `tag crew-tag /); assert.doesNotMatch(app, /'Usage estimate'/);
  assert.match(css, /\.office-row \.now \{ white-space: normal;/); assert.doesNotMatch(css, /\.member-row:not\(\.draft-row\) \.now \{ display: none; \}/);
  assert.match(app, /`· \$\{lead\?\.role \|\| 'Leads the team'\} · \$\{d\.figures\.working \? 'Working' : 'Idle'\}`/);   /* Name · Role · Status */
});
test('sweep 5 guards: Home lede comes from the work record, not the model; rewritten reports say updated; rename now on every assistant', () => {
  const app = ui('app.js'); const rep = fs.readFileSync(path.join(import.meta.dirname, '../../src/cos/report.ts'), 'utf8');
  assert.match(app, /h\('p', \{ class: 'lede' \}, lede\)\)/); assert.doesNotMatch(app, /report \? report\.lede : lede/);
  assert.match(app, /`updated \$\{fmtClock\(report\.written_at\)\} by `/); assert.match(rep, /first_written_at/);
  /* superseded 17:15Z: the owner wants Rename on every assistant, built-ins included (see the assistants guard below) */ assert.doesNotMatch(app, /No one is working on anything/);
});
test('sweep 6 guards: the Home team fits above the composer at 1024 (one line per member, tight rows); the stamp never wraps; one label/value colour', () => {
  const css = ui('theme.css'); const app = ui('app.js');
  assert.match(css, /\.crew-row \{ grid-template-columns: 16px 112px minmax\(0, 1fr\) auto;/); assert.match(css, /@media \(max-width: 1180px\) \{ \.crew-row \{ padding: 7px 0; \}/);
  assert.match(css, /\.kicker \{ flex-wrap: nowrap; white-space: nowrap; overflow: hidden; \}/);
  assert.match(css, /\.card \.kv dd, \.card \.kv dd \.muted \{ color: var\(--text-2\); \}/);
  assert.match(app, /'tasks finished'/); assert.doesNotMatch(app, /first written \$\{fmtClock/);
  // Measured in the browser at 1024x768 (15:59Z): last team row bottom 600px, composer top 649px.
});
test('sweep 7 guards: More is tinted, not active, while open; routines say what the last run produced; one approval wording', () => {
  const app = ui('app.js'); const srv = fs.readFileSync(path.join(import.meta.dirname, '../../src/api/server.ts'), 'utf8');
  assert.match(app, /\$\{railMenuOpen \? 'menu-open' : ''\}/); assert.match(srv, /last_job: db\.prepare\('SELECT id, kind, state, outcome, completed_at FROM jobs WHERE schedule_id = \?/);
  assert.match(app, /"Wrote today's report"/); assert.doesNotMatch(app, /send, publish, purchase, delete or production change/); assert.doesNotMatch(app, /for your review\./);
});
test('nested child arrays render as elements, never as their text (h flattens fully); scroll cue is an overlay, not a mask', () => {
  assert.match(ui('app.js'), /children\.flat\(Infinity\)/); assert.match(ui('theme.css'), /\.scroll-cue \{ position: fixed;/);
});
test('sweep 8 guards: the scroll cue is a fixed overlay pinned to the viewport bottom; consistent approval and sign-in wording', () => {
  const app = ui('app.js'); const core = fs.readFileSync(path.join(import.meta.dirname, '../../src/templates/core.ts'), 'utf8');
  assert.match(app, /top: `\$\{r\.top \+ el\.clientHeight - 56\}px`/); assert.doesNotMatch(ui('theme.css'), /has-more::after/);
  assert.match(app, /'None yet\. Every send, publish, buy or delete asks you\.'/); assert.match(core, /never signs in for you/); assert.doesNotMatch(core, /signs in without your approval/);
});
test('final polish guards: one disabled style; roles describe the job; New group says "at least 2" once', () => {
  const css = ui('theme.css'); const app = ui('app.js'); const defs = fs.readFileSync(path.join(import.meta.dirname, '../../src/model/definitions.ts'), 'utf8');
  assert.match(css, /button:disabled, \.btn:disabled, \.btn2:disabled, \.btn2\.primary:disabled, \.composer2 \.send:disabled \{ opacity: 1;/);
  assert.match(defs, /'Finds and checks sources'/); assert.match(defs, /'Drafts documents and code'/); assert.match(defs, /"Checks work before it's accepted"/); assert.match(defs, /'Uses web pages for you'/);
  assert.match(app, /'Pick assistants\.'/); assert.doesNotMatch(app, /\(at least 2\)/);
});
test('Create Team roles are never cut; group tooltip plain; disabled inspect says why', () => {
  assert.match(ui('theme.css'), /\.ctx-section \.member-row \.now \{ white-space: normal; overflow: visible;/);
  const app = ui('app.js'); assert.match(app, /btn\('#newgroup', 'Start a group',/); assert.match(app, /'Inspect current work · Nothing running'/);
});
test('next routine says today/tomorrow; one pick asks for one more', () => {
  const app = ui('app.js'); assert.match(app, /diff === 1 \? `tomorrow \$\{time\}`/); assert.match(app, /'1 picked\. Pick one more\.'/);
});
test('assistants are the owner\'s: built-ins editable, Rename in place on right-click, plain editor without ids or tool ids up front', () => {
  const app = ui('app.js'); const defs = fs.readFileSync(path.join(import.meta.dirname, '../../src/model/definitions.ts'), 'utf8');
  assert.match(defs, /UPDATE agent_definitions SET name = \?, purpose = \?, system_instructions = \?/); assert.doesNotMatch(app, /protected fields are read-only/);
  assert.match(app, /\{ label: 'Rename', run: \(\) => \{ const r = lastMenuTarget\?\.getBoundingClientRect\(\); renameInPlace\(id,/); assert.match(app, /'Enter to save · Esc to cancel'/);
  const editor = app.slice(app.indexOf('async function agentEditor'), app.indexOf('async function refreshAssistants'));
  assert.doesNotMatch(editor, /field\('Id/); assert.doesNotMatch(editor, /Tasks at once/); assert.match(editor, /'Web search'/); assert.match(editor, /h\('summary', \{\}, 'Advanced'\)/);
  assert.match(app, /'data-agent': a\.id \}, h\('div', \{\}, h\('div', \{ class: 'title' \}/);
});
test('editor: Save disabled until a field changes; rename field anchored to the right-clicked item', () => {
  const app = ui('app.js'); assert.match(app, /const saveBtn = h\('button', \{ class: 'btn2 primary', onclick: save, disabled: a \? true : null \}, 'Save'\)/); assert.match(app, /lastMenuTarget\?\.getBoundingClientRect\(\)/);
});
test('live updates never rebuild a form being edited (owner report 19:46Z: the assistant editor wiped typing)', () => {
  const app = ui('app.js');
  assert.match(app, /function editingForm\(\)/); assert.match(app, /function refreshCurrent\(\) \{ const cur = location\.hash\.replace\('#', ''\)\.split\('\/'\)\[0\] \|\| 'home'; if \(editingForm\(\)\) \{ renderRail\(\); return; \}/);
  assert.match(app, /if \(editingForm\(\)\) \{ renderRail\(\); return; \} const typing =/); assert.match(app, /v\.dataset\.dirty = changed \? '1' : ''/);
  // Behavioural guard against the live app: test/live/typing-survives-refresh.mjs (types, fires real engine events, checks text and focus). Last run 19:5xZ: all kept.
});
test('every form is guarded: dirty recomputed from starting values; step edits mark it; cleared on every route', () => {
  const app = ui('app.js');
  assert.match(app, /function recomputeDirty\(\)/); assert.match(app, /v\.dataset\.formDirty === '1'/);
  assert.match(app, /\$\('#view'\)\.dataset\.dirty = ''; \$\('#view'\)\.dataset\.formDirty = ''; try \{ const el = await view\.call\(views, arg\);/);
  assert.match(app, /stages\.splice\(i, 1\); \$\('#view'\)\.dataset\.dirty = '1';/);
});
test('the "No one was mentioned…" line is explained once per conversation', () => {
  assert.match(ui('app.js'), /explained once per conversation, not under every message/);
});
test('approval actions are a top-level function: every renderer can call actionRow (owner crash 21:20Z: "Can\'t find variable: actionRow")', () => {
  const app = ui('app.js'); const a = app.indexOf('\nfunction actionRow(m) {'); const m = app.indexOf('\nfunction messageEl(m, d) {');
  assert.ok(a > 0 && m > a, 'actionRow is declared at top level, before messageEl (it was nested inside messageEl, out of reach of the chat renderer)');
  assert.ok(app.slice(a, m).trimEnd().endsWith('\n}'), 'actionRow closes before messageEl starts');
});

test('no screen depends on `this` (owner crash 21:34Z on Needs your review: "undefined is not an object (evaluating \'this.approvalsList\')")', () => {
  const app = ui('app.js');
  assert.deepEqual(app.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\bthis\./.test(String(l))).map(([n]) => n), [], 'views are called as plain functions by the router; refer to views.x, never this.x');
  assert.match(app, /await view\.call\(views, arg\)/, 'the router still binds views, as a second guard');
});

test('approval cards say what will actually run: "Send email" only for a real email; browser actions read as browser actions; Always allow only for emails; no Allow when an email has no text', () => {
  const app = ui('app.js');
  assert.equal((app.match(/'Send email'/g) || []).length, 1, 'one place decides the email label');
  assert.match(app, /label: email \? 'Send email' :/);
  assert.match(app, /\/\\bapply\\b\/i\.test\(el\) \? 'Open apply link'/);
  assert.match(app, /const blockAllow = pending && dv\.missingBody/);
  assert.match(app, /!dv\.email \? null : h\('button', \{ class: 'btn2', title: `Allow/);
  const css = ui('theme.css'); assert.match(css, /\.card2\.approval, \.card2\.approval \* \{ overflow-wrap: anywhere;/);
});

test('a file an assistant saved renders as a file card, not as a text bubble (owner: "I don\'t see any files")', () => {
  const app = ui('app.js'); assert.match(app, /if \(m\.role === 'assistant' && !\(m\.kind === 'result' && m\.artifact\)\) \{/);
  assert.ok(app.indexOf("if (m.role === 'assistant' && !(m.kind === 'result' && m.artifact))") < app.indexOf("if (m.kind === 'result' && m.artifact) {   // a saved file"));
});

test('when the browser lives in the assistants\' computer, the browser pane shows its live screen with Take over, never the Mac-window buttons (owner: "your open window button doesn\'t work")', () => {
  const app = ui('app.js');
  assert.match(app, /if \(loc === 'computer'\) \{ const st = await api\('\/api\/browser'\)[^\n]*screenCard\(1, st\.live\?\.takeover\)/);
  assert.match(app, /computerLocation === 'computer' \? null : h\('button', \{ class: 'btn2', onclick: openBrowserWindow \}, 'Open window'\)/);
});
