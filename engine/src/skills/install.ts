// Reviewed skills (Claude Code project skills) for task workspaces. A skill reaches a task only when it is listed in
// skills/REVIEWED.json for the task's role AND the SKILL.md hash still matches the reviewed hash. Anything else is refused
// and reported, so an edited or added skill cannot slip into an assistant's instructions unreviewed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SkillManifest { skills: Record<string, { sha256: string; roles: string[]; reviewed_at: string }> }
export const SKILLS_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', 'skills');

export function reviewedSkills(root = SKILLS_ROOT): { ok: Array<{ name: string; roles: string[] }>; refused: Array<{ name: string; reason: string }> } {
  const ok: Array<{ name: string; roles: string[] }> = []; const refused: Array<{ name: string; reason: string }> = [];
  let m: SkillManifest = { skills: {} }; try { m = JSON.parse(fs.readFileSync(path.join(root, 'REVIEWED.json'), 'utf8')) as SkillManifest; } catch { return { ok, refused: [{ name: '*', reason: 'no REVIEWED.json' }] }; }
  const dirs = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  for (const name of dirs) {
    const f = path.join(root, name, 'SKILL.md'); if (!fs.existsSync(f)) continue;
    const entry = m.skills[name]; if (!entry) { refused.push({ name, reason: 'not reviewed' }); continue; }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (sha !== entry.sha256) { refused.push({ name, reason: 'changed since review (hash mismatch)' }); continue; }
    if (fs.readdirSync(path.join(root, name)).some((x) => x !== 'SKILL.md')) { refused.push({ name, reason: 'contains files other than SKILL.md (scripts are not allowed)' }); continue; }
    ok.push({ name, roles: entry.roles });
  }
  return { ok, refused };
}

/** Copy the role's reviewed skills into <cwd>/.claude/skills; returns what was installed and what was refused. */
export function installSkills(cwd: string, role: string, root = SKILLS_ROOT): { installed: string[]; refused: Array<{ name: string; reason: string }> } {
  const { ok, refused } = reviewedSkills(root); const installed: string[] = [];
  const target = path.join(cwd, '.claude', 'skills');
  for (const s of ok.filter((x) => x.roles.includes(role))) {
    const dir = path.join(target, s.name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(root, s.name, 'SKILL.md'), path.join(dir, 'SKILL.md')); installed.push(s.name);
  }
  return { installed, refused };
}
