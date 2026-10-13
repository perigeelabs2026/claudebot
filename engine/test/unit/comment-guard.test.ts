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
