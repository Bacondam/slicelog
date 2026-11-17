/** v2.10 改动截图：一次会话连拍多张 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const port = 9341;
const profile = path.join(root, '.edge-v210-profile');
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
async function shot(name, scrollY = 0) {
  if (scrollY) await evaluate(`scrollTo(0, ${scrollY})`);
  await delay(320);
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
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, screenWidth: 414, screenHeight: 896, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, exportBackup(){}, setSystemBars(){}, getScreenInfo(){return '';}, notifyStatus(){return '{"notify":"granted","exact":true,"battery":false,"api":33}';} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate('state = seedState(); saveState(); render();');
  await delay(500);

  // 1 概览：已无成长热力图
  await evaluate(`switchView('dashboard')`);
  await shot('v210-1-dash', 0);
  await evaluate(`scrollTo(0, document.querySelector('#view') ? 0 : 0)`);
  await shot('v210-2-dash-bottom', 620);

  // 2 记账：年度图（带金额标注）
  await evaluate(`switchView('finance'); financeMode='year'; render();`);
  await delay(400);
  const yy = await evaluate(`(() => { const el = document.querySelector('.y-chart'); return el ? Math.max(0, el.getBoundingClientRect().top + scrollY - 190) : 0; })()`);
  await shot('v210-3-year', Math.round(yy));

  // 3 记账：快捷表单（日期三段 + 常用备注）
  await evaluate(`state.settings.finNotes = ['油费','电话费','停车费','午餐']; financeMode='month'; state.settings.finQuickCollapsed=false; render();`);
  await delay(400);
  const fy = await evaluate(`(() => { const el = document.querySelector('.date-pick'); return el ? Math.max(0, el.getBoundingClientRect().top + scrollY - 240) : 0; })()`);
  await shot('v210-4-form', Math.round(fy));

  // 4 目标：小目标卡片内联编辑
  await evaluate(`switchView('goals')`);
  await delay(400);
  await evaluate(`(() => { const b = document.querySelector('.sub-title-btn'); if (b) b.click(); })()`);
  await delay(350);
  const gy = await evaluate(`(() => { const el = document.querySelector('.sub-edit'); return el ? Math.max(0, el.getBoundingClientRect().top + scrollY - 300) : 0; })()`);
  await shot('v210-5-subedit', Math.round(gy));

  // 5 设置面板（提醒已在 v2.15 移除，这里改拍设置面板）
  await evaluate(`(() => { const b = document.getElementById('mobileSettings'); if (b) b.click(); })()`);
  await delay(450);
  await shot('v210-6-settings', 0);

  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
