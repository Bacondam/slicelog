/** 预览页自检：确认 iframe 里的 App 收到模拟安全区并正常渲染 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = 9337;
const profile = path.join(root, '.edge-preview-profile');
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
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
    if (m.id && pending.has(m.id)) {
      const it = pending.get(m.id); pending.delete(m.id);
      m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result);
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8770/' });
  await delay(2200);

  const info = await evaluate(`(() => {
    const f = document.getElementById('app');
    const d = f.contentDocument;
    if (!d) return { error: '无法访问 iframe 文档' };
    const root = d.documentElement;
    const cs = getComputedStyle(root);
    const nav = d.querySelectorAll('#nav button');
    const logo = d.querySelector('.mobile-header .logo');
    return {
      ready: !!d.querySelector('.mobile-header'),
      view: d.querySelector('.view.active') ? d.querySelector('.view.active').id : null,
      sat: cs.getPropertyValue('--sat').trim(),
      sab: cs.getPropertyValue('--sab').trim(),
      navCount: nav.length,
      logoTop: logo ? Math.round(logo.getBoundingClientRect().top) : null,
      theme: root.dataset.theme,
      bridge: typeof f.contentWindow.AndroidBridge,
      scrollW: root.scrollWidth, innerW: f.contentWindow.innerWidth,
      scale: document.getElementById('wrap').style.transform
    };
  })()`);

  console.log(JSON.stringify(info, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', 'preview-shell.png'), Buffer.from(shot.data, 'base64'));

  // 交互：切深色主题 → 核对 App 内主题与状态栏图标反色
  await evaluate(`document.querySelector('.theme-card[data-theme="pine"]').click()`);
  await delay(700);
  const dark = await evaluate(`(() => {
    const f = document.getElementById('app');
    const d = f.contentDocument;
    return {
      theme: d.documentElement.dataset.theme,
      barFg: getComputedStyle(document.getElementById('screen')).getPropertyValue('--bar-fg').trim(),
      barColor: getComputedStyle(document.getElementById('screen')).getPropertyValue('--bar-color').trim()
    };
  })()`);
  console.log('dark:', JSON.stringify(dark));

  const darkShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', 'preview-shell-dark.png'), Buffer.from(darkShot.data, 'base64'));

  // 交互：切换虚拟按键 → 底部安全区应变为 48，且深色主题要能保持
  await evaluate(`document.querySelector('#navMode .chip[data-keys="1"]').click()`);
  await delay(1400);
  const keys = await evaluate(`(() => {
    const f = document.getElementById('app');
    const d = f.contentDocument;
    return {
      sab: getComputedStyle(d.documentElement).getPropertyValue('--sab').trim(),
      theme: d.documentElement.dataset.theme,
      navBottom: Math.round(d.querySelector('#nav').getBoundingClientRect().bottom),
      vh: f.contentWindow.innerHeight,
      keysVisible: !document.getElementById('keys').classList.contains('hidden'),
      stored: (function () { try { return JSON.parse(localStorage.getItem('growth-os-v1')).settings.theme; } catch (e) { return 'n/a'; } })()
    };
  })()`);
  console.log('keys:', JSON.stringify(keys));

  const keysShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', 'preview-shell-keys.png'), Buffer.from(keysShot.data, 'base64'));

  console.log('saved tests/preview-shell.png, tests/preview-shell-dark.png, tests/preview-shell-keys.png');

  // 窄面板布局（侧边栏预览常见宽度）
  await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(600);
  const narrow = await evaluate(`(() => ({
    theme: document.getElementById('app').contentDocument.documentElement.dataset.theme,
    scale: document.getElementById('wrap').style.transform,
    panelH: Math.round(document.querySelector('.panel').getBoundingClientRect().height),
    stageH: Math.round(document.querySelector('.stage').getBoundingClientRect().height)
  }))()`);
  console.log('narrow:', JSON.stringify(narrow));
  const narrowShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', 'preview-shell-narrow.png'), Buffer.from(narrowShot.data, 'base64'));
  console.log('saved tests/preview-shell-narrow.png');
  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
