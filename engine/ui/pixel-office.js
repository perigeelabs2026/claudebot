// ClaudeBot office: a side-view pixel world (original art; from design/system/office.js, the approved design).
// It draws only what the engine reports: an assistant animates only while its task holds a live lease with a fresh heartbeat
// (workbench status "working"), shows "!" when it waits on the owner, and stands still otherwise. No invented movement.
const W = 240, H = 136, GROUND = 112;
const C = {
  sky1: '#0d1424', sky2: '#1b2540', sky3: '#33405f', star: '#cfd8ff',
  hill: '#141c2c', hill2: '#1a2436',
  grass: '#3f8f4f', grass2: '#56ab62', dirt: '#5a3d2b', dirt2: '#4a3223', stone: '#3a3b44', stone2: '#2f3038',
  wall: '#3b2a20', wall2: '#33241b', plank: '#8a5a36', plank2: '#6e4528', beam: '#5b3a22',
  roof: '#7c3b33', roof2: '#64302a', glass: '#20304d', glassLit: '#f2c46d',
  wood: '#9b6a40', wood2: '#7a5232', metal: '#8d96a3', screen: '#8ab4ff', paper: '#ece6d8',
  skin: '#e7b48f', skin2: '#c98f6b', pants: '#2b3140', shoe: '#1a1d24', torch: '#f6a93b', flame: '#ffd36e',
  leaf: '#2f6e3c', leaf2: '#3f8a4b', trunk: '#5a3b26',
};

function px(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x | 0, y | 0, w | 0, h | 0); }

function drawSky(g) {
  for (let y = 0; y < GROUND; y++) { const t = y / GROUND; px(g, 0, y, W, 1, t < .45 ? C.sky1 : t < .8 ? C.sky2 : C.sky3); }
  const stars = [[12, 8], [31, 20], [58, 6], [77, 15], [101, 4], [133, 12], [162, 7], [188, 18], [207, 5], [229, 13], [46, 30], [214, 28]];
  stars.forEach(([x, y]) => px(g, x, y, 1, 1, C.star));
  px(g, 196, 10, 8, 8, '#e9edf7'); px(g, 198, 10, 6, 6, '#c9d1e6'); // moon
  // hills
  for (let x = 0; x < W; x++) { const h = 14 + Math.round(6 * Math.sin(x / 19) + 4 * Math.sin(x / 7)); px(g, x, GROUND - h, 1, h, C.hill); }
  for (let x = 0; x < W; x++) { const h = 6 + Math.round(4 * Math.sin(x / 13 + 1)); px(g, x, GROUND - h, 1, h, C.hill2); }
}

function drawGround(g) {
  px(g, 0, GROUND, W, H - GROUND, C.dirt);
  for (let x = 0; x < W; x += 2) px(g, x, GROUND, 2, 2 + ((x * 7) % 3 === 0 ? 1 : 0), (x / 2) % 3 ? C.grass : C.grass2);
  for (let i = 0; i < 70; i++) { const x = (i * 37) % W, y = GROUND + 5 + ((i * 53) % (H - GROUND - 6)); px(g, x, y, 2, 2, i % 3 ? C.dirt2 : C.stone); }
  px(g, 0, H - 6, W, 6, C.stone2);
  for (let x = 0; x < W; x += 6) px(g, x, H - 6, 3, 2, C.stone);
}

function drawTree(g, x) {
  px(g, x + 5, GROUND - 26, 4, 26, C.trunk);
  px(g, x, GROUND - 40, 14, 10, C.leaf); px(g, x - 3, GROUND - 34, 20, 8, C.leaf2); px(g, x + 2, GROUND - 46, 10, 7, C.leaf2);
}

// House: two floors, left room per floor plus a hall
const HX = 26, HW = 192, F1 = GROUND - 32, F2 = F1 - 32;
function drawHouse(g, t) {
  // back wall
  for (let y = F2; y < GROUND; y++) px(g, HX, y, HW, 1, (y >> 2) % 2 ? C.wall : C.wall2);
  for (let x = HX; x < HX + HW; x += 16) px(g, x, F2, 1, GROUND - F2, C.wall2);
  // beams and frame
  px(g, HX - 3, F2, 3, GROUND - F2, C.beam); px(g, HX + HW, F2, 3, GROUND - F2, C.beam);
  // floors (planks)
  [F1, F2].forEach((fy) => { px(g, HX - 3, fy, HW + 6, 3, C.plank); for (let x = HX - 3; x < HX + HW + 3; x += 8) px(g, x, fy + 2, 1, 1, C.plank2); });
  px(g, HX - 3, GROUND - 1, HW + 6, 2, C.plank2);
  // roof
  for (let i = 0; i < 18; i++) px(g, HX - 8 + i * 2, F2 - i, HW + 16 - i * 4, 1, i % 3 ? C.roof : C.roof2);
  // windows
  [[HX + 70, F2 + 8], [HX + 128, F2 + 8], [HX + 92, F1 + 8]].forEach(([x, y], i) => {
    px(g, x, y, 14, 12, C.beam); px(g, x + 1, y + 1, 12, 10, i === 2 ? C.glassLit : C.glass); px(g, x + 7, y + 1, 1, 10, C.beam); px(g, x + 1, y + 6, 12, 1, C.beam);
  });
  // ladder between floors
  for (let y = F2 + 3; y < F1; y += 4) px(g, HX + HW - 18, y, 10, 1, C.wood);
  px(g, HX + HW - 18, F2 + 3, 1, F1 - F2 - 3, C.wood2); px(g, HX + HW - 9, F2 + 3, 1, F1 - F2 - 3, C.wood2);
  // torches
  [[HX + 4, F2 + 12], [HX + HW - 6, F1 + 12], [HX + 60, F1 + 12]].forEach(([x, y], i) => {
    px(g, x, y, 2, 6, C.wood2); const f = Math.sin(t / 140 + i * 2) > 0 ? 1 : 0;
    px(g, x - 1, y - 3 - f, 4, 3 + f, C.torch); px(g, x, y - 2 - f, 2, 2, C.flame);
  });
}

