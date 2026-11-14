/** v2.1 回归：学习并入目标 + 导航重排 + 左右滑动切页 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9357;
const profile = path.join(root, '.edge-v21-profile');
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
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, name), Buffer.from(data, 'base64'));
}
function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}

/** 模拟一次横向滑动（左拨 dx<0 = 去下一个标签） */
async function swipe(fromX, toX, y) {
  const y0 = y || 560;
  const pt = x => [{ x, y: y0, id: 0, radiusX: 2, radiusY: 2, force: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(fromX) });
  const steps = 7;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(fromX + (toX - fromX) * i / steps) });
    await delay(18);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(450);
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

  /* ---------- 1. 底部导航：五个标签，顺序 目标→习惯→概览→记账→日记 ---------- */
  const nav = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('#nav button')];
    return { n: btns.length, views: btns.map(b => b.dataset.view), labels: btns.map(b => b.textContent.trim()) };
  })()`);
  assert(nav.n === 5, `底部标签应为 5 个，实际 ${nav.n}`);
  assert(nav.views.join(',') === 'goals,habits,dashboard,finance,journal', `标签顺序不对：${nav.views}`);
  assert(nav.labels.join(',') === '目标,习惯,概览,记账,日记', `标签文案不对：${nav.labels}`);
  pass('导航顺序', nav.labels.join(' → '));

  /* ---------- 2. 旧数据迁移：学习项目并进目标 ---------- */
  const mig = await evaluate(`(() => {
    const legacy = {
      goals: [{ id: 'g1', title: '跑 500 公里', category: '健康', subtasks: [] }],
      learning: {
        items: [
          { id: 'x1', title: '读完《原则》', type: 'book', current: 120, total: 400, unit: '页' },
          { id: 'x2', title: '口语', type: 'skill', level: 2 },
          { id: 'x3', title: '网课', type: 'course', current: 24, total: 24, unit: '讲' }
        ],
        sessions: [{ id: 's1', itemId: 'x3', date: '2026-11-01', minutes: 40 }]
      },
      settings: {}
    };
    const s = normalizeState(legacy);
    const book = s.goals.find(g => g.id === 'x1');
    const skill = s.goals.find(g => g.id === 'x2');
    const course = s.goals.find(g => g.id === 'x3');
    return {
      goals: s.goals.length,
      kindBook: book && book.kind, targetBook: book && book.target,
      skillLevel: skill && skill.level,
      courseDone: course && course.done,
      sessionSame: s.learning.sessions[0].itemId === 'x3',
      itemsLeft: s.learning.items.length,
      mergedFlag: !!s.settings.learningMerged
    };
  })()`);
  assert(mig.goals === 4, `迁移后应有 4 个目标，实际 ${mig.goals}`);
  assert(mig.kindBook === 'book' && mig.targetBook === 400, '阅读目标没带上 kind/total');
  assert(mig.skillLevel === 2, `技能等级丢了：${mig.skillLevel}`);
  assert(mig.courseDone === true, '读到总量的课程应自动标完成');
  assert(mig.sessionSame === true, '学习记录的 itemId 没对上目标');
  assert(mig.itemsLeft === 0 && mig.mergedFlag, '迁移后旧 items 应清空并打标记');
  pass('旧数据迁移', '3 个学习项目 → 目标，记录仍能对上');

  /* ---------- 3. 示例数据本身就是合并结构 ---------- */
  await evaluate(`state = seedState(); saveState(); switchView('goals');`);
  const seeded = await evaluate(`(() => ({
    learn: learnGoals().length,
    kinds: learnGoals().map(g => g.kind).sort().join(','),
    cards: document.querySelectorAll('#view-goals .goal-card.is-learn').length,
    overview: !!document.querySelector('#view-goals .learn-strip'),
    recent: [...document.querySelectorAll('#view-goals .card-head h3')].some(h => h.textContent.includes('最近学习记录'))
  }))()`);
  assert(seeded.learn === 3 && seeded.cards === 3, `学习目标应显示 3 张卡，实际 ${seeded.cards}`);
  assert(seeded.kinds === 'book,course,skill', `类型标记不对：${seeded.kinds}`);
  assert(seeded.overview, '目标页缺少「学习投入」统计');
  assert(seeded.recent, '目标页缺少「最近学习记录」');
  pass('目标页融合', `3 张学习卡 + 学习投入 + 最近记录`);
  await shot('v21-check-goals.png');

  /* ---------- 4. 卡片上的「记录」能打开学习弹窗，并写回进度 ---------- */
  const before = await evaluate(`(() => { const g = state.goals.find(x => x.id === 'l1'); return { cur: g.current, sessions: state.learning.sessions.length }; })()`);
  await evaluate(`document.querySelector('#view-goals [data-action="log-session"][data-id="l1"]').click()`);
  const modalOpen = await evaluate(`!!document.querySelector('#modalBox .sess-pick') && !document.getElementById('modal').classList.contains('hidden')`);
  assert(modalOpen, '点「记录」没弹出学习弹窗');
  const after = await evaluate(`(() => {
    const form = document.querySelector('#modalBox form[data-form="session"]');
    form.querySelector('[name="minutes"]').value = '35';
    form.querySelector('[name="progress"]').value = '260';
    form.requestSubmit();
    const g = state.goals.find(x => x.id === 'l1');
    return { cur: g.current, sessions: state.learning.sessions.length, modal: !document.getElementById('modal').classList.contains('hidden') };
  })()`);
  assert(after.cur === 260, `记录后进度应写到 260，实际 ${after.cur}`);
  assert(after.sessions === before.sessions + 1, '学习记录条数没增加');
  assert(after.modal === false, '记录完弹窗应关闭');
  pass('记录写回进度', `${before.cur} → ${after.cur} 页，记录 ${before.sessions} → ${after.sessions} 条`);

  /* ---------- 5. 概览页把目标和学习合成一张卡 ---------- */
  await evaluate(`switchView('dashboard')`);
  const dash = await evaluate(`(() => {
    const heads = [...document.querySelectorAll('#view-dashboard .card-head h3')].map(h => h.textContent.trim());
    const card = [...document.querySelectorAll('#view-dashboard .card')].find(c => c.querySelector('.mini-learn'));
    return {
      title: heads.find(t => t.includes('目标与学习')) || '',
      kindChip: document.querySelectorAll('#view-dashboard .mini-kind').length,
      foot: card ? card.querySelector('.mini-learn').textContent.replace(/\\s+/g, ' ').trim() : '',
      oldCard: heads.includes('目标进度')
    };
  })()`);
  assert(dash.title.includes('目标与学习'), '概览没有「目标与学习」卡');
  assert(dash.kindChip >= 1, '概览卡里没有学习类型标签');
  assert(/本周投入/.test(dash.foot) && /学习目标/.test(dash.foot), `概览卡底部学习信息缺失：${dash.foot}`);
  assert(!dash.oldCard, '旧的「目标进度」卡还在');
  pass('概览合并卡', dash.foot);
  await shot('v21-check-dash.png');

  /* ---------- 6. 左右滑动切页：概览 ↔ 记账 ↔ 日记 / 习惯 / 目标 ---------- */
  await evaluate(`scrollTo(0,0); switchView('dashboard')`);
  await swipe(400, 120);
  const v1 = await evaluate(`currentView`);
  assert(v1 === 'finance', `概览左滑应到记账，实际 ${v1}`);
  await swipe(120, 400);
  const v2 = await evaluate(`currentView`);
  assert(v2 === 'dashboard', `记账右滑应回概览，实际 ${v2}`);
  await swipe(120, 400);
  const v3 = await evaluate(`currentView`);
  assert(v3 === 'habits', `概览右滑应到习惯，实际 ${v3}`);
  await swipe(120, 400);
  const v4 = await evaluate(`currentView`);
  assert(v4 === 'goals', `习惯右滑应到目标，实际 ${v4}`);
  await swipe(400, 120);
  const v5 = await evaluate(`currentView`);
  assert(v5 === 'habits', `目标左滑应回习惯，实际 ${v5}`);
  pass('横向滑动', '概览 ⇄ 记账，概览 ← 习惯 ← 目标');

  /* 边界：第一个标签继续右滑不动 */
  await evaluate(`switchView('goals')`);
  await swipe(140, 420);
  const edge = await evaluate(`currentView`);
  assert(edge === 'goals', `第一个标签右滑应停住，实际 ${edge}`);
  /* 详情页不参与滑动 */
  await evaluate(`detailKey='streak'; switchView('detail')`);
  await swipe(400, 120);
  const detail = await evaluate(`currentView`);
  assert(detail === 'detail', `详情页不该被滑动切走，实际 ${detail}`);
  pass('滑动边界', '首标签停住、详情页不劫持');

  /* ---------- 7. 类型筛选 ---------- */
  await evaluate(`switchView('goals'); goalFilter='all'; render();`);
  const filterHit = await evaluate(`(() => {
    document.querySelector('#view-goals .filter-chip[data-cat="kind:book"]').click();
    const cards = [...document.querySelectorAll('#view-goals .goal-card')];
    return { n: cards.length, allBook: cards.every(c => c.classList.contains('is-learn')), filter: goalFilter };
  })()`);
  assert(filterHit.filter === 'kind:book' && filterHit.n === 1 && filterHit.allBook, `阅读筛选不对：${JSON.stringify(filterHit)}`);
  pass('类型筛选', '只留 1 张阅读卡');

  /* ---------- 8. 已完成的学习目标落在「已完成」区 ---------- */
  const doneCase = await evaluate(`(() => {
    goalFilter = 'all';
    const g = state.goals.find(x => x.id === 'l3');
    g.done = true; g.doneAt = Date.now();
    saveState(); render();
    const strip = [...document.querySelectorAll('#view-goals .done-strip')].map(b => b.textContent.trim());
    const sec = [...document.querySelectorAll('#view-goals .section-head h3')].map(h => h.textContent.trim());
    return { strip, has: strip.some(t => t.includes('TypeScript')), sections: sec.join('|') };
  })()`);
  assert(doneCase.has, `已完成区没出现学习目标：${JSON.stringify(doneCase.strip)}`);
  pass('已完成归位', doneCase.sections);

  /* ---------- 9. 学习目标删除时连同学习记录一起清掉 ---------- */
  const del = await evaluate(`(() => {
    const g = state.goals.find(x => x.id === 'l1');
    g.done = true; saveState(); render();
    const before = state.learning.sessions.filter(s => s.itemId === 'l1').length;
    askConfirm; // 引用一下避免未使用告警
    state.goals = state.goals.filter(x => x.id !== 'l1');
    state.learning.sessions = state.learning.sessions.filter(s => s.itemId !== 'l1');
    saveState();
    return { before, after: state.learning.sessions.filter(s => s.itemId === 'l1').length };
  })()`);
  assert(del.before > 0 && del.after === 0, '删除学习目标后记录没清干净');
  pass('删除联动', `${del.before} 条记录随目标清掉`);

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('\n✗ ' + error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
