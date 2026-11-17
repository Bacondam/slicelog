const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const port = 9347, profile = path.join(__dirname, '..', '.edge-iostheme-profile');
const browser = spawn('C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,
   `--user-data-dir=${profile}`,'--hide-scrollbars','about:blank'], { stdio:'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0; const pending = new Map(), events = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const waitEvent = n => new Promise(r => { const l = events.get(n) || []; l.push(r); events.set(n, l); });
(async () => {
  let pages;
  for (let i = 0; i < 100; i++) { try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (pages.length) break; } catch (_) {} await delay(100); }
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const it = pending.get(m.id); pending.delete(m.id); m.error ? it.rej(new Error(JSON.stringify(m.error))) : it.res(m.result); }
    else if (m.method && events.has(m.method)) { const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params)); } });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: 'http://127.0.0.1:8773/index.html' });
  await loaded; await delay(2800);
  for (const id of ['paper', 'ink']) {
    await send('Runtime.evaluate', { expression: `(function(){var d=document.querySelector('[data-action="dismiss-demo"]');if(d)d.click();state.settings.cardFold=state.settings.cardFold||{};state.settings.cardFold['journal:countdown']=true;applyTheme('${id}');saveState();switchView('journal');render();scrollTo(0,0);})()` });
    await delay(900);
    const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(__dirname, 'ios-' + id + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', id);
  }
  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
