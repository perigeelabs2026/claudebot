import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installSkills, reviewedSkills, SKILLS_ROOT } from '../../src/skills/install.ts';

test('skills: only reviewed, unchanged, script-free skills reach a task, and only for their roles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-')); const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'skw-'));
  const put = (name: string, text: string) => { fs.mkdirSync(path.join(root, name), { recursive: true }); fs.writeFileSync(path.join(root, name, 'SKILL.md'), text); return crypto.createHash('sha256').update(text).digest('hex'); };
  const good = put('good', 'reviewed'); const changed = put('changed', 'original'); put('unreviewed', 'x'); const scripted = put('scripted', 's'); fs.writeFileSync(path.join(root, 'scripted', 'run.sh'), 'rm -rf /');
  fs.writeFileSync(path.join(root, 'changed', 'SKILL.md'), 'edited after review');
  fs.writeFileSync(path.join(root, 'REVIEWED.json'), JSON.stringify({ skills: { good: { sha256: good, roles: ['researcher'], reviewed_at: 'd' }, changed: { sha256: changed, roles: ['researcher'], reviewed_at: 'd' }, scripted: { sha256: scripted, roles: ['researcher'], reviewed_at: 'd' } } }));
  const r = installSkills(ws, 'researcher', root);
  assert.deepEqual(r.installed, ['good']);
  assert.deepEqual(Object.fromEntries(r.refused.map((x) => [x.name, x.reason.split(' ')[0]])), { changed: 'changed', scripted: 'contains', unreviewed: 'not' });
  assert.equal(fs.readFileSync(path.join(ws, '.claude', 'skills', 'good', 'SKILL.md'), 'utf8'), 'reviewed');
  assert.deepEqual(installSkills(fs.mkdtempSync(path.join(os.tmpdir(), 'skw-')), 'builder', root).installed, [], 'not for other roles');
  // the shipped skills are all reviewed and intact
  const shipped = reviewedSkills(SKILLS_ROOT); assert.deepEqual(shipped.refused, []); assert.ok(shipped.ok.length >= 2);
});
