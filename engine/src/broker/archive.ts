// Safe archive extraction for assistants (owner request 2026-10-13: an assistant could not open zip files the owner gave it).
// Extracts a .zip / .tar / .tar.gz / .tgz into a NEW empty folder inside the task workspace. Contents are untrusted data:
// nothing is executed, entries that escape the folder (absolute paths, "..") or are links are refused, and size/count
// limits stop archive bombs. Office/RTF documents also get a .txt copy (macOS textutil) and PDFs a .txt copy when pdftotext
// is installed, so the text is readable; PDFs stay readable directly too.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const LIMITS = { maxEntries: 5000, maxTotalBytes: 1024 * 1024 * 1024, maxFileBytes: 300 * 1024 * 1024, maxRatio: 200 };
type Entry = { name: string; size: number; isLink: boolean; isDir: boolean };

function listZip(src: string): Entry[] {
  // zipinfo -l: permissions, version, os, size, type, compressed, method, date, time, name
  const out = execFileSync('/usr/bin/zipinfo', ['-l', src], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entries: Entry[] = [];
  for (const line of out.split('\n')) {
    const m = /^([-dlrwxsStT?]{10})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!m) continue; entries.push({ name: m[3], size: Number(m[2]), isLink: m[1][0] === 'l', isDir: m[1][0] === 'd' || m[3].endsWith('/') });
  }
  return entries;
}
function listTar(src: string): Entry[] {
  const out = execFileSync('/usr/bin/tar', ['-tvf', src], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).map((line) => { const parts = line.trim().split(/\s+/); const perm = parts[0]; const size = Number(parts[4]) || 0; const name = parts.slice(8).join(' ').replace(/ -> .*$/, ''); return { name, size, isLink: perm[0] === 'l' || perm[0] === 'h', isDir: perm[0] === 'd' }; });
}

export function safeExtract(src: string, workspace: string): { folder: string; files: Array<{ path: string; bytes: number; text_copy?: string }>; skipped: string[] } {
  const lower = src.toLowerCase(); const isZip = lower.endsWith('.zip'); const isTar = /\.(tar|tar\.gz|tgz)$/.test(lower);
  if (!isZip && !isTar) throw new Error('only .zip, .tar, .tar.gz and .tgz archives can be extracted');
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('that archive does not exist');
  const entries = isZip ? listZip(src) : listTar(src);
  if (!entries.length) throw new Error('the archive is empty or could not be read');
  if (entries.length > LIMITS.maxEntries) throw new Error(`the archive has ${entries.length} entries (limit ${LIMITS.maxEntries})`);
  const total = entries.reduce((n, e) => n + e.size, 0); const packed = fs.statSync(src).size;
  if (total > LIMITS.maxTotalBytes || (packed > 0 && total / packed > LIMITS.maxRatio && total > 50 * 1024 * 1024)) throw new Error('the archive would unpack to an unsafe size');
  for (const e of entries) {
    if (e.isLink) throw new Error(`the archive contains a link (${e.name}); links are not extracted`);
    if (path.isAbsolute(e.name) || e.name.split(/[\\/]/).includes('..')) throw new Error(`the archive contains a path outside its folder (${e.name})`);
    if (e.size > LIMITS.maxFileBytes) throw new Error(`a file in the archive is too large (${e.name})`);
  }
  const base = path.basename(src).replace(/\.(zip|tar|tar\.gz|tgz)$/i, '').replace(/[^\w.-]+/g, '_') || 'archive';
  let folder = path.join(workspace, `extract-${base}`); for (let i = 2; fs.existsSync(folder); i++) folder = path.join(workspace, `extract-${base}-${i}`);
  fs.mkdirSync(folder, { recursive: true });
  if (isZip) execFileSync('/usr/bin/unzip', ['-qq', '-n', src, '-d', folder], { maxBuffer: 16 * 1024 * 1024 });
  else execFileSync('/usr/bin/tar', ['-xf', src, '-C', folder, '--no-same-owner', '--no-same-permissions'], { maxBuffer: 16 * 1024 * 1024 });
  // Re-check what landed: nothing outside the folder, no links, nothing executable.
  const files: Array<{ path: string; bytes: number; text_copy?: string }> = []; const skipped: string[] = [];
  const walk = (dir: string) => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const abs = path.join(dir, d.name); const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) { fs.unlinkSync(abs); skipped.push(path.relative(folder, abs)); continue; }
    if (st.isDirectory()) { walk(abs); continue; }
    fs.chmodSync(abs, 0o644); const rel = path.relative(workspace, abs); const item: { path: string; bytes: number; text_copy?: string } = { path: rel, bytes: st.size };
    const ext = path.extname(d.name).toLowerCase();
    try {
      if (['.docx', '.doc', '.rtf', '.odt', '.pages'].includes(ext)) { const txt = `${abs}.txt`; execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-output', txt, abs], { timeout: 30_000 }); item.text_copy = path.relative(workspace, txt); }
      else if (ext === '.pdf') { const pt = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext'].find((p) => fs.existsSync(p)); if (pt) { const txt = `${abs}.txt`; execFileSync(pt, ['-layout', abs, txt], { timeout: 60_000 }); item.text_copy = path.relative(workspace, txt); } }
    } catch { /* the original stays readable */ }
    files.push(item); } };
  walk(folder);
  return { folder: path.relative(workspace, folder) || '.', files, skipped };
}

/** Owner-provided sources: inside the task workspace, or a path the owner named in this task's request or in their own messages in its conversation. */
export function sourceAllowed(src: string, workspace: string, ownerText: string): boolean {
  const abs = path.resolve(src); const ws = path.resolve(workspace);
  if (abs.startsWith(ws + path.sep)) return true;
  return ownerText.includes(abs) || ownerText.includes(src);
}
