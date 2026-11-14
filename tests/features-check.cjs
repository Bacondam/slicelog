const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9336;
const profile = path.join(root, '.edge-features-profile');
const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let ws;
let nextId = 0;
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
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', name), Buffer.from(r.data, 'base64'));
}

async function main() {
  let pages;
  for (let i = 0; i < 100; i++) {
    try {
      pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (pages.length) break;
    } catch (_) {}
    await delay(100);
  }
  assert(pages && pages.length, '无法连接测试浏览器');
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    } else if (message.method && events.has(message.method)) {
      const list = events.get(message.method);
      events.delete(message.method);
      list.forEach(resolve => resolve(message.params));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 452, height: 994, screenWidth: 452, screenHeight: 994,
    deviceScaleFactor: 2, mobile: true
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, getScreenInfo(){return 'test';}, exportBackup(){}, setSystemBars(){}, openAppSettings(){} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate('state = seedState(); saveState(); render();');

  /* ---------- 1. 概览五张卡可点击 + 饼图详情 ---------- */
  const keys = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.stats .stat')];
    return { count: cards.length, actions: cards.map(c => c.dataset.stat), tag: cards[0] ? cards[0].tagName : '',
      dual: document.querySelectorAll('.stats .stat.dual .dual-cell[data-action="open-stat"]').length };
  })()`);
  assert(keys.count === 4, `概览统计卡数量异常：${keys.count}`);
  assert(keys.dual === 2, `概览「目标」双数据卡异常：${keys.dual}`);
  assert(keys.tag === 'BUTTON', '概览统计卡不是可点击按钮');
  const seen = [];
  for (const key of ['streak', 'goals', 'journal', 'finance']) {
    await evaluate(`switchView('dashboard'); document.querySelector('[data-action="open-stat"][data-stat="${key}"]').click();`);
    const info = await evaluate(`(() => {
      const root = document.getElementById('view-detail');
      return {
        view: currentView,
        title: document.getElementById('pageTitle').textContent,
        circles: root.querySelectorAll('.donut circle').length,
        legend: root.querySelectorAll('.donut-legend li').length,
        width: document.documentElement.scrollWidth
      };
    })()`);
    assert(info.view === 'detail', `${key}: 未进入详情页`);
    assert(info.circles >= 2 && info.legend >= 1, `${key}: 饼图未渲染 circles=${info.circles} legend=${info.legend}`);
    assert(info.width <= 452, `${key}: 详情页横向溢出 ${info.width}`);
    seen.push(`${key}(${info.legend}项)`);
    if (key === 'goals') await shot('detail-goals-452.png');
    if (key === 'finance') await shot('detail-finance-452.png');
  }
  assert(await evaluate(`document.querySelector('[data-action="detail-back"]').click(); currentView`) === 'dashboard', '详情页返回概览失败');
  results.push('概览五张卡跳转详情 + 饼图 ' + seen.join(' '));

  /* ---------- 2. 目标：小目标未完成时不能结束大目标 ---------- */
  await evaluate(`switchView('goals')`);
  await evaluate(`(() => {
    const g = state.goals.find(x => x.track === 'sub' && (x.subtasks || []).some(t => !t.done) && !x.done);
    window.__subId = g ? g.id : '';
    const card = document.querySelector('.goal-card[data-id="' + window.__subId + '"]');
    if (card) card.querySelector('[data-action="toggle-goal"]').click();
  })()`);
  const blocked = await evaluate(`(() => {
    const g = state.goals.find(x => x.id === window.__subId);
    return {
      done: g.done,
      toast: document.getElementById('toast').textContent,
      shake: !!document.querySelector('.goal-card.shake'),
      hint: !!document.querySelector('.goal-card .sub-note')
    };
  })()`);
  assert(blocked.done === false, '小目标未完成却完成了目标');
  assert(blocked.toast.includes('小目标'), `未给出提醒：${blocked.toast}`);
  assert(blocked.hint, '未显示「还剩 N 个小目标」提示');
  await shot('goal-blocked-452.png');

  /* 点一个就重建一次 DOM，每次重新取「还没勾的那条」 */
  await evaluate(`(() => {
    const gid = window.__subId;
    for (let i = 0; i < 30; i++) {
      const b = document.querySelector('.goal-card[data-id="' + gid + '"] .sub-item:not(.done) [data-action="toggle-sub"]');
      if (!b) break;
      b.click();
    }
  })()`);
  await evaluate(`document.querySelector('.goal-card[data-id="' + window.__subId + '"] [data-action="toggle-goal"]').click()`);
  assert(await evaluate(`state.goals.find(x => x.id === window.__subId).done`) === true, '小目标全部完成后仍无法完成目标');
  results.push('目标完成门禁：未完成小目标被拦截并提醒，完成后放行');

  /* ---------- 3. 习惯：周视图与每周重置 ---------- */
  await evaluate('state = seedState(); saveState(); switchView("habits")');
  const week = await evaluate(`(() => {
    const h1 = document.querySelectorAll('#view-habits .habit-item')[0];
    return {
      days: h1.querySelectorAll('.day').length,
      on: h1.querySelectorAll('.day.on').length,
      expected: habitWeekCount('h1', 0),
      title: document.querySelector('.week-nav strong').textContent,
      futureDisabled: [...document.querySelectorAll('#view-habits .day.future')].every(b => b.disabled)
    };
  })()`);
  assert(week.days === 7, '习惯页不是 7 天周视图');
  assert(week.on === week.expected, `本周打卡数不一致 UI=${week.on} 数据=${week.expected}`);
  assert(week.title === '本周', `周标题异常：${week.title}`);
  assert(week.futureDisabled, '未来日期未禁用');

  await evaluate(`(() => {
    state.habitLogs['h1'] = habitWeekDays(-1).map(d => toKey(d));
    saveState(); render();
  })()`);
  const reset = await evaluate(`(() => {
    const r = { current: habitWeekCount('h1', 0), prev: habitWeekCount('h1', -1) };
    r.uiOn = document.querySelectorAll('#view-habits .habit-item')[0].querySelectorAll('.day.on').length;
    return r;
  })()`);
  assert(reset.current === 0, `新一周未重置：本周仍有 ${reset.current} 次`);
  assert(reset.prev === 7, `上周记录丢失：${reset.prev}`);
  assert(reset.uiOn === 0, '本周格子未清空');

  await evaluate(`document.querySelector('[data-action="habit-week"][data-dir="-1"]').click()`);
  assert(await evaluate(`document.querySelectorAll('#view-habits .habit-item')[0].querySelectorAll('.day.on').length`) === 7, '切到上一周未显示历史记录');
  await shot('habits-week-452.png');
  await evaluate(`document.querySelector('[data-action="habit-week"][data-dir="0"]').click()`);
  assert(await evaluate(`document.querySelector('.week-nav strong').textContent`) === '本周', '回到本周失败');
  results.push('习惯周视图：周一重置、历史周可回看、未来日期禁用');

  /* ---------- 4. 记账：月度支出饼图 + 快速记一笔折叠 ---------- */
  await evaluate('state = seedState(); saveState(); financeMode = "month"; switchView("finance")');
  const pie = await evaluate(`(() => ({
    legend: document.querySelectorAll('#view-finance .donut-legend li').length,
    pct: [...document.querySelectorAll('#view-finance .donut-legend .dn-pct')].map(e => e.textContent),
    colors: [...document.querySelectorAll('#view-finance .donut-legend li i')].map(e => e.style.background),
    width: document.documentElement.scrollWidth
  }))()`);
  assert(pie.legend >= 2, `支出饼图分类过少：${pie.legend}`);
  assert(pie.pct.every(p => /%$/.test(p)), '饼图缺少百分比');
  assert(new Set(pie.colors).size >= 2, '饼图颜色未区分');
  assert(pie.width <= 452, `记账页横向溢出 ${pie.width}`);
  await shot('finance-pie-452.png');

  await evaluate(`document.querySelector('[data-action="toggle-quick"]').click()`);
  const collapsed = await evaluate(`(() => ({
    hidden: document.querySelector('.quick-body').hidden,
    flag: state.settings.finQuickCollapsed,
    stored: JSON.parse(localStorage.getItem('growth-os-v1')).settings.finQuickCollapsed,
    label: document.querySelector('[data-action="toggle-quick"]').textContent.trim()
  }))()`);
  assert(collapsed.hidden && collapsed.flag && collapsed.stored, '快速记一笔折叠状态未生效或未保存');
  await shot('finance-collapsed-452.png');
  await evaluate(`document.querySelector('[data-action="toggle-quick"]').click()`);
  assert(await evaluate(`document.querySelector('.quick-body').hidden`) === false, '快速记一笔无法展开');
  results.push('记账月度支出饼图（百分比+配色）与快速记一笔折叠');

  /* ---------- 5. 日记：右上角折叠 ---------- */
  await evaluate(`switchView('journal')`);
  const j = await evaluate(`(() => ({
    form: !!document.getElementById('journalForm'),
    entries: document.querySelectorAll('#view-journal .journal-entry').length,
    flag: state.settings.journalCollapsed
  }))()`);
  assert(j.form === false && j.flag === true, '进入日记页时写作区应默认收起');
  assert(j.entries >= 1, '折叠后日记列表丢失');
  await shot('journal-collapsed-452.png');
  await evaluate(`document.querySelector('[data-action="toggle-journal"]').click()`);
  assert(await evaluate(`!!document.getElementById('journalForm')`) === true, '日记写作区无法展开');
  results.push('日记写作区右上角折叠 / 展开，列表保持可见');

  console.log(JSON.stringify({ passed: results }, null, 2));
}

main().then(() => {
  ws && ws.close();
  browser.kill();
  process.exit(0);
}).catch(err => {
  console.error('FAILED:', err.message);
  ws && ws.close();
  browser.kill();
  process.exit(1);
});
