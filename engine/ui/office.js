// The office: a 2D SVG picture of the real assistants and their real work. Everything drawn here comes from the
// workbench snapshot (/api/workbench): leases, heartbeats, dependencies and recorded events. Nothing is invented:
// an assistant looks busy only while its task has a fresh heartbeat; a hand-off moves only when a delegation or
// delivery was actually recorded in the last 40 s. Reduced motion disables movement; every figure is keyboard reachable.
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v)); } for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(typeof c === 'string' ? document.createTextNode(c) : c); return e; };
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Rooms are fixed; desks inside a room are assigned to the assistants that belong there. Extra assistants (packs, owner-created) fill the Sales & operations wing.
const ROOMS = [
  { id: 'reception', label: 'Front desk', x: 90, y: 56, w: 330, h: 280, agents: ['coordinator'], hint: 'The lead assistant talks with you and hands work to the specialists.' },
  { id: 'research', label: 'Research', x: 450, y: 56, w: 380, h: 280, agents: ['researcher', 'browser_operator'], hint: 'Research and reading web pages in the ClaudeBot browser.' },
  { id: 'review', label: 'Review', x: 860, y: 56, w: 300, h: 280, agents: ['reviewer'], hint: 'Independent checks before you rely on a result.' },
  { id: 'studio', label: 'Writing & building', x: 450, y: 376, w: 380, h: 290, agents: ['builder'], hint: 'Documents, files and code changes.' },
  { id: 'sales', label: 'Sales & operations', x: 860, y: 376, w: 300, h: 290, agents: [], hint: 'Assistants from optional packs or ones you create work here.' },
  { id: 'results', label: 'Results & queue', x: 90, y: 376, w: 330, h: 290, agents: [], hint: 'What was delivered to you, and what is waiting to start.' },
];
const SHIRT = { coordinator: '#0f6e63', researcher: '#2b5aa6', browser_operator: '#6a4fb3', builder: '#b85c1a', reviewer: '#8a2e5c' };
const EXTRA_SHIRTS = ['#4c7a1f', '#a0522d', '#1f6f8b', '#7a5c1f'];

const STATUS_LABEL = { working: 'Working', checking: 'Checking status…', waiting: 'Paused', blocked_on: 'Waiting on', queued: 'Waiting to start', idle: 'Available', disabled: 'Switched off', delivering: 'Delivering' };

function deskPositions(room, n) {
  const slots = []; const cols = n <= 2 ? n : 2; const rows = Math.ceil(n / cols);
  for (let i = 0; i < n; i++) { const c = i % cols; const r = Math.floor(i / cols); const cx = room.x + ((c + 0.5) * room.w) / cols; const cy = room.y + 90 + r * 120 + (rows === 1 ? 40 : 0); slots.push({ x: cx, y: cy }); }
  return slots;
}

/** Assign every real assistant a desk. Returns [{agent, room, x, y}]. */
export function placeAssistants(assistants) {
  const placed = []; const used = new Set();
  for (const room of ROOMS) { const here = room.agents.map((id) => assistants.find((a) => a.id === id)).filter(Boolean); const pos = deskPositions(room, Math.max(here.length, room.agents.length)); here.forEach((a, i) => { placed.push({ agent: a, room, ...pos[i] }); used.add(a.id); }); }
  const extra = assistants.filter((a) => !used.has(a.id)); const sales = ROOMS.find((r) => r.id === 'sales'); const pos = deskPositions(sales, Math.max(1, Math.min(4, extra.length)));
  extra.slice(0, 4).forEach((a, i) => placed.push({ agent: a, room: sales, ...pos[i] }));
  return placed;
}

