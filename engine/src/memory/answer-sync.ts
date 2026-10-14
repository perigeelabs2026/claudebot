/**
 * One answer store: the team saves the owner's answers in the computer's team folder (./shared/profile, ./shared/resumes/master),
 * and lookup_answer reads the memory vault. This copies those files into the vault's Owner/ folder so both always agree.
 */
import fs from 'node:fs'; import path from 'node:path'; import { execFile } from 'node:child_process';
import { LIMACTL, NAME } from '../computer/host.ts';
import { VM_SHARED } from '../runtime/computer.ts';
import { vaultDir } from './vault.ts';

const SHARED = VM_SHARED;
export const SYNCED: Array<[string, string]> = [[`${SHARED}/profile/application-answers.md`, 'Application answers.md'], [`${SHARED}/resumes/master/work-history.md`, 'Work history.md']];

const readVm = (file: string) => new Promise<string | null>((resolve) => execFile(LIMACTL, ['shell', NAME, '--', 'cat', file], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))));

/** Copy each file that exists in the computer into the vault (only when it changed). Returns the files written. */
export async function syncAnswerBank(read: (file: string) => Promise<string | null> = readVm, dir: string = vaultDir()): Promise<string[]> {
  const out = path.join(dir, 'Owner'); const written: string[] = [];
  for (const [src, name] of SYNCED) {
    const text = await read(src); if (!text || !text.trim()) continue;
    const dest = path.join(out, name); if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === text) continue;
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(dest, text); written.push(name);
  }
  return written;
}
