/** v2.2 回归：导航换位（习惯在前）/ 目标板块只留一个入口 / 学习体系整体下线 /
    目标只有「拆小目标」和「按数量」两种推进方式 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9361;
const profile = path.join(root, '.edge-v22-profile');
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
/** 读当前视图：网页重载后裸标识符取不到，直接看哪块 view 是 active */
const viewNow = () => evaluate(`(location.hash || '#dashboard').slice(1)`);

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}

/** 模拟一次横向滑动（dx<0 = 去下一个标签） */
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
  let loaded = waitEvent('Page.loadEventFired');
  /* 跳过 1.5 秒启动封面，否则触摸事件会被封面层吃掉 */
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await evaluate('document.fonts.ready');

  /* ---------- 1. 底部导航：五个标签，顺序 习惯→目标→概览→记账→日记 ---------- */
  const nav = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('#nav button')];
    return { n: btns.length, views: btns.map(b => b.dataset.view), labels: btns.map(b => b.textContent.trim()) };
  })()`);
  assert(nav.n === 5, `底部标签应为 5 个，实际 ${nav.n}`);
  assert(nav.views.join(',') === 'habits,goals,dashboard,finance,journal', `标签顺序不对：${nav.views}`);
  assert(nav.labels.join(',') === '习惯,目标,概览,记账,日记', `标签文案不对：${nav.labels}`);
  pass('导航顺序', nav.labels.join(' → '));

  /* ---------- 2. 旧数据迁移：kind 型目标 → 按数量；learning 整个字段清掉 ---------- */
  await evaluate(`(() => {
    localStorage.setItem('growth-os-v1', JSON.stringify({
      goals: [
        { id: 'x1', title: '读完某本书', category: '学习', kind: 'book', current: 120, target: 400, unit: '页', level: 0, done: false, subtasks: [] },
        { id: 'x2', title: '口语', category: '学习', kind: 'skill', current: 0, target: 5, unit: '', level: 4, done: false, subtasks: [] },
        { id: 'x3', title: '普通目标', category: '健康', current: 0, target: 1, done: false, subtasks: [{ id: 'a', title: '跑一次', done: false }] }
      ],
      archivedGoals: [{ id: 'x4', title: '归档的课程', category: '学习', kind: 'course', current: 3, target: 10, unit: '讲', archivedAt: Date.now() }],
      habits: [], habitLogs: {}, journal: [],
      learning: { items: [{ id: 'i1', title: '旧学习项目', type: 'book', current: 10, total: 50, unit: '页' }], sessions: [{ id: 's1', itemId: 'x1', date: '2026-11-01', minutes: 40 }] },
      finance: { transactions: [], budget: 0 },
      settings: {}
    }));
  })()`);
  loaded = waitEvent('Page.loadEventFired');
  await send('Page.reload');
  await loaded;
  await delay(200);

  const mig = await evaluate(`(() => {
    const s = state;
    const book = s.goals.find(g => g.id === 'x1');
    const skill = s.goals.find(g => g.id === 'x2');
    const plain = s.goals.find(g => g.id === 'x3');
    const arch = (s.archivedGoals || []).find(g => g.id === 'x4');
    return {
      bookTrack: book && book.track, bookKind: book && book.kind,
      bookSubs: book ? book.subtasks.length : 0,
      bookSubTitle: book && book.subtasks[0] ? book.subtasks[0].title : '',
      skillTrack: skill && skill.track, skillSubs: skill ? skill.subtasks.length : 0,
      skillDone: skill ? skill.subtasks.filter(t => t.done).length : 0,
      plainTrack: plain && plain.track,
      archTrack: arch && arch.track, archSubs: arch ? arch.subtasks.length : 0,
      merged: s.goals.some(g => g.title === '旧学习项目'),
      learningGone: !('learning' in s)
    };
  })()`);
  assert(mig.bookTrack === 'sub' && mig.bookKind === undefined, `阅读目标应转成小目标：${JSON.stringify(mig)}`);
  assert(mig.bookSubs === 1 && /120|400/.test(mig.bookSubTitle), `页数类目标应留一条带原始数字的小目标：${JSON.stringify(mig)}`);
  assert(mig.skillTrack === 'sub' && mig.skillSubs === 5 && mig.skillDone === 4, `技能等级应拆成 5 级小目标、已完成 4 级：${JSON.stringify(mig)}`);
  assert(mig.plainTrack === 'sub', `普通目标应保持小目标：${mig.plainTrack}`);
  assert(mig.archTrack === 'sub' && mig.archSubs === 10, `归档里的课程目标没转成小目标：${JSON.stringify(mig)}`);
  assert(mig.merged, '旧 learning.items 没并进目标');
  assert(mig.learningGone, 'state.learning 应彻底移除');
  pass('旧数据迁移', '老目标全部折成小目标，页数类保留原始数字，技能 5 级拆开，learning 字段移除');

  /* ---------- 3. 目标页：标题「目标」，顶部只有一个「+ 目标」 ---------- */
  await evaluate(`switchView('goals')`);
  const head = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('#view-goals .page-actions .chips button')];
    return {
      title: document.getElementById('pageTitle').textContent,
      btns: btns.map(b => ({ label: b.textContent.trim(), action: b.dataset.action })),
      hasLearnWord: /学习/.test(document.querySelector('#view-goals .page-actions').textContent)
    };
  })()`);
  assert(head.title === '目标', `目标页标题应为「目标」，实际「${head.title}」`);
  assert(head.btns.length === 1 && head.btns[0].label === '+ 目标', `顶部应只有一个「+ 目标」按钮：${JSON.stringify(head.btns)}`);
  assert(!head.hasLearnWord, '目标页顶部不该再出现「学习」入口');
  pass('单一入口', `「${head.title}」+ 一个「+ 目标」`);
  await shot('v22-goals.png');

  /* ---------- 4. 筛选 chip 只有分类，没有阅读 / 课程 / 技能 ---------- */
  const chips = await evaluate(`(() => {
    goalFilter = 'all'; render();
    return [...document.querySelectorAll('#view-goals .filter-chip')].map(c => c.dataset.cat);
  })()`);
  assert(!chips.some(c => c.startsWith('kind:')), `筛选里还有学习类型 chip：${chips}`);
  assert(chips[0] === 'all', '第一个筛选项应是「全部」');
  pass('分类筛选', chips.join(' / '));

  /* ---------- 5. 目标页不再有「学习投入」「最近学习记录」 ---------- */
  const leftovers = await evaluate(`(() => {
    const t = document.getElementById('view-goals').textContent;
    return { invest: t.includes('学习投入'), recent: t.includes('最近学习记录'), mins: /分钟/.test(t) && /连续/.test(t) };
  })()`);
  assert(!leftovers.invest && !leftovers.recent, `目标页还留着学习统计：${JSON.stringify(leftovers)}`);
  pass('学习统计下线', '目标页只剩目标本身');

  /* ---------- 6. 只剩一种推进方式：目标 + 小目标 ---------- */
  const cards = await evaluate(`(() => {
    const list = [...document.querySelectorAll('#view-goals .goal-card')];
    return {
      counts: list.length,
      anyCount: list.some(c => c.classList.contains('is-count')),
      anyUpdate: list.some(c => c.querySelector('[data-action="edit-progress"]')),
      stepTexts: list.map(c => (c.querySelector('.goal-prog .cnt') || {}).textContent || '').filter(Boolean)
    };
  })()`);
  assert(cards.counts >= 3, `目标卡片数量异常：${cards.counts}`);
  assert(!cards.anyCount, '还有按数量的目标卡');
  assert(!cards.anyUpdate, '还有「更新进度」入口');
  assert(cards.stepTexts.every(t => /\d+\/\d+ 步/.test(t.trim())), `进度文案应统一成「x/y 步」：${JSON.stringify(cards.stepTexts)}`);
  pass('单一推进方式', `${cards.counts} 张卡全部走小目标，进度写作「x/y 步」`);

  /* ---------- 7. 新建目标：弹窗里没有「按数量」，小目标直接写 ---------- */
  const created = await evaluate(`(() => {
    openGoalModal();
    const form = document.querySelector('#modal form[data-form="goal"]');
    const hasTrack = !!form.querySelector('[data-action="pick-track"], .track-seg, [name="track"]');
    const hasCount = !!form.querySelector('[data-track-panel="count"], [name="total"], [name="current"]');
    form.elements.title.value = '看完 12 部纪录片';
    form.elements.subtasks.value = '第 1 部\\n第 2 部\\n第 3 部';
    form.querySelector('button[type="submit"]').click();
    const g = state.goals.find(x => x.title === '看完 12 部纪录片');
    const card = [...document.querySelectorAll('#view-goals .goal-card')].find(x => x.textContent.includes('看完 12 部纪录片'));
    return {
      hasTrack, hasCount,
      saved: !!g, track: g && g.track, subs: g ? g.subtasks.length : 0,
      cardText: card ? card.querySelector('.goal-prog .cnt').textContent.trim() : '',
      modalClosed: document.getElementById('modal').classList.contains('hidden')
    };
  })()`);
  assert(!created.hasTrack && !created.hasCount, `弹窗里还留着按数量相关控件：${JSON.stringify(created)}`);
  assert(created.saved && created.track === 'sub' && created.subs === 3, `新建目标没存成小目标：${JSON.stringify(created)}`);
  assert(created.modalClosed, '保存后弹窗没关');
  assert(created.cardText.includes('0/3'), `卡片没显示 0/3 步：${created.cardText}`);
  pass('新建目标', `只填目标和三个小目标 · 卡片 0/3 步`);

  /* ---------- 8. 卡片上直接改小目标文字 ---------- */
  const inline = await evaluate(`(() => {
    const g = state.goals.find(x => x.title === '看完 12 部纪录片');
    const card = [...document.querySelectorAll('#view-goals .goal-card')].find(x => x.dataset.id === g.id);
    const btn = card.querySelector('[data-action="edit-sub"]');
    if (!btn) return { missing: true };
    btn.click();
    const inp = card.querySelector('.sub-edit');
    if (!inp) return { missing: true };
    inp.value = '第 1 部（已改名）';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const after = state.goals.find(x => x.id === g.id).subtasks[0].title;
    const card2 = [...document.querySelectorAll('#view-goals .goal-card')].find(x => x.dataset.id === g.id);
    return { missing: false, after, shown: card2.textContent.includes('已改名') };
  })()`);
  assert(!inline.missing, '小目标标题不能点开编辑');
  assert(inline.after === '第 1 部（已改名）' && inline.shown, `改名没保存：${JSON.stringify(inline)}`);
  pass('小目标内联编辑', '点文字变输入框，回车即存');

  /* ---------- 9. 拆小目标的目标：勾完才能完成 ---------- */
  const subFlow = await evaluate(`(() => {
    const g = state.goals.find(x => x.track === 'sub' && (x.subtasks || []).length);
    if (!g) return { skip: true };
    const card = [...document.querySelectorAll('#view-goals .goal-card')].find(c => c.dataset.id === g.id);
    const check = card ? card.querySelector('[data-action="toggle-goal"]') : null;
    const locked = check ? check.classList.contains('locked') : false;
    return { skip: false, title: g.title, left: goalSubStats(g).left, locked };
  })()`);
  assert(subFlow.skip || (subFlow.left > 0 ? subFlow.locked : true), `没勾完小目标却可以完成：${JSON.stringify(subFlow)}`);
  pass('完成校验', subFlow.skip ? '暂无样例，跳过' : `「${subFlow.title}」还剩 ${subFlow.left} 步，完成键锁住`);

  /* ---------- 10. 概览：双数据卡是「进行中 / 本月完成」 ---------- */
  await evaluate(`switchView('dashboard')`);
  const dash = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('#view-dashboard .stats .stat')].map(s => {
      const t = s.querySelector('.stat-top span');
      return t ? t.textContent.trim() : '';
    });
    const cells = [...document.querySelectorAll('#view-dashboard .stat.dual .dual-cell')].map(c => ({
      stat: c.dataset.stat,
      value: c.querySelector('strong').textContent.trim(),
      label: c.querySelector('span').textContent.trim()
    }));
    const dual = document.querySelector('#view-dashboard .stat.dual');
    const text = document.getElementById('view-dashboard').textContent;
    return { labels, cells, study: text.includes('本月学习'), miniKind: document.querySelectorAll('#view-dashboard .mini-kind').length,
      hint: dual && dual.querySelector('.hint') ? dual.querySelector('.hint').textContent.trim() : '' };
  })()`);
  assert(dash.labels.join(',') === '连续成长,目标,本月结余,日记累计', '统计卡顺序不对：' + dash.labels);
  assert(dash.cells.length === 2 && dash.cells.every(c => c.stat === 'goals'), '双数据卡不是两个目标数字：' + JSON.stringify(dash.cells));
  assert(dash.cells[0].label === '进行中' && dash.cells[1].label === '本月完成', '双数据卡标签不对：' + JSON.stringify(dash.cells));
  assert(dash.hint === '', `目标双数据卡不该再显示摘要行，实际「${dash.hint}」`);
  assert(!dash.study, '概览还有「本月学习」');
  assert(dash.miniKind === 0, '概览目标卡还有学习类型标签');
  pass('概览双数据卡', `${dash.cells[0].value} 进行中 · ${dash.cells[1].value} 本月完成`);
  await shot('v22-dash.png');

  /* ---------- 11. 左右滑动：习惯 ← 目标 ← 概览 → 记账 ---------- */
  await evaluate(`scrollTo(0,0); switchView('dashboard')`);
  await swipe(400, 120);
  const v1 = await viewNow();
  assert(v1 === 'finance', `概览左滑应到记账，实际 ${v1}`);
  await swipe(120, 400);
  const v2 = await viewNow();
  assert(v2 === 'dashboard', `记账右滑应回概览，实际 ${v2}`);
  await swipe(120, 400);
  const v3 = await viewNow();
  assert(v3 === 'goals', `概览右滑应到目标，实际 ${v3}`);
  /* 目标卡片上分布着输入框和按钮，挑进度条那一带滑，避免落在输入区 */
  await swipe(120, 400, 430);
  const v4 = await viewNow();
  assert(v4 === 'habits', `目标右滑应到习惯，实际 ${v4}`);
  await swipe(400, 120);
  const v5 = await viewNow();
  assert(v5 === 'goals', `习惯左滑应回目标，实际 ${v5}`);
  pass('横向滑动', '习惯 ← 目标 ← 概览 → 记账');

  /* 第一个标签继续右滑不动 */
  await evaluate(`switchView('habits')`);
  await swipe(140, 420);
  const edge = await viewNow();
  assert(edge === 'habits', `第一个标签右滑应停住，实际 ${edge}`);
  pass('滑动边界', '首标签停住');
  await shot('v22-habits.png');

  /* ---------- 12. 详情页不再有「本月学习」 ---------- */
  const detail = await evaluate(`(() => {
    const bad = [];
    ['streak', 'goals', 'finance', 'journal'].forEach(k => {
      detailKey = k; switchView('detail');
      if (/本月学习|学习投入|学习目标|最近学习|学习时长/.test(document.getElementById('view-detail').textContent)) bad.push(k);
    });
    return bad;
  })()`);
  assert(detail.length === 0, `详情页还有学习文案：${detail.join(',')}`);
  pass('详情页清理', '四张统计详情无学习残留');

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('\n✗ ' + error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