function figure(a, p, shirt, selected, handlers) {
  const st = a.status; const task = a.tasks[0] || null;
  const g = svg('g', { class: `fig ${st} ${selected ? 'selected' : ''}`, transform: `translate(${p.x} ${p.y})`, role: 'button', tabindex: '0', 'aria-label': `${a.name}: ${statusText(a, task)}`, 'data-agent': a.id, onclick: () => handlers.onSelect(a, task), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.onSelect(a, task); } } });
  // desk + chair
  g.append(svg('rect', { class: 'chair', x: -14, y: -18, width: 28, height: 22, rx: 6 }));
  g.append(svg('rect', { class: 'desk', x: -70, y: 10, width: 140, height: 40, rx: 8 }));
  if (a.id === 'browser_operator') g.append(svg('g', { class: `monitor ${task && task.kind.startsWith('browser.') && st === 'working' ? 'live' : ''}` }, svg('rect', { x: 22, y: -14, width: 40, height: 28, rx: 3 }), svg('rect', { x: 38, y: 14, width: 8, height: 6 }), svg('line', { x1: 30, y1: 24, x2: 54, y2: 24 })));
  if (a.id === 'researcher') g.append(svg('g', { class: 'books' }, svg('rect', { x: -62, y: -2, width: 8, height: 14 }), svg('rect', { x: -52, y: -6, width: 8, height: 18 }), svg('rect', { x: -42, y: 0, width: 8, height: 12 })));
  if (a.id === 'builder') g.append(svg('g', { class: 'tools' }, svg('rect', { x: 30, y: 2, width: 26, height: 10, rx: 2 }), svg('rect', { x: 34, y: -6, width: 4, height: 10 })));
  if (a.id === 'reviewer') g.append(svg('g', { class: 'stamp' }, svg('rect', { x: 36, y: 0, width: 18, height: 12, rx: 3 }), svg('rect', { x: 42, y: -8, width: 6, height: 8 })));
  if (a.id === 'coordinator') g.append(svg('g', { class: 'phone' }, svg('rect', { x: -58, y: 0, width: 16, height: 10, rx: 3 })));
  // body
  g.append(svg('rect', { class: 'body', x: -22, y: -46, width: 44, height: 50, rx: 14, fill: shirt }));
  g.append(svg('circle', { class: 'head', cx: 0, cy: -58, r: 16 }));
  g.append(svg('path', { class: 'hair', d: hairPath(a.id) }));
  if (a.id === 'researcher') g.append(svg('g', { class: 'glasses' }, svg('circle', { cx: -6, cy: -58, r: 5 }), svg('circle', { cx: 6, cy: -58, r: 5 }), svg('line', { x1: -1, y1: -58, x2: 1, y2: -58 })));
  if (a.id === 'browser_operator') g.append(svg('path', { class: 'headset', d: 'M -16 -60 a 16 16 0 0 1 32 0 M 14 -56 v 8 h -4' }));
  if (a.id === 'coordinator') g.append(svg('path', { class: 'tie', d: 'M -3 -44 l 3 6 l 3 -6 l -1 16 l -2 4 l -2 -4 z', fill: '#ffffff', opacity: '.85' }));
  // status badge above the head
  const badge = svg('g', { class: `badge ${st}`, transform: 'translate(0 -92)' });
  if (st === 'working') { badge.append(svg('rect', { x: -26, y: -11, width: 52, height: 22, rx: 11 })); [-10, 0, 10].forEach((x, i) => badge.append(svg('circle', { class: `dot d${i}`, cx: x, cy: 0, r: 3.5 }))); if (task && task.turn === 'claude') badge.append(svg('text', { x: 34, y: 4, class: 'spark' }, '✦')); }
  else if (st === 'checking') { badge.append(svg('circle', { r: 12 })); badge.append(svg('text', { y: 5, class: 'glyph' }, '?')); }
  else if (st === 'waiting') { badge.append(svg('circle', { r: 12 })); badge.append(svg('rect', { x: -5, y: -6, width: 3.5, height: 12 })); badge.append(svg('rect', { x: 1.5, y: -6, width: 3.5, height: 12 })); }
  else if (st === 'blocked_on') { badge.append(svg('circle', { r: 12 })); badge.append(svg('text', { y: 5, class: 'glyph' }, '⇄')); }
  else if (st === 'queued') { badge.append(svg('circle', { r: 12 })); badge.append(svg('circle', { r: 7, class: 'clock' })); badge.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -5 })); badge.append(svg('line', { x1: 0, y1: 0, x2: 4, y2: 2 })); }
  if (st !== 'idle' && st !== 'disabled') g.append(badge);
  // labels
  g.append(svg('text', { class: 'name', y: 66, 'text-anchor': 'middle' }, a.name));
  g.append(svg('text', { class: `status ${st}`, y: 82, 'text-anchor': 'middle' }, statusText(a, task)));
  if (task) g.append(svg('text', { class: 'task', y: 97, 'text-anchor': 'middle' }, clip(task.title, 30)));
  if (selected) g.append(svg('rect', { class: 'select-ring', x: -78, y: -104, width: 156, height: 210, rx: 14 }));
  return g;
}
function hairPath(id) { return { coordinator: 'M -15 -64 q 15 -16 30 0 q -5 -6 -15 -6 q -10 0 -15 6 z', researcher: 'M -16 -62 q 16 -22 32 0 z', browser_operator: 'M -14 -66 q 14 -12 28 0 q -14 -6 -28 0 z', builder: 'M -16 -60 q 6 -20 32 -2 q -8 -8 -32 2 z', reviewer: 'M -16 -58 q 2 -26 32 -6 q -4 -6 -32 6 z' }[id] ?? 'M -15 -63 q 15 -14 30 0 z'; }
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
export function statusText(a, task) {
  if (a.status === 'disabled') return 'Switched off';
  if (!task) return a.status === 'idle' ? 'Available' : STATUS_LABEL[a.status];
  if (task.status === 'working') return `${task.turn === 'claude' ? 'Claude turn' : 'Engine step'} · ${task.progress || task.stage || 'working'}`;
  if (task.status === 'checking') return 'Checking status (no fresh heartbeat)';
  if (task.status === 'blocked_on') return `Waiting on ${task.waiting_on_tasks.map((w) => w.assistant).join(', ')}`;
  if (task.status === 'queued') return 'Waiting to start';
  if (task.status === 'waiting') return task.plain_state;
  return STATUS_LABEL[task.status] || task.status;
}

