/**
 * Real documents from text results: Markdown → HTML (one clean resume/letter style) → .docx (macOS textutil) and .pdf (a headless
 * Chrome/Chromium print with a throwaway profile, never the owner's; cupsfilter as the fallback). Local tools only, no services.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
/** A small, predictable Markdown subset: headings, paragraphs, bullet/numbered lists, bold/italic/code/links, rules. */
export function markdownToHtml(md: string, title: string): string {
  const out: string[] = []; let list: 'ul' | 'ol' | null = null; let para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); close(); continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); close(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flush(); if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flush(); if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    close(); para.push(line.trim());
  }
  flush(); close();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: Letter; margin: 0.6in 0.7in; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; }
h1 { font-size: 18pt; margin: 0 0 4pt; } h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #999; padding-bottom: 2pt; margin: 12pt 0 5pt; }
h3 { font-size: 10.5pt; margin: 8pt 0 2pt; } h4 { font-size: 10.5pt; margin: 6pt 0 2pt; font-weight: normal; font-style: italic; }
p { margin: 0 0 5pt; } ul, ol { margin: 0 0 6pt 16pt; padding: 0; } li { margin: 0 0 2pt; } a { color: #111; } hr { border: 0; border-top: 1px solid #bbb; margin: 8pt 0; }
</style></head><body>${out.join('\n')}</body></html>`;
}

const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
export interface Rendered { format: 'docx' | 'pdf' | 'html'; path: string }

/** Write <base>.html/.docx/.pdf next to each other in dir. Returns what was produced, or throws naming the missing tool. */
export function renderDocument(html: string, dir: string, base: string, formats: Array<'docx' | 'pdf'>): Rendered[] {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const htmlPath = path.join(dir, `${base}.html`); fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  const out: Rendered[] = [];
  for (const f of formats) {
    const dest = path.join(dir, `${base}.${f}`); if (fs.existsSync(dest)) throw new Error(`${base}.${f} already exists; use another title`);
    if (f === 'docx') {
      const r = spawnSync('/usr/bin/textutil', ['-convert', 'docx', htmlPath, '-output', dest], { timeout: 60_000 });
      if (r.status !== 0 || !fs.existsSync(dest)) throw new Error(`could not make the .docx (textutil: ${String(r.stderr || r.error || '').slice(0, 160)})`);
    } else {
      const chrome = CHROMES.find((c) => fs.existsSync(c)); let ok = false;
      if (chrome) {
        const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'claudebot-pdf-'));
        try { const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${prof}`, '--no-pdf-header-footer', `--print-to-pdf=${dest}`, `file://${htmlPath}`], { timeout: 90_000 }); ok = r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 500; }
        finally { fs.rmSync(prof, { recursive: true, force: true }); }
      }
      if (!ok && fs.existsSync('/usr/sbin/cupsfilter')) { const r = spawnSync('/usr/sbin/cupsfilter', [htmlPath], { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 }); if (r.status === 0 && r.stdout?.length > 500 && r.stdout.subarray(0, 5).toString() === '%PDF-') { fs.writeFileSync(dest, r.stdout, { mode: 0o600 }); ok = true; } }
      if (!ok) throw new Error('could not make the .pdf (no Chrome/Chromium and cupsfilter failed)');
    }
    out.push({ format: f, path: dest });
  }
  return out;
}