// Stations
function deskAndMonitor(g, x, y, t, on) { px(g, x, y - 7, 20, 2, C.wood); px(g, x + 1, y - 5, 2, 5, C.wood2); px(g, x + 17, y - 5, 2, 5, C.wood2); px(g, x + 6, y - 15, 10, 7, C.metal); px(g, x + 7, y - 14, 8, 5, on && ((t / 300) | 0) % 4 ? C.screen : '#4d6ea8'); px(g, x + 10, y - 8, 2, 1, C.metal); px(g, x + 2, y - 9, 3, 2, C.paper); }
function bookshelf(g, x, y) { px(g, x, y - 26, 16, 26, C.wood2); for (let r = 0; r < 3; r++) { px(g, x + 1, y - 25 + r * 8, 14, 7, C.wall2); const cols = ['#c25b4d', '#4d7cc2', '#d6b04a', '#5aa36a', '#9a6ac2']; for (let b = 0; b < 5; b++) px(g, x + 2 + b * 3, y - 24 + r * 8 + (b % 2), 2, 6 - (b % 2), cols[(b + r) % 5]); } }
function table(g, x, y) { px(g, x, y - 8, 28, 2, C.wood); px(g, x + 2, y - 6, 2, 6, C.wood2); px(g, x + 24, y - 6, 2, 6, C.wood2); px(g, x + 6, y - 10, 6, 2, C.paper); px(g, x + 15, y - 11, 3, 3, '#c25b4d'); px(g, x + 21, y - 10, 4, 2, C.paper); }
function mailbox(g, x, y, t, on) { px(g, x, y - 12, 14, 12, C.wood2); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) px(g, x + 1 + c * 4, y - 11 + r * 4, 3, 3, C.wall2); px(g, x + 2, y - 10, 2, 2, C.paper); px(g, x + 6, y - 6, 2, 2, C.paper); px(g, x + 16, y - 9, 6, 9, C.metal); px(g, x + 17, y - 8, 4, 3, on && ((t / 250) | 0) % 2 ? '#6fc7e8' : '#2b4a5a'); px(g, x + 19, y - 14, 1, 5, C.metal); }
function podium(g, x, y) { px(g, x, y - 12, 10, 12, C.wood); px(g, x - 2, y - 13, 14, 2, C.wood2); px(g, x + 16, y - 24, 9, 22, C.beam); px(g, x + 17, y - 23, 7, 20, '#9fb2c9'); px(g, x + 18, y - 22, 2, 8, '#c8d6e6'); }

// Character: 8x13 pixel person, shirt in the assistant's color
function person(g, x, y, color, hair, t, state, facing) {
  const bob = state === 'working' ? (Math.sin(t / 220 + x) > 0 ? 1 : 0) : 0;
  const top = y - 13 - bob;
  px(g, x + 2, top, 4, 1, hair); px(g, x + 1, top + 1, 6, 1, hair);
  px(g, x + 1, top + 2, 6, 4, C.skin); px(g, x + 1, top + 2, 6, 1, hair);
  px(g, facing > 0 ? x + 5 : x + 2, top + 3, 1, 1, '#1b1b1b');
  px(g, x + 1, top + 6, 6, 4, color); px(g, x, top + 6, 1, 3, color); px(g, x + 7, top + 6, 1, 3, color);
  const arm = state === 'working' && ((t / 160) | 0) % 2 ? 1 : 0;
  px(g, facing > 0 ? x + 7 : x, top + 9 - arm, 1, 1, C.skin);
  px(g, x + 1, top + 10, 6, 2, C.pants); px(g, x + 1, top + 12 + bob, 2, 1, C.shoe); px(g, x + 5, top + 12 + bob, 2, 1, C.shoe);
  if (state === 'waiting') { px(g, x + 2, top - 9, 5, 7, '#f2c46d'); px(g, x + 4, top - 8, 1, 3, '#241a05'); px(g, x + 4, top - 4, 1, 1, '#241a05'); px(g, x + 3, top - 2, 2, 1, '#f2c46d'); }
  if (state === 'working') { const d = ((t / 400) | 0) % 3; for (let i = 0; i <= d; i++) px(g, x + 1 + i * 3, top - 4, 2, 2, '#e8eaed'); }
}

