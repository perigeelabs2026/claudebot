/** Assistant memory in an Obsidian-compatible vault: layout, dedupe, cap, rename with links, secrets refused, read every turn. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, looksSecret } from '../../src/memory/vault.ts';
import { setupBroker } from './helpers-broker.ts';

const fresh = () => new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')));
const jude = { id: 'researcher', name: 'Jude (Job Applicator)' };

test('the vault has Team, Owner, Assistants/<Name>.md and daily Lessons; lines are deduplicated and capped at 40 per section', () => {
  const v = fresh();
  assert.equal(v.remember({ scope: 'self', text: 'Attach files as cards; never paste whole resumes', agent: jude, source: 'from message m1' }).ok, true);
  assert.equal((v.remember({ scope: 'self', text: 'attach files as cards — never paste whole resumes!', agent: jude }) as { added: boolean }).added, false, 'same lesson in other words is not repeated');
  for (const f of ['Team.md', 'Owner.md', '.obsidian', 'Assistants/Jude (Job Applicator).md']) assert.ok(fs.existsSync(path.join(v.dir, f)), f);
  const note = fs.readFileSync(path.join(v.dir, 'Assistants/Jude (Job Applicator).md'), 'utf8'); assert.match(note, /^---\nassistant: researcher\n/); assert.match(note, /## Lessons\n- Attach files as cards; never paste whole resumes \(\d{4}-\d{2}-\d{2}, from message m1\)/);
  assert.match(fs.readdirSync(path.join(v.dir, 'Lessons')).join(), /\d{4}-\d{2}-\d{2}\.md/);
  for (let i = 0; i < 45; i++) v.remember({ scope: 'self', section: 'Facts', text: `fact number ${i}`, agent: jude });
  const facts = fs.readFileSync(v.notePath(jude), 'utf8').split('## Facts')[1].split('\n').filter((l) => l.startsWith('- ')); assert.equal(facts.length, 40); assert.match(facts[0], /fact number 5 /);
});

test('renaming an assistant renames its note and fixes [[links]]; an edit made in the file is what the next turn reads', () => {
  const v = fresh(); const r = { id: 'resume-tailor', name: 'Resume Tailor' };
  v.remember({ scope: 'team', text: 'Resume work goes to [[Resume Tailor]]', agent: { id: 'coordinator', name: 'Abdul' } });
  v.remember({ scope: 'self', text: 'Always make docx and pdf', agent: r });
  const p = v.notePath({ id: 'resume-tailor', name: 'Roger' }); assert.equal(path.basename(p), 'Roger.md'); assert.ok(!fs.existsSync(path.join(v.dir, 'Assistants/Resume Tailor.md')));
  assert.match(fs.readFileSync(path.join(v.dir, 'Team.md'), 'utf8'), /\[\[Roger\]\]/);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('Always make docx and pdf', 'Always make docx and pdf, named by company'));
  const ctx = v.context({ id: 'resume-tailor', name: 'Roger' }); assert.match(ctx, /named by company/); assert.match(ctx, /Team rules:[\s\S]*\[\[Roger\]\]/);
});

test('secrets never reach the vault (redaction canary)', () => {
  const v = fresh(); const canary = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  for (const text of [`my github token ${canary}`, 'password: hunter2hunter2', 'verification code is 482913', 'bot 123456789:AAH' + 'x'.repeat(33)]) { const r = v.remember({ scope: 'owner', text, agent: jude }); assert.equal(r.ok, false, text); }
  const all = fs.readdirSync(v.dir, { recursive: true }).map(String).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(v.dir, f), 'utf8')).join('\n');
  assert.ok(!all.includes(canary) && !all.includes('hunter2') && !all.includes('482913')); assert.equal(looksSecret('Prefers remote roles in Arizona'), null);
  assert.equal(v.writeNote(jude, `# Jude\n- token ${canary}`).ok, false);
});

test('remember is the assistant\'s own tool; team rules and other notes are the lead\'s; forget needs the owner\'s words', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')); process.env.CLAUDEBOT_MEMORY_DIR = dir;
  try {
    const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
    const jt = s.chat.send(c.id, '@researcher stop pasting resumes', s.defs).job;
    assert.equal((await s.call(jt, 'remember', { text: 'Attach resumes as files, never paste them' })).ok, true);
    assert.equal((await s.call(jt, 'remember', { scope: 'team', text: 'x y z rule' })).ok, false, 'a specialist cannot write team rules');
    const lt = s.chat.send(c.id, '@coordinator forget the rule about pasting', s.defs).job;
    assert.equal((await s.call(lt, 'remember', { scope: 'team', text: 'Answer the owner directly when addressed' })).ok, true);
    assert.equal((await s.call(lt, 'forget', { assistant: 'Jude', contains: 'paste', owner_words: 'something else' })).ok, false);
    assert.match((await s.call(lt, 'forget', { assistant: 'researcher', contains: 'paste', owner_words: 'forget the rule about pasting' })).text, /removed 1/);
  } finally { delete process.env.CLAUDEBOT_MEMORY_DIR; }
});
