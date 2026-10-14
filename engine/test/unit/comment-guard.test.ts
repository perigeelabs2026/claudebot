// Regression guard (Phase 4 verifier): a one-line edit put the group-context push inside a // comment, so group members silently lost recent messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const stripLineComments = (src: string) => src.split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

test('the worker still gives group members the messages since they last spoke (not swallowed by a comment)', () => {
  const src = stripLineComments(fs.readFileSync(path.join(import.meta.dirname, '../../src/worker/run.ts'), 'utf8'));
  assert.match(src, /if \(others\) parts\.push\(`Messages in the group since you last spoke/);
  assert.match(src, /if \(isLead\)/, 'the lead still gets the pending-decisions block');
});

test('streamed text glued across a tool call is split into paragraphs; dotted names are kept', async () => {
  const { splitRunOn } = await import('../../src/runtime/claude-acp.ts');
  assert.equal(splitRunOn('check the quotes myself.Draft v2 fails review.'), 'check the quotes myself.\n\nDraft v2 fails review.');
  assert.equal(splitRunOn('endpoint instead.I saved the note.'), 'endpoint instead.\n\nI saved the note.');
  for (const keep of ['see changelog.v2.1 now', 'open README.md first', 'Node.js and e.g. this', 'It is done. Next step', 'claudebot-one-page-summary.md is saved', 'see file.JSON now']) assert.equal(splitRunOn(keep), keep);
});

test('mid-turn notes that arrive as separate text blocks never open the reply (rehearsal: "Too verbose; extract just the static text.")', async () => {
  const { extractTextForTest: x } = await import('../../src/runtime/claude-acp.ts');
  const answer = "Here's what I got from ramp.com, which I read in the browser (https://ramp.com/). " + 'Ramp sells corporate cards, bill pay and spend management. '.repeat(6);
  assert.equal(x([{ type: 'text', text: 'Too verbose; extract just the static text.' }, { type: 'text', text: 'Truncated JSON; use regex.' }, { type: 'text', text: answer }]), answer);
  const list = 'I found three roles:\n1. Digi International, Sr Channel Account Manager (https://example.com/1)\n2. Pax8 (https://example.com/2)\n3. ASUS (https://example.com/3)';
  assert.equal(x([{ type: 'text', text: 'Searching now.' }, { type: 'text', text: list }, { type: 'text', text: 'Saved the file too.' }]), `${list}\n\nSaved the file too.`);
  assert.equal(x([{ type: 'text', text: 'Plain answer.' }]), 'Plain answer.');
  assert.equal(x([{ type: 'text', text: 'narration' }, { type: 'tool_use' }, { type: 'text', text: 'The answer.' }]), 'The answer.');
});
