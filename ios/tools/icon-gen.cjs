/** 生成 PWA 图标：node tools/icon-gen.cjs */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'icons');
const port = 9351;
const sizes = [1024, 512, 192, 180, 167];
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, '.edge-icon-profile')}`,
  '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map(), events = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(n) {
  return new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); });
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
    if (m.id && pending.has(m.id)) {
      const it = pending.get(m.id); pending.delete(m.id);
      m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result);
    } else if (m.method && events.has(m.method)) {
      const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params));
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');

  for (const size of sizes) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, screenWidth: size, screenHeight: size, deviceScaleFactor: 1, mobile: false
    });
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url: pathToFileURL(path.join(root, 'tools', 'icon-src.html')).href });
    await loaded;
    await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
    await delay(180);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    const file = path.join(outDir, size === 180 ? 'icon-180.png' : `icon-${size}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('saved', path.relative(root, file), `${size}x${size}`);
  }
  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; })
  .finally(() => setTimeout(() => browser.kill(), 300));
