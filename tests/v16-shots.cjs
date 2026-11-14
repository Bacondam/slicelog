/** 生成 v1.6 展示截图：多年度日记折叠、目标折叠、提醒弹层 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9338;
const profile = path.join(root, '.edge-v16-shot-profile');
const browser = spawn(edge, [
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
function waitEvent(n) { return new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); }); }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', name), Buffer.from(r.data, 'base64'));
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
    source: `window.AndroidBridge={getSafeInsets(){return '32,0,24,0';},getScreenInfo(){return 'test';},setSystemBars(){},openAppSettings(){},exportBackup(){},shareBackup(){},autoBackup(){},readAutoBackup(){return '';},setGoalReminders(){},notifyGoal(){}};`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded;
  await evaluate('document.fonts.ready');

  // 构造跨年度日记
  await evaluate(`(() => {
    state = seedState();
    const base = { mood: 4, energy: 4, good: '按时完成了计划里的三件事', improve: '下午注意力有点散', tomorrow: '先把最难的那件做掉', tags: '复盘,专注' };
    const mk = (date, extra) => Object.assign({ id: 'j' + date, date, createdAt: Date.now() }, base, extra || {});
    state.journal = [
      mk('2026-11-14'), mk('2026-11-11', { good: '跑步 5 公里' }), mk('2026-11-03'),
      mk('2026-10-27'), mk('2026-10-12'), mk('2026-09-18'),
      mk('2025-12-30'), mk('2025-12-11'), mk('2025-08-06'), mk('2024-05-20')
    ];
    state.journal[0].good = '把 OPES 报价单核对完了，客户确认价格';
    saveState(); switchView('journal');
  })()`);
  await delay(400);
  await evaluate(`window.scrollTo(0, 940)`);
  await delay(300);
  await shot('v16-journal-years.png');
  await evaluate(`document.querySelector('#view-journal .fold-head[data-action="fold-journal"][data-key="y:2025"]').click()`);
  await delay(350);
  await evaluate(`(() => { const h = document.querySelector('#view-journal .fold-head[data-action="fold-journal"][data-key="y:2025"]'); h.scrollIntoView({block:'center'}); })()`);
  await delay(300);
  await shot('v16-journal-2025.png');

  // 目标：部分已完成
  await evaluate(`(() => {
    state = seedState();
    state.goals.forEach((g, i) => { if (i === 1) { g.done = true; g.doneAt = Date.now() - 86400000; } });
    saveState(); switchView('goals');
  })()`);
  await delay(400);
  await evaluate(`(() => { const s = document.querySelector('.done-strip'); if (s) s.scrollIntoView({block:'center'}); })()`);
  await delay(300);
  await shot('v16-goals-strip.png');

  // 提醒弹层
  await evaluate(`(() => {
    const now = new Date();
    const due = new Date(now.getTime() + 42 * 60000);
    const p2 = n => String(n).padStart(2,'0');
    state.goals.push({ id:'g-remind', title:'提交季度复盘', category:'事业', current:6, target:10, unit:'页', deadline: toKey(due), dueTime: p2(due.getHours())+':'+p2(due.getMinutes()), note:'', subtasks:[], done:false, doneAt:null, remindedFor:null, createdAt: Date.now() });
    saveState(); switchView('goals');
    showReminder(state.goals[state.goals.length-1], 42*60000);
  })()`);
  await delay(500);
  await shot('v16-reminder-show.png');
  console.log('done');
  ws.close(); browser.kill(); process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); ws && ws.close(); browser.kill(); process.exit(1); });
