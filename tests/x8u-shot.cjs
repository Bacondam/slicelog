/** 验证 X8U 模拟页：截图 + 点快捷按钮后截图 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = 9352;
const profile = path.join(root, '.edge-x8u-profile');
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map();
const events = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const waitEvent = n => new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', `${name}.png`), Buffer.from(s.data, 'base64'));
  console.log('saved tests/' + name + '.png');
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, screenWidth: 1280, screenHeight: 900, deviceScaleFactor: 1, mobile: false });

  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: 'http://127.0.0.1:8770/x8u' });
  await loaded;
  await delay(3200);
  await shot('x8u-1-shell');

  // 点「年度图表」
  await evaluate(`document.querySelector('[data-run="year"]').click()`);
  await delay(1200);
  await shot('x8u-2-year');

  // 点「小目标内联编辑」
  await evaluate(`document.querySelector('[data-run="subedit"]').click()`);
  await delay(1000);
  await shot('x8u-3-subedit');

  // 设置面板（备份 / 外观 / 清空 分组）
  await evaluate(`document.querySelector('[data-run="settings"]').click()`);
  await delay(800);
  await shot('x8u-4-settings');

  // 宽窄自适应（窄窗口）
  await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, screenWidth: 720, screenHeight: 900, deviceScaleFactor: 1, mobile: false });
  await delay(700);
  await shot('x8u-5-narrow');

  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
