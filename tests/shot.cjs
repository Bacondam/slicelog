/** 单张截图工具：node shot.cjs <outName> <width> <height> [scrollY] [view] */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const outName = process.argv[2] || 'shot';
const width = parseInt(process.argv[3] || '452', 10);
const height = parseInt(process.argv[4] || '994', 10);
const scrollY = parseInt(process.argv[5] || '0', 10);
const view = process.argv[6] || 'dashboard';
const action = process.argv[7] || '';
const port = 9336;
const profile = path.join(root, '.edge-shot-profile');
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map();
const events = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(n) {
  return new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

(async () => {
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (pages.length) break; } catch (_) {}
    await delay(100);
  }
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const it = pending.get(m.id); pending.delete(m.id); m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result); }
    else if (m.method && events.has(m.method)) { const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params)); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: 994, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, exportBackup(){}, setSystemBars(){}, getScreenInfo(){return '';} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate(`state = seedState(); saveState(); render();`);
  if (view !== 'dashboard') await evaluate(`switchView('${view}')`);
  if (action) await evaluate(action);
  await delay(600);
  if (scrollY) await evaluate(`scrollTo(0, ${scrollY})`);
  await delay(250);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', `${outName}.png`), Buffer.from(shot.data, 'base64'));
  console.log('saved tests/' + outName + '.png');
  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
