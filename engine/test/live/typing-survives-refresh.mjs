// Live-refresh guard: type into forms, fire real engine events, check the text and focus survive.
import { spawn } from 'node:child_process';
const port = 9334; const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${process.argv[2]}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let ws;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise((r) => ws.addEventListener('open', r)); let id = 0; const pend = new Map(); ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (e) => (await send('Runtime.evaluate', { expression: `(async () => { ${e} })()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 900, deviceScaleFactor: 1, mobile: false });
const fire = async () => { for (let k = 0; k < 3; k++) { await fetch('http://127.0.0.1:48961/api/agents/reviewer', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }); await fetch('http://127.0.0.1:48961/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usage_low_power_pct: 90 }) }); await sleep(700); } await sleep(1500); };
const results = [];
const check = async (label, route, sel, focusIt = true) => {
  await send('Page.navigate', { url: `http://127.0.0.1:48961/?r=${Date.now()}#${route}` }); await sleep(3000);
  await js(`const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = (el.value || '') + ' typed-by-guard'; el.dispatchEvent(new Event('input', { bubbles: true })); window.__marker = 1;`);
  if (!focusIt) await js(`document.activeElement.blur();`);
  await fire();
  const r = await js(`const el = document.querySelector(${JSON.stringify(sel)}); return JSON.stringify({ kept: !!el && el.value.endsWith(' typed-by-guard'), focused: document.activeElement === el, sameDom: window.__marker === 1 && !!el && el.isConnected });`);
  results.push([label, JSON.parse(r)]);
};
await check('editor instructions (focused)', 'agents/researcher', '.agent-edit textarea[aria-label="Instructions"]');
await check('editor name (blurred, unsaved)', 'agents/researcher', '.agent-edit input[aria-label="Name"]', false);
await check('work-type editor name (focused)', 'workflow/new', '#wfname');
await check('add a goal on a project (blurred, unsaved)', 'workspaces/general', '#ot', false);
// work-type steps: add two steps, move the last one up, blur, fire events: the order must survive
await send('Page.navigate', { url: `http://127.0.0.1:48961/?r=${Date.now()}#workflow/new` }); await sleep(3000);
await js(`const add = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add step'); add.click(); add.click(); await new Promise((r) => setTimeout(r, 200)); const ups = [...document.querySelectorAll('button')].filter((b) => b.textContent === '↑'); ups[ups.length - 1].click(); document.activeElement.blur(); window.__steps = [...document.querySelectorAll('.stage-editor input')].map((i) => i.value).join(',');`);
await fire();
results.push(['work-type step reorder (blurred)', JSON.parse(await js(`return JSON.stringify({ kept: [...document.querySelectorAll('.stage-editor input')].map((i) => i.value).join(',') === window.__steps, steps: window.__steps });`))]);
console.log(JSON.stringify(results)); ws.close(); chrome.kill();
