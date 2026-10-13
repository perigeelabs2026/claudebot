// Safe archive extraction (owner request 2026-10-13): an assistant must open zip files the owner gives it, safely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeExtract, sourceAllowed } from '../../src/broker/archive.ts';
import { plainForOwner } from '../../src/model/wording.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
test('a zip extracts into a new empty folder in the workspace; documents get a readable text copy; a second extract gets its own folder', () => {
  const src = tmp(); fs.mkdirSync(path.join(src, 'records')); fs.writeFileSync(path.join(src, 'records', 'responses.md'), '# Responses\nAcme replied.'); fs.writeFileSync(path.join(src, 'notes.rtf'), '{\\rtf1 Hello notes}');
  const zip = path.join(tmp(), 'export-1-records.zip'); execFileSync('/usr/bin/zip', ['-qr', zip, '.'], { cwd: src });
  const ws = tmp(); const r = safeExtract(zip, ws);
  assert.equal(r.folder, 'extract-export-1-records'); assert.ok(r.files.some((f) => f.path.endsWith('records/responses.md')));
  assert.equal(fs.readFileSync(path.join(ws, 'extract-export-1-records', 'records', 'responses.md'), 'utf8'), '# Responses\nAcme replied.');
  const rtf = r.files.find((f) => f.path.endsWith('notes.rtf'))!; if (process.platform === 'darwin') assert.ok(rtf.text_copy && fs.readFileSync(path.join(ws, rtf.text_copy), 'utf8').includes('Hello notes'));
  assert.equal(safeExtract(zip, ws).folder, 'extract-export-1-records-2');
});
test('links and paths escaping the folder are refused; nothing outside the workspace is written', () => {
  const src = tmp(); fs.writeFileSync(path.join(src, 'a.txt'), 'x'); fs.symlinkSync('/etc/hosts', path.join(src, 'link'));
  const zip = path.join(tmp(), 'bad.zip'); execFileSync('/usr/bin/zip', ['-qry', zip, '.'], { cwd: src });
  assert.throws(() => safeExtract(zip, tmp()), /link/);
  const evil = path.join(tmp(), 'slip.zip'); const d = tmp(); fs.mkdirSync(path.join(d, 'x')); fs.writeFileSync(path.join(d, 'pwn.txt'), 'p');
  execFileSync('/usr/bin/zip', ['-q', evil, '../pwn.txt'], { cwd: path.join(d, 'x') });
  assert.throws(() => safeExtract(evil, tmp()), /outside its folder/);
});
test('only archives the owner gave can be opened: inside the task folder or a path the owner named', () => {
  assert.equal(sourceAllowed('/Users/x/Downloads/export-1-records.zip', '/ws', 'Sources: /Users/x/Downloads/export-1-records.zip (records)'), true);
  assert.equal(sourceAllowed('/Users/x/Downloads/other.zip', '/ws', 'Sources: /Users/x/Downloads/export-1-records.zip'), false);
  assert.equal(sourceAllowed('/ws/in/task.zip', '/ws', ''), true);
});
test('blocked text for the owner drops internal jargon', () => {
  const t = plainForOwner('Neither zip could be extracted. There is no shell, the allowlist (ls, wc -l, head, cat on text files) refused unzip, the Read tool won\'t open binary zips, and a sub-agent had no shell either. No contents were read, so handoff-index.md was not built rather than filled with made-up data.');
  assert.doesNotMatch(t, /shell|allowlist|Read tool|sub-agent/i); assert.match(t, /Neither zip could be extracted\./); assert.match(t, /not built rather than filled with made-up data/);
});