/** Render or update the office inside `host`. Returns an updater so live refreshes keep selection and animate real hand-offs only. */
export function mountOffice(host, opts) {
  const seenEvents = opts.seen ?? new Set(); let first = seenEvents.size === 0 && !opts.animateInitial;
  const root = svg('svg', { class: 'office', viewBox: '0 0 1200 720', role: 'group', 'aria-label': 'Office: your assistants and their current work', preserveAspectRatio: 'xMidYMin meet' });
  host.replaceChildren(root);
  function draw(snapshot, selected) {
    root.replaceChildren();
    root.append(svg('rect', { class: 'floor', x: 0, y: 0, width: 1200, height: 720 }));
    for (let x = 0; x <= 1200; x += 60) root.append(svg('line', { class: 'tile', x1: x, y1: 0, x2: x, y2: 720 }));
    for (let y = 0; y <= 720; y += 60) root.append(svg('line', { class: 'tile', x1: 0, y1: y, x2: 1200, y2: y }));
    // owner's door
    root.append(svg('g', { class: 'door', transform: 'translate(24 300)' }, svg('rect', { x: 0, y: 0, width: 44, height: 90, rx: 4 }), svg('circle', { cx: 34, cy: 46, r: 3 }), svg('text', { x: 22, y: 112, 'text-anchor': 'middle', class: 'name' }, 'You')));
    for (const r of ROOMS) root.append(svg('g', { class: `room ${r.id}` }, svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 14 }), svg('text', { class: 'room-label', x: r.x + 14, y: r.y + 24 }, r.label), svg('title', {}, r.hint)));
    const placed = placeAssistants(snapshot.assistants);
    placed.forEach((p, i) => root.append(figure(p.agent, p, SHIRT[p.agent.id] || EXTRA_SHIRTS[i % EXTRA_SHIRTS.length], selected && (selected.agent === p.agent.id || (selected.task && p.agent.tasks.some((t) => t.id === selected.task))), opts)));
    const sales = ROOMS.find((r) => r.id === 'sales'); if (!placed.some((p) => p.room.id === 'sales')) root.append(svg('text', { class: 'hint', x: sales.x + 14, y: sales.y + 60 }, 'No assistant here yet.'), svg('text', { class: 'hint', x: sales.x + 14, y: sales.y + 78 }, 'Packs and assistants you create appear here.'));
    // results & queue room: delivered results (clickable) and the queue board
    const rr = ROOMS.find((r) => r.id === 'results'); const finished = snapshot.tasks.filter((t) => t.status === 'finished' && !t.is_reply && t.outputs.length).slice(0, 4);
    root.append(svg('rect', { class: 'shelf', x: rr.x + 16, y: rr.y + 44, width: rr.w - 32, height: 6 }));
    finished.forEach((t, i) => { const x = rr.x + 34 + i * 76; const g = svg('g', { class: `doc ${t.outcome === 'partial' ? 'partial' : t.outcome === null ? 'unknown' : ''}`, transform: `translate(${x} ${rr.y + 54})`, role: 'button', tabindex: '0', 'aria-label': `Open result: ${t.title}`, onclick: () => opts.onOpenResult(t), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onOpenResult(t); } } }, svg('rect', { x: 0, y: 0, width: 44, height: 56, rx: 4 }), svg('path', { d: 'M 30 0 v 14 h 14' }), svg('line', { x1: 8, y1: 24, x2: 36, y2: 24 }), svg('line', { x1: 8, y1: 32, x2: 36, y2: 32 }), svg('line', { x1: 8, y1: 40, x2: 28, y2: 40 }), svg('text', { class: 'doc-label', x: 22, y: 72, 'text-anchor': 'middle' }, clip(t.outputs[0].title, 14)), svg('title', {}, `${t.assistant}: ${t.title} (${t.plain_state})`)); root.append(g); });
    if (!finished.length) root.append(svg('text', { class: 'hint', x: rr.x + 16, y: rr.y + 80 }, 'Delivered results appear here.'));
    const working = snapshot.counts.working; const checking = snapshot.counts.checking; const waitingToStart = snapshot.counts.waiting_to_start; const onAnother = snapshot.counts.blocked_on;   // the same counts as the header
    const board = svg('g', { class: 'board', transform: `translate(${rr.x + 16} ${rr.y + 160})` }, svg('rect', { x: 0, y: 0, width: rr.w - 32, height: 110, rx: 10 }), svg('text', { class: 'board-title', x: 14, y: 24 }, 'Queue board'), svg('text', { class: 'board-line', x: 14, y: 48 }, `${working} working · ${checking} being checked${snapshot.counts.waiting_on_children ? ` · ${snapshot.counts.waiting_on_children} waiting on a child` : ''}`), svg('text', { class: 'board-line', x: 14, y: 68 }, `${waitingToStart} waiting to start${onAnother ? ` (${onAnother} on another assistant)` : ''}`), svg('text', { class: 'board-line', x: 14, y: 88 }, `${snapshot.counts.waiting} paused for you or a sign-in`));
    root.append(board);
    root.append(svg('text', { class: 'footnote', x: 90, y: 700 }, 'Busy means a real task with a fresh heartbeat. Movement shows recorded hand-offs only. Click anyone to inspect.'));
    // real hand-offs of the last 40 s, each animated once
    for (const ev of snapshot.recent || []) { const key = `${ev.type}:${ev.job_id}:${ev.at}`; if (seenEvents.has(key)) continue; seenEvents.add(key); if (first) continue; animateHandoff(root, placed, ev); }
    first = false;
  }
  function animateHandoff(rootEl, placed, ev) {
    const byName = (n) => placed.find((p) => p.agent.name === n); const door = { x: 46, y: 345 };
    const from = ev.type === 'delegated' ? (ev.from === 'you' ? door : byName(ev.from)) : byName(ev.from); const to = ev.type === 'delegated' ? byName(ev.to) : door;
    if (!from || !to) return;
    const note = svg('g', { class: `handoff ${ev.type}` }, svg('rect', { x: -10, y: -13, width: 20, height: 26, rx: 3 }), svg('line', { x1: -5, y1: -4, x2: 5, y2: -4 }), svg('line', { x1: -5, y1: 2, x2: 5, y2: 2 }));
    note.setAttribute('transform', `translate(${from.x} ${from.y - 30})`); rootEl.append(note);
    if (reduced() || !note.animate) { const target = ev.type === 'delegated' ? byName(ev.to) : null; if (target) { const ring = rootEl.querySelector(`[data-agent="${target.agent.id}"]`); ring && ring.classList.add('flash'); } note.remove(); return; }
    const anim = note.animate([{ transform: `translate(${from.x}px, ${from.y - 30}px)` }, { transform: `translate(${to.x}px, ${to.y - 30}px)` }], { duration: 1400, easing: 'ease-in-out' });
    anim.onfinish = () => note.remove();
  }
  return { draw };
}
