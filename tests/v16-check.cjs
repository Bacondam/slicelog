/** v1.6 新增功能回归：概览精简 / ⊕折叠 / 日记年月折叠 / 目标折叠 / 到期提醒 / 备份分享 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9337;
const profile = path.join(root, '.edge-v16-profile');
const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
let ws, nextId = 0;
const pending = new Map();
const events = new Map();
const results = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(name) {
  return new Promise(resolve => {
    const list = events.get(name) || [];
    list.push(resolve);
    events.set(name, list);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', name), Buffer.from(r.data, 'base64'));
}

async function main() {
  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (pages.length) break; } catch (_) {}
    await delay(100);
  }
  assert(pages && pages.length, '无法连接测试浏览器');
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 452, height: 994, screenWidth: 452, screenHeight: 994, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__calls = [];
      window.AndroidBridge = {
        getSafeInsets(){return '32,0,24,0';},
        getScreenInfo(){return 'test';},
        setSystemBars(){}, openAppSettings(){},
        exportBackup(j,n){ __calls.push('export:'+n); window.__exported=j; },
        shareBackup(j,n){ __calls.push('share:'+n); window.__shared=j; },
        autoBackup(j){ window.__auto=j; },
        readAutoBackup(){ return window.__auto || ''; },
        setGoalReminders(j){ window.__alarms=j; },
        notifyGoal(t,m){ window.__notified=t+'|'+m; }
      };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate('state = seedState(); saveState(); render();');

  /* ---------- 1. 概览：顶部只留日期、无 hero、无近14天学习 ---------- */
  const dash = await evaluate(`(() => ({
    title: document.getElementById('pageTitle').textContent,
    sub: document.getElementById('pageSub').textContent,
    subHidden: document.getElementById('pageSub').hidden,
    hero: document.querySelectorAll('#view-dashboard .hero').length,
    study: document.getElementById('view-dashboard').textContent.includes('近 14 天学习'),
    stats: document.querySelectorAll('#view-dashboard .stats .stat').length,
    titleSize: getComputedStyle(document.getElementById('pageTitle')).fontSize,
    width: document.documentElement.scrollWidth
  }))()`);
  assert(/月\d+日/.test(dash.title), `顶部标题不是日期：${dash.title}`);
  assert(dash.title.includes('周'), `日期缺少星期：${dash.title}`);
  assert(dash.sub.length >= 4 && !dash.subHidden, '顶部未显示每日一句：' + dash.sub);
  assert(dash.hero === 0, '概览仍有 hero 卡片');
  assert(dash.study === false, '概览仍有「近 14 天学习」');
  assert(dash.stats === 5, `统计卡数量异常：${dash.stats}`);
  assert(dash.width <= 452, `概览横向溢出 ${dash.width}`);
  await shot('v16-dashboard.png');
  results.push(`概览精简：顶部仅日期「${dash.title}」(${dash.titleSize})，移除学习图表与 hero`);

  /* ---------- 2. 日记：年 / 月折叠 ---------- */
  await evaluate('switchView("journal")');
  const jfold = await evaluate(`(() => {
    const heads = [...document.querySelectorAll('#view-journal .fold-head')];
    const years = heads.filter(h => /年$/.test(h.querySelector('.fname').textContent.trim()));
    const months = heads.filter(h => /月$/.test(h.querySelector('.fname').textContent.trim()));
    return {
      years: years.length, months: months.length,
      firstYearText: years[0] ? years[0].textContent.replace(/\\s+/g,' ').trim() : '',
      entries: document.querySelectorAll('#view-journal .journal-entry').length,
      toggleIco: !!document.querySelector('[data-action="toggle-journal"] .pm-chev'),
      width: document.documentElement.scrollWidth
    };
  })()`);
  assert(jfold.years >= 1, '日记没有按年折叠');
  assert(jfold.months >= 1, '日记没有按月折叠');
  assert(jfold.entries >= 1, '日记条目未渲染');
  assert(jfold.toggleIco === true, '日记折叠按钮缺少箭头图标');
  await shot('v16-journal-fold.png');

  // 收起年份 → 条目消失；再展开恢复
  await evaluate(`document.querySelector('#view-journal .fold-head[data-action="fold-journal"]').click()`);
  const afterFold = await evaluate(`(() => ({
    open: state.settings.journalFold,
    sub: document.querySelectorAll('#view-journal .fold-sub').length,
    entries: document.querySelectorAll('#view-journal .journal-entry').length
  }))()`);
  assert(Object.keys(afterFold.open).length >= 1, '折叠状态未记录');
  await evaluate(`document.querySelectorAll('#view-journal .fold-head').forEach(h => { if (h.getAttribute('aria-expanded') === 'false') h.click(); })`);
  const reOpened = await evaluate(`document.querySelectorAll('#view-journal .journal-entry').length`);
  assert(reOpened >= 1, '展开后日记条目未恢复');
  results.push(`日记按年/月折叠（年 ${jfold.years} 组、月 ${jfold.months} 组），折叠状态可记忆`);

  /* ---------- 3. 目标：已完成折叠成一行 ---------- */
  await evaluate('state = seedState(); saveState(); switchView("goals")');
  const beforeStrip = await evaluate(`(() => ({
    doneCards: document.querySelectorAll('#view-goals .goal-section:nth-of-type(2) .goal-card').length,
    strip: document.querySelectorAll('.done-strip').length,
    stripText: document.querySelector('.done-strip .ds-titles') ? document.querySelector('.done-strip .ds-titles').textContent : ''
  }))()`);
  assert(beforeStrip.strip >= 1, '已完成目标未折叠成一行');
  assert(beforeStrip.doneCards === 0, '折叠状态下仍显示已完成卡片');
  assert(beforeStrip.stripText.length > 0, '折叠行没有显示大目标名称');
  await shot('v16-goals-done-collapsed.png');

  await evaluate(`document.querySelector('[data-action="toggle-done-goals"]').click()`);
  const expanded = await evaluate(`(() => ({
    cards: document.querySelectorAll('#view-goals .goal-section:nth-of-type(2) .goal-card').length,
    flag: state.settings.doneOpen && Object.values(state.settings.doneOpen).some(v => v === true)
  }))()`);
  assert(expanded.cards >= 1 && expanded.flag, '点击折叠行无法展开已完成目标');
  await shot('v16-goals-done-open.png');
  await evaluate(`document.querySelector('[data-action="toggle-done-goals"]').click()`);
  results.push('已完成目标默认折叠为一行、只显示大目标，可手动展开');

  /* ---------- 4. 目标到期前 1 小时提醒 ---------- */
  const remind = await evaluate(`(() => {
    const now = new Date();
    const due = new Date(now.getTime() + 30 * 60000);
    const p2 = n => String(n).padStart(2,'0');
    state.goals.push({
      id: 'g-remind', title: '提交季度复盘', category: '事业', current: 0, target: 10, unit: '页',
      deadline: toKey(due), dueTime: p2(due.getHours()) + ':' + p2(due.getMinutes()),
      note: '', subtasks: [], done: false, doneAt: null, remindedFor: null, createdAt: Date.now()
    });
    saveState(); render();
    const hit = checkGoalReminders();
    return {
      hit,
      shown: document.getElementById('remind').classList.contains('show'),
      msg: document.getElementById('remindMsg').textContent,
      left: document.getElementById('remindLeft').textContent,
      notified: window.__notified || '',
      alarms: window.__alarms || ''
    };
  })()`);
  assert(remind.hit === true, '1 小时内到期未触发提醒');
  assert(remind.shown, '提醒弹层未显示');
  assert(/提交季度复盘/.test(remind.msg), `提醒内容缺目标名：${remind.msg}`);
  assert(/还有 \d+ 分钟/.test(remind.msg), `提醒未显示剩余时间：${remind.msg}`);
  assert(/截止/.test(remind.left), '提醒未显示截止信息');
  assert(remind.notified.length > 0, '未调用系统通知');
  assert(JSON.parse(remind.alarms || '[]').length >= 1, '未同步系统闹钟');
  await shot('v16-reminder.png');

  const dup = await evaluate(`(() => { const again = checkGoalReminders(true); return { again, flag: state.goals.find(g => g.id === 'g-remind').remindedFor }; })()`);
  assert(dup.again === false, '同一截止时间重复提醒');
  assert(dup.flag, '未记录已提醒标记');
  await evaluate(`document.querySelector('[data-action="remind-go"]').click()`);
  assert(await evaluate(`document.getElementById('remind').classList.contains('show')`) === false, '提醒弹层无法关闭');
  results.push('目标到期前 1 小时弹窗 + 系统通知 + 闹钟，且不重复提醒');

  /* ---------- 5. 备份分享与自动存档 ---------- */
  await evaluate(`document.getElementById('shareBtn').click()`);
  const share = await evaluate(`(() => ({
    calls: window.__calls.slice(),
    name: (window.__calls.find(c => c.startsWith('share:')) || '').slice(6),
    body: window.__shared || ''
  }))()`);
  assert(share.calls.some(c => c.startsWith('share:')), '分享备份未调用原生接口');
  assert(/\.json$/.test(share.name), `分享文件名不是 json：${share.name}`);
  assert(share.body.includes('"goals"'), '分享内容不是完整存档');

  await evaluate(`document.getElementById('restoreBtn').click()`);
  const restore = await evaluate(`(() => ({
    autoSaved: !!(window.__auto && window.__auto.includes('"goals"')),
    confirm: !document.getElementById('confirm').classList.contains('hidden')
  }))()`);
  assert(restore.autoSaved, '自动存档未写入');
  assert(restore.confirm, '恢复自动存档未弹出确认');
  await shot('v16-restore.png');
  await evaluate(`document.getElementById('confirmCancel').click()`);
  results.push('分享备份到微信（json 文件 + 系统分享）+ 自动存档与恢复入口');

  console.log(JSON.stringify({ passed: results }, null, 2));
}

main().then(() => { ws && ws.close(); browser.kill(); process.exit(0); })
  .catch(err => { console.error('FAILED:', err.message); ws && ws.close(); browser.kill(); process.exit(1); });