// Station types. An assistant record names its station; positions are fixed slots in the house.
const STATIONS = {
  desk: { x: HX + 14, floor: GROUND, draw: (g, s, t, on) => deskAndMonitor(g, s.x, s.floor, t, on), px: 6, face: 1 },
  table: { x: HX + 84, floor: GROUND, draw: (g, s) => table(g, s.x, s.floor), px: 10, face: 1 },
  mailroom: { x: HX + 128, floor: GROUND, draw: (g, s, t, on) => mailbox(g, s.x, s.floor, t, on), px: -10, face: 1 },
  library: { x: HX + 14, floor: F1, draw: (g, s) => bookshelf(g, s.x, s.floor), px: 20, face: -1 },
  stage: { x: HX + 100, floor: F1, draw: (g, s) => podium(g, s.x, s.floor), px: 12, face: 1 },
  loft: { x: HX + 140, floor: F1, draw: (g, s) => table(g, s.x - 6, s.floor), px: 4, face: -1 },
  workshop: { x: HX + 160, floor: GROUND, draw: (g, s, t, on) => deskAndMonitor(g, s.x - 4, s.floor, t, on), px: 2, face: -1 },
  porch: { x: 10, floor: GROUND, draw: (g, s) => { px(g, s.x - 2, s.floor - 5, 14, 2, C.wood); px(g, s.x, s.floor - 3, 2, 3, C.wood2); px(g, s.x + 9, s.floor - 3, 2, 3, C.wood2); }, px: 2, face: 1 },
};


// agents: [{ name, station: 'desk'|'table'|'mailroom'|'library'|'stage', colorVar: '--a-…', state: 'working'|'waiting'|'idle', stateLabel }]
// state must come from real job/lease/heartbeat data; the renderer never invents activity.

const HAIR = ['#2b2b33', '#6b4a2b', '#d9c27a', '#3a2a1e', '#1c1c22', '#5a3b2a', '#2a2a2a', '#c9a35a'];

/** Mount the office canvas into `host`. update(agents) takes [{ id, name, station, colorVar, state: 'working'|'waiting'|'idle' }]. */
export function mountPixelOffice(host, { onSelect, onHover } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'office-wrap';
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.setAttribute('role', 'img'); cv.tabIndex = -1;
  wrap.appendChild(cv); host.appendChild(wrap);
  const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let agents = [];
  const hit = []; // { id, x, y, w, h } in canvas pixels
  let looping = false;
  function frameOnce() { draw(performance.now()); }
  function frame(t) { if (!document.body.contains(cv)) { looping = false; return; } draw(t); if (!reduce) requestAnimationFrame(frame); }
  function draw(t) {
    drawSky(g); if (!agents.some((a) => a.station === 'porch')) drawTree(g, 4); drawTree(g, W - 12); drawGround(g); drawHouse(g, t);
    hit.length = 0;
    agents.forEach((a) => { const s = STATIONS[a.station]; if (s) s.draw(g, s, t, a.state === 'working'); });
    const colors = getComputedStyle(document.documentElement);
    agents.forEach((a, i) => { const s = STATIONS[a.station]; if (!s) return; const x = s.x + s.px; person(g, x, s.floor - 1, colors.getPropertyValue(a.colorVar).trim() || '#8ab4ff', HAIR[i % HAIR.length], t, a.state, s.face); hit.push({ id: a.id, x: x - 2, y: s.floor - 24, w: 12, h: 24 }); });
  }
  const at = (cx, cy) => { const r = cv.getBoundingClientRect(); const x = (cx - r.left) * (W / r.width); const y = (cy - r.top) * (H / r.height); return hit.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null; };
  // Where a character stands, in CSS px inside the office frame (for its hover card).
  const spot = (b) => { const r = cv.getBoundingClientRect(); const k = r.width / W, kh = r.height / H; return { x: (b.x + b.w / 2) * k, top: b.y * kh, bottom: (b.y + b.h) * kh, width: r.width }; };
  cv.addEventListener('click', (e) => { const h = at(e.clientX, e.clientY); if (h && onSelect) onSelect(h.id); });
  let hoverId = null;
  cv.addEventListener('mousemove', (e) => { const h = at(e.clientX, e.clientY); cv.style.cursor = h ? 'pointer' : ''; const id = h ? h.id : null; if (id === hoverId) return; hoverId = id; if (onHover) onHover(id, h ? spot(h) : null); });
  cv.addEventListener('mouseleave', () => { cv.style.cursor = ''; if (hoverId !== null) { hoverId = null; if (onHover) onHover(null, null); } });
  // Draw immediately (a hidden or occluded window throttles animation frames), then animate while visible.
  frameOnce();
  requestAnimationFrame(frame);
  return {
    update(list) { agents = list; frameOnce(); cv.setAttribute('aria-label', 'Office: ' + list.map((a) => `${a.name} ${a.state === 'working' ? 'working' : a.state === 'waiting' ? 'needs you' : 'idle'}`).join(', ')); },
    element: wrap,
    idAt(cx, cy) { const h = at(cx, cy); return h ? h.id : null; },
  };
}
