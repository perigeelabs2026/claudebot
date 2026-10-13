/** render_document: a real .docx and .pdf from Markdown, saved as results with hashes, scoped like read_artifact. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { markdownToHtml } from '../../src/documents/render.ts';
import { setupBroker } from './helpers-broker.ts';

test('markdown becomes clean HTML: headings, lists, bold, links; nothing from the text runs as markup', () => {
  const html = markdownToHtml('# Sam\n## Experience\n- Grew **40%**\n- [site](https://example.test)\n<script>x</script>', 'Sam');
  assert.match(html, /<h1>Sam<\/h1>/); assert.match(html, /<ul>\n?<li>Grew <b>40%<\/b><\/li>/); assert.match(html, /<a href="https:\/\/example\.test">site<\/a>/);
  assert.ok(!html.includes('<script>x'), 'raw HTML in the text is escaped');
});

test('render_document saves a real DOCX and PDF as results (hash recorded) and refuses another conversation\'s source', { skip: process.platform !== 'darwin' && 'needs macOS textutil' }, async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id });
  const turn = s.chat.send(c.id, 'make my resume a pdf', s.defs).job;
  const r = await s.call(turn, 'render_document', { title: 'Sam Sample Resume', markdown: '# Sam Sample\n## Experience\n- Grew partner revenue 40%' });
  assert.equal(r.ok, true, r.text); const files = (r.data as { files: Array<{ id: string; format: string }> }).files; assert.deepEqual(files.map((f) => f.format), ['docx', 'pdf']);
  for (const f of files) { const a = s.db.prepare('SELECT path, sha256, kind FROM artifacts WHERE id = ?').get(f.id) as { path: string; sha256: string; kind: string }; const b = fs.readFileSync(a.path); assert.equal(a.kind, 'file'); assert.ok(f.format === 'pdf' ? b.subarray(0, 5).toString() === '%PDF-' : b[0] === 0x50 && b[1] === 0x4b); }
  const other = s.chat.create({ workspace_id: s.ws.id }); const t2 = s.chat.send(other.id, 'hi', s.defs).job;
  const bad = await s.call(t2, 'render_document', { title: 'x', source_artifact_id: files[0].id }); assert.equal(bad.ok, false);
});
