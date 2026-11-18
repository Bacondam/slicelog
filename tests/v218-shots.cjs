/** v2.18 截图：目标页（浅色 / 深色 · 墨石）与编辑弹窗 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = 9375;
const profile = path.join(root, '.edge-v218shot-profile');
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map(), events = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const waitEvent = n => new Promise(r => { const l = events.get(n) || []; l.push(r); events.set(n, l); });
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const shot = async f => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, f), Buffer.from(r.data, 'base64'));
  console.log('shot', f);
};

(async () => {
  let pages;
  for (let i = 0; i < 100; i++) { try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (pages.length) break; } catch (_) {} await delay(100); }
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const it = pending.get(m.id); pending.delete(m.id); m.error ? it.rej(new Error(JSON.stringify(m.error))) : it.res(m.result); }
    else if (m.method && events.has(m.method)) { const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params)); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge={getSafeInsets(){return '34,0,24,0';},getScreenInfo(){return 'test';},exportBackup(){},shareBackup(){},autoBackup(){},readAutoBackup(){return '';},setSystemBars(){},openAppSettings(){}};`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: 'http://127.0.0.1:8770/app?sat=32&sab=24' });
  await loaded; await delay(2400);

  await evaluate(`(function(){
    var d=document.querySelector('[data-action="dismiss-demo"]'); if(d) d.click();
    state=normalizeState(seedState()); state.seeded=false; saveState();
    applyTheme('oat'); switchView('goals'); render(); scrollTo(0,0);
  })()`);
  await delay(700);
  await shot('v218-goals-light.png');

  /* 编辑弹窗：选中「优先」，鼠标挪开避免 hover 干扰 */
  await evaluate(`(function(){
    var cards=[...document.querySelectorAll('#view-goals .goal-card')];
    cards[0].querySelector('[data-action="edit-goal"]').click();
    var b=document.querySelector('.tag-opt[data-tag="priority"]'); if(b) b.click();
    if (window.__cdpMove) {}
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await delay(500);
  await shot('v218-modal-light.png');
  await evaluate(`closeModal()`);

  /* 深色 · 墨石 */
  await evaluate(`(function(){ applyTheme('ink'); switchView('goals'); render(); scrollTo(0,0); })()`);
  await delay(700);
  await shot('v218-goals-ink.png');

  /* 纸白 · 墨：确认次强调金在极简主题里不刺眼 */
  await evaluate(`(function(){ applyTheme('paper'); render(); scrollTo(0,0); })()`);
  await delay(700);
  await shot('v218-goals-paper.png');

  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
