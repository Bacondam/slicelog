/**
 * README 截图生成：一次会话连拍 6 张，统一 452×994 @2x（输出 904×1988）
 * 概览 / 数据详情 / 目标 / 记账 / 日记 / 设置面板
 * 用法：node tests/docs-shots.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
const port = 9371;
const profile = path.join(root, '.edge-docs-profile');
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
  await delay(360);
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(s.data, 'base64'));
  const h = await evaluate('document.documentElement.scrollWidth + "x" + innerWidth');
  console.log(`saved docs/screenshots/${name}.png  (${h})`);
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
  await send('Emulation.setDeviceMetricsOverride', { width: 452, height: 994, screenWidth: 452, screenHeight: 994, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = {
      getSafeInsets(){return '34,0,24,0';}, getScreenInfo(){return '452x994';},
      exportBackup(){}, shareBackup(){}, setSystemBars(){}, openAppSettings(){},
      autoBackup(){}, readAutoBackup(){return '';}
    };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await evaluate('document.fonts.ready');
  /* 用内置示例数据，和首次打开应用时的样子一致 */
  await evaluate('state = seedState(); saveState(); render();');
  await delay(600);
  /* 截图里不要那条「已准备示例数据」的提示条 */
  await evaluate(`(() => { const b = document.querySelector('[data-action="dismiss-demo"]'); if (b) b.click(); })()`);
  await delay(300);

  await evaluate(`switchView('dashboard'); scrollTo(0,0);`);
  await shot('dashboard');

  await evaluate(`detailKey='finance'; switchView('detail'); scrollTo(0,0);`);
  await shot('detail');

  await evaluate(`switchView('goals'); scrollTo(0,0);`);
  await shot('goals');

  await evaluate(`switchView('finance'); financeMode='month'; scrollTo(0,0); render();`);
  await shot('finance');

  await evaluate(`switchView('journal'); scrollTo(0,0);`);
  await shot('journal');

  /* 设置面板：手机端从右上角弹出 */
  await evaluate(`switchView('dashboard'); scrollTo(0,0); if(!document.querySelector('.sidebar-foot').classList.contains('mobile-open')) document.getElementById('mobileSettings').click();`);
  await shot('settings');

  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
