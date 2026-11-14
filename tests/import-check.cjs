// 校验「外部 json 直接导入」：模拟原生层调用 receiveImportFile
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const PORT = 9357;
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, '.edge-import-profile')}`, 'about:blank',
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map(), events = new Map();
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++nextId; pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
});
const waitEvent = n => new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); });
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };

const backup = {
  version: 1,
  goals: [
    { id: 'x1', title: '从微信导入的目标A', category: '学习', current: 0, target: 1, done: false, subtasks: [] },
    { id: 'x2', title: '从微信导入的目标B', category: '健康', current: 0, target: 1, done: true, doneAt: Date.now(), subtasks: [] },
  ],
  habits: [{ id: 'h1', name: '导入的习惯', icon: '🌱', days: {} }],
  journal: [
    { id: 'j1', date: '2026-11-10', mood: '🙂', good: '从备份恢复的日记', tags: '导入' },
    { id: 'j2', date: '2026-11-11', mood: '😀', good: '第二篇', tags: '' },
    { id: 'j3', date: '2026-11-12', mood: '🙂', good: '第三篇', tags: '' },
  ],
  finance: [
    { id: 'f1', date: '2026-11-01', type: 'expense', amount: 88, category: '餐饮', note: '导入' },
    { id: 'f2', date: '2026-11-02', type: 'income', amount: 1000, category: '工资', note: '导入' },
  ],
  settings: {},
};

(async () => {
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (pages.length) break; } catch (_) {}
    await delay(150);
  }
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const it = pending.get(m.id); pending.delete(m.id); m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result); }
    else if (m.method && events.has(m.method)) { const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params)); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 452, height: 994, screenWidth: 452, screenHeight: 994, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge={getSafeInsets(){return '32,0,24,0'},getScreenInfo(){return ''},exportBackup(){},setSystemBars(){},openAppSettings(){}};`,
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded; await delay(600);

  await ev(`state = seedState(); saveState(); render();`);
  const before = await ev(`({ goals: state.goals.length, journal: state.journal.length })`);

  // 1. 入口存在
  check('页面暴露 receiveImportFile', await ev(`typeof window.receiveImportFile === 'function'`));

  // 2. 非法内容要拦下
  await ev(`window.receiveImportFile('不是json', '坏文件.json')`); await delay(300);
  const badToast = await ev(`document.querySelector('#toast') ? document.querySelector('#toast').textContent : ''`);
  const badModal = await ev(`!document.querySelector('#confirm') || document.querySelector('#confirm').classList.contains('hidden')`);
  check('非备份文件被拒绝', badModal === true, badToast.trim());

  // 3. 正确备份弹出确认并带数量
  await ev(`window.receiveImportFile(${JSON.stringify(JSON.stringify(backup))}, '成长日志备份-2026-11-14.json')`);
  await delay(400);
  const modal = await ev(`(() => {
    const c = document.querySelector('#confirm');
    if (!c || c.classList.contains('hidden')) return { open: false };
    return { open: true, text: c.innerText.replace(/\\s+/g, ' ').slice(0, 160) };
  })()`);
  check('弹出了导入确认', modal.open === true, modal.text || '');
  check('确认文案含文件来源', /\\.json|备份/.test(modal.text || ''), '');
  check('确认文案列出各模块数量', /目标 2 个/.test(modal.text || '') && /日记 3 篇/.test(modal.text || '') && /账单 2 笔/.test(modal.text || ''), modal.text || '');

  // 4. 确认后覆盖
  await ev(`(() => { const b = [...document.querySelectorAll('#confirm button')].find(x => /覆盖导入/.test(x.textContent)); if (b) b.click(); })()`);
  await delay(500);
  const after = await ev(`({
    goals: state.goals.length, journal: state.journal.length, finance: state.finance.length, habits: state.habits.length,
    firstGoal: state.goals[0] ? state.goals[0].title : '',
    stored: JSON.parse(localStorage.getItem('growth-os-v1')).goals.length
  })`);
  check('数据已替换为目标备份', after.goals === 2 && after.journal === 3 && after.finance === 2 && after.habits === 1, JSON.stringify(after));
  check('内容正确落地', after.firstGoal === '从微信导入的目标A', after.firstGoal);
  check('已写入本地存储', after.stored === 2, String(after.stored));
  check('导入前数据确实不同', before.goals !== after.goals || before.journal !== after.journal, JSON.stringify(before));

  // 5. 错误回调
  await ev(`window.receiveImportError('没有读取该文件的权限')`); await delay(250);
  const errToast = await ev(`document.querySelector('#toast').textContent.trim()`);
  check('原生报错能提示到界面', /权限/.test(errToast), errToast);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(path.join(root, 'tests', 'import-done.png'), Buffer.from(shot.data, 'base64'));

  const failed = results.filter(x => !x).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  if (failed) process.exitCode = 1;
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 400));
