/** What an approval is, in the owner's words (the same rules as the app's approval card, for Telegram and other text surfaces). */
export interface ApprovalView { label: string; title: string; text: string; email: boolean; browser: boolean; missingBody: boolean }

export function describeApproval(ap: { action_kind: string; target: string; content: string }): ApprovalView {
  const raw = String(ap.content ?? ''); let b: { url?: string; action?: string; element?: { name?: string } } | null = null;
  try { const j = JSON.parse(raw); if (j && typeof j === 'object' && j.url && j.action) b = j; } catch { /* not a browser request */ }
  if (b) {
    const el = String(b.element?.name ?? ''); let site = ''; try { site = new URL(String(b.url)).hostname.replace(/^www\./, ''); } catch { /* */ }
    const label = b.action === 'type' ? 'Type in a page' : /\bapply\b/i.test(el) ? 'Open apply link' : /submit|send|post|publish|pay|buy|order/i.test(el) ? `Click "${el.slice(0, 40)}"` : 'Click on a page';
    return { label, title: el || label, text: `${b.action === 'click' ? `Click "${el || 'this control'}"` : `${b.action} "${el}"`} on ${site || 'this page'}.\n${b.url}`, email: false, browser: true, missingBody: false };
  }
  const head = (k: string) => (raw.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'im')) || [])[1]?.trim() ?? '';
  const body = raw.replace(/^\s*(To|From|Subject|Cc|Bcc):.*$/gim, '').trim(); const target = String(ap.target ?? '');
  const email = ap.action_kind === 'send' && (/^email to /i.test(target) || /@/.test(head('To')) || /^\s*Subject:/im.test(raw) || /^[^\s@]+@[^\s@]+$/.test(target));
  if (email) {
    const to = head('To') || target.replace(/^email to /i, '');
    return { label: 'Send email', title: head('Subject') || to, text: [`To: ${to}`, head('Cc') ? `Cc: ${head('Cc')}` : '', head('Bcc') ? `Bcc: ${head('Bcc')}` : '', `Subject: ${head('Subject') || '(no subject)'}`, '', body || '(There is no email text yet, so there is nothing to approve.)'].filter((x, i) => x || i > 3).join('\n'), email: true, browser: false, missingBody: !body };
  }
  const label = ({ send: 'Send or submit', publish: 'Publish', purchase: 'Buy', delete: 'Delete' } as Record<string, string>)[ap.action_kind] ?? ap.action_kind;
  return { label, title: target, text: `${target}\n\n${raw}`, email: false, browser: false, missingBody: false };
}
