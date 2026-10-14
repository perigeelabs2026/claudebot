/** Plain-English wording helpers shared by the API, the chat store and the worker. Nothing here invents activity: it only rewords recorded facts. */

/** A short task title from a long objective: first sentence, implementation clauses removed, ≤ 90 characters. */
export function taskTitle(objective: string): string {
  let t = String(objective ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(please|could you|can you|i(?:'d| would) like you to|i need you to)\s+/i, '');
  const first = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  let s = first
    .replace(/,?\s*(and\s+)?(then\s+)?(save|saving|store|register(?:ed|ing)?|record(?:ed|ing)?)\s+(it|them|the (?:file|result|output|document)|each(?: one)?)?\s*(as|in|to|with)\b[^,;]*?(?=[.,;]\s|[.,;]?$)/gi, '')
    .replace(/,?\s*registered as an? (artifact|output|result)/gi, '')
    .replace(/\s*\((?:about|around|roughly)[^)]*\)/gi, '')
    .replace(/\s+in the (task |job )?(workspace|folder)\b/gi, '')
    .replace(/\s*[,;:.]+\s*$/, '').trim();
  if (s.length > 90) s = s.slice(0, 87).replace(/\s+\S*$/, '') + '…';
  if (!s) s = t.slice(0, 87) + (t.length > 87 ? '…' : '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A conversation title from the owner's first message: ≤ 6 words, no trailing punctuation. */
export function conversationTitle(firstMessage: string): string {
  const t = taskTitle(firstMessage).replace(/[.!?…]+$/, '');
  const words = t.split(' ');
  return (words.length > 7 ? words.slice(0, 7).join(' ') + '…' : t).slice(0, 60);
}

/** Translate a runtime heartbeat note into something the owner can read. Unknown notes are kept as they are. */
export function progressWording(note: string): string {
  const n = String(note ?? '');
  if (/^acp session/.test(n)) return 'Connecting to Claude';
  if (n === 'run admitted') return 'Started this step';
  if (/^waiting \(/.test(n)) return 'Working on this step';
  if (n === 'assistant text' || /^agent (assistant|stream|item)/.test(n)) return 'Writing';
  if (/^agent tool/.test(n)) return 'Using a tool';
  if (/^agent plan/.test(n)) return 'Planning';
  if (/^agent compaction/.test(n)) return 'Tidying up its notes';
  if (/^agent (lifecycle|run_status|usage)/.test(n)) return 'Working on this step';
  if (/^agent /.test(n)) return 'Working on this step';
  if (n === 'simulated turn started') return 'Simulated step started';
  if (/^running stage /.test(n)) return `Starting step "${n.slice(14)}"`;
  if (/^resume/.test(n)) return 'Resuming from saved progress';
  return n;
}

/** Plain label for a recorded event, or null when the event is internal bookkeeping the owner does not need. */
export function eventWording(type: string, detail: Record<string, unknown>): string | null {
  const d = detail ?? {};
  switch (type) {
    case 'tool.called': return ({ write_artifact: 'Saving a result', set_account_password: 'Setting up an account password', browser_read: 'Reading a web page', create_job: 'Assigning specialist work', request_approval: 'Asking for your decision', read_artifact: 'Reading saved work', list_jobs: 'Checking task progress', add_evidence: 'Recording a source', report_progress: 'Reporting progress', search_evidence: 'Searching saved evidence', read_memory_rules: 'Reading your rules', read_records: 'Reading records', upsert_record: 'Updating a record', propose_memory_change: 'Proposing a rule change', run_allowlisted: 'Running an allowed command', browser_act: 'Using the browser', record_application: 'Recording an application', render_document: 'Making a document', continue_working: 'Checking the work and continuing', save_skill: 'Saving a method that worked', post_update: 'Posting an update', read_conversation: 'Reading the chat record', read_message: 'Reading a message', hand_off: 'Handing off to a teammate', remember: 'Saving a lesson' } as Record<string, string>)[String(d.tool)] ?? `Using ${String(d.tool ?? 'a tool').replaceAll('_', ' ')}`;
    case 'tool.refused': return `A tool was refused (${String(d.reason ?? d.tool ?? '')})`;
    case 'tool.failed': return 'A tool could not run';
    case 'agent.progress': return String(d.note ?? 'Progress note');
    case 'artifact.saved': return `Saved ${String(d.path ?? 'a result')}`;
    case 'checkpoint.written': return d.phase === 'after' ? `Finished step "${String(d.stage)}" and saved progress` : `Started step "${String(d.stage)}"`;
    case 'job.created': return 'Task created';
    case 'job.resumed': return 'Resumed from saved progress';
    case 'lease.acquired': return 'Picked up by a worker';
    case 'lease.reclaimed': return 'Recovered after a worker stopped';
    case 'session.closed': return 'Finished this session (work saved)';
    case 'browser.read': return `Read ${String(d.url ?? 'a page')}`;
    case 'approval.requested': return `Asked for your decision (${String(d.action_kind)})`;
    case 'approval.approved': return 'You approved';
    case 'approval.rejected': return 'You rejected';
    case 'owner.direction': return `Your direction: ${String(d.note ?? '')}`;
    case 'owner.direction.delivered': return `Your direction was given to the assistant (${String(d.how ?? '')})`;
    case 'turn.cancelled': return 'The Claude turn was stopped';
    case 'job.transition': { const to = String(d.to); if (to === 'cancelled') return 'Stopped'; if (to === 'completed') return 'Finished'; if (to === 'running') return 'Started working'; if (to === 'queued') return 'Back in the queue'; if (to === 'failed_terminal') return 'Could not finish'; if (to === 'waiting_for_auth') return 'Paused: sign in needed'; if (to === 'waiting_for_reset') return 'Paused: Claude usage limit'; if (to === 'waiting_for_approval') return 'Paused: needs your decision'; if (to === 'retry_scheduled') return 'Will try again'; return null; }
    default: return null;
  }
}

/** Blocked or failed text the owner reads: drop sentences that talk about internals (tools, shells, allow-lists, sub-agents…). */
export function plainForOwner(text: string): string {
  const internal = /\b(shell|allow-?list(?:ed)?|read tool|sub-?agents?|mcp|broker|capabilit(?:y|ies)|tool call|run_allowlisted|extract_archive|stdout|stderr|exit code)\b/i;
  const sentences = String(text).split(/(?<=[.!?])\s+/).filter((x) => x.trim() && !internal.test(x));
  return sentences.join(' ').trim() || 'It could not open the files it needed.';
}
