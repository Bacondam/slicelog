/** v1.7 回归：已完成目标一条一行 + ⊕/⊖ 折叠按钮（目标/日记/记账） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9342;
const profile = path.join(root, '.edge-v17-profile');
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
function pass(name, detail) {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
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
  await evaluate(`state = seedState(); saveState(); render();`);

  // 造 4 个已完成目标
  await evaluate(`
    state.goals.forEach(g => { g.done = true; g.doneAt = Date.now(); });
    state.settings.doneOpen = {};
    switchView('goals');
  `);
  await delay(400);

  /* ---------- 1. 一条目标一行 ---------- */
  const base = await evaluate(`(() => {
    const strips = [...document.querySelectorAll('.done-strip')];
    return {
      strips: strips.length,
      titles: strips.map(s => s.querySelector('.ds-titles').textContent.trim()),
      goalTitles: state.goals.map(g => g.title),
      circles: strips.map(s => {
        const c = s.querySelector('.collapse-btn.pm');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), hasPlus: !c.classList.contains('minus') };
      }),
      headBtn: !!document.querySelector('[data-action="toggle-done-goals"] .pm-chev'),
      headMinus: document.querySelector('[data-action="toggle-done-goals"]').classList.contains('minus'),
      overflow: document.documentElement.scrollWidth
    };
  })()`);
  assert(base.strips === 4, `已完成目标应一条一行共 4 条，实际 ${base.strips}`);
  assert(base.titles.length === 4 && new Set(base.titles).size === 4, '已完成目标标题没有拆开：' + JSON.stringify(base.titles));
  assert(base.titles.every(t => !t.includes('·')), '标题仍被拼接在一条里');
  assert(base.circles.every(c => c && c.w === 26 && c.h === 26), '⊕ 按钮尺寸不是 26px：' + JSON.stringify(base.circles));
  assert(base.circles.every(c => c.hasPlus), '折叠状态应显示加号');
  assert(base.headBtn && !base.headMinus, '区块标题按钮应为折叠箭头');
  assert(base.overflow <= 452, `页面出现横向溢出：${base.overflow}`);
  pass('已完成目标一条一行', '4 条，每行右侧箭头 26×26');

  /* ---------- 2. 单条点击展开 / 收起 ---------- */
  const firstId = await evaluate(`state.goals[0].id`);
  await evaluate(`document.querySelector('.done-strip').click()`);
  await delay(300);
  const one = await evaluate(`(() => ({
    cards: document.querySelectorAll('.done-list .goal-card').length,
    strips: document.querySelectorAll('.done-strip').length,
    cardId: document.querySelector('.done-list .goal-card') ? document.querySelector('.done-list .goal-card .goal-top .collapse-btn.pm') !== null : false,
    minusBtn: !!document.querySelector('.done-list .goal-card [data-action="toggle-done-one"]'),
    saved: !!state.settings.doneOpen['${firstId}'],
    stored: JSON.parse(localStorage.getItem('growth-os-v1')).settings.doneOpen['${firstId}']
  }))()`);
  assert(one.cards === 1 && one.strips === 3, `单条展开异常：卡片 ${one.cards}，折叠 ${one.strips}`);
  assert(one.minusBtn, '展开后的卡片缺少 ⊖ 收起按钮');
  assert(one.stored === true, '展开状态没有写入本地存档');
  pass('单条展开 / 状态记住', '展开 1 条，其余 3 条保持折叠');

  // 点击卡片里的 ⊖ 收起
  await evaluate(`document.querySelector('.done-list .goal-card [data-action="toggle-done-one"]').click()`);
  await delay(300);
  const back = await evaluate(`({ cards: document.querySelectorAll('.done-list .goal-card').length, strips: document.querySelectorAll('.done-strip').length })`);
  assert(back.cards === 0 && back.strips === 4, '点 ⊖ 没有收起：' + JSON.stringify(back));
  pass('卡片内 ⊖ 可收起', '回到 4 条折叠行');

  /* ---------- 3. 区块 ⊕ / ⊖ 全部展开与收起 ---------- */
  await evaluate(`document.querySelector('[data-action="toggle-done-goals"]').click()`);
  await delay(300);
  const allOpen = await evaluate(`(() => ({
    cards: document.querySelectorAll('.done-list .goal-card').length,
    strips: document.querySelectorAll('.done-strip').length,
    head: document.querySelector('[data-action="toggle-done-goals"]').classList.contains('minus')
  }))()`);
  assert(allOpen.cards === 4 && allOpen.strips === 0, '点 ⊕ 没有全部展开：' + JSON.stringify(allOpen));
  assert(allOpen.head, '全部展开后区块按钮应变为 ⊖');
  await evaluate(`document.querySelector('[data-action="toggle-done-goals"]').click()`);
  await delay(300);
  const allClosed = await evaluate(`({ cards: document.querySelectorAll('.done-list .goal-card').length, strips: document.querySelectorAll('.done-strip').length })`);
  assert(allClosed.cards === 0 && allClosed.strips === 4, '点 ⊖ 没有全部收起：' + JSON.stringify(allClosed));
  pass('区块 ⊕ / ⊖ 全部展开收起', '4 ↔ 0 条');

  /* ---------- 4. 新完成的目标默认折叠 ---------- */
  await evaluate(`
    const g = state.goals[0];
    g.done = false; saveState(); render();
    document.querySelector('.goal-card [data-action="toggle-goal"]').click();
  `);
  await delay(300);
  const fresh = await evaluate(`({
    strips: document.querySelectorAll('.done-strip').length,
    open: !!state.settings.doneOpen[state.goals[0].id]
  })`);
  assert(fresh.open === false, '新完成的目标不应自动展开');
  pass('新完成目标默认折叠', `折叠行 ${fresh.strips} 条`);

  /* ---------- 5. 日记：年 / 月 ⊕ ⊖ ---------- */
  await evaluate(`switchView('journal')`);
  await delay(400);
  const fold = await evaluate(`(() => {
    const heads = [...document.querySelectorAll('.fold-head')];
    const sizes = heads.map(h => {
      const c = h.querySelector('.collapse-btn.pm');
      const r = c.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), minus: c.classList.contains('minus') };
    });
    return {
      count: heads.length,
      sizes,
      firstOpen: heads[0].classList.contains('open'),
      arrowLeft: document.querySelectorAll('.fold-head .arrow').length
    };
  })()`);
  assert(fold.count >= 2, '日记归档折叠项数量异常：' + fold.count);
  assert(fold.arrowLeft === 0, '日记折叠还残留 ▸ 箭头');
  assert(fold.sizes.every(s => s.w >= 28 && s.h >= 28), '日记 ⊕ 尺寸过小：' + JSON.stringify(fold.sizes));
  assert(fold.sizes[0].minus === fold.firstOpen, '年折叠的加/减号与展开状态不一致');
  await evaluate(`document.querySelectorAll('.fold-head')[0].click()`);
  await delay(300);
  const foldToggled = await evaluate(`({
    open: document.querySelectorAll('.fold-head')[0].classList.contains('open'),
    minus: document.querySelectorAll('.fold-head')[0].querySelector('.collapse-btn.pm').classList.contains('minus')
  })`);
  assert(!foldToggled.open && !foldToggled.minus, '日记年折叠点击后没有切换：' + JSON.stringify(foldToggled));
  pass('日记 年/月 使用 ⊕ ⊖', `${fold.count} 个折叠项，点击可切换`);

  /* ---------- 6. 记账快速记一笔 ⊕ ⊖ ---------- */
  await evaluate(`switchView('finance')`);
  await delay(400);
  const quickBtn = await evaluate(`(() => {
    const b = document.querySelector('[data-action="toggle-quick"]');
    const r = b.getBoundingClientRect();
    const body = document.querySelector('.quick-body');
    return { w: Math.round(r.width), h: Math.round(r.height), minus: b.classList.contains('minus'), hidden: body.hasAttribute('hidden'), bodyH: Math.round(body.getBoundingClientRect().height) };
  })()`);
  assert(quickBtn.w === 30 && quickBtn.h === 30, '记账 ⊕ 尺寸异常：' + JSON.stringify(quickBtn));
  assert(quickBtn.minus === !quickBtn.hidden, '记账 ⊕/⊖ 状态与实际展开不一致');
  await evaluate(`document.querySelector('[data-action="toggle-quick"]').click()`);
  await delay(250);
  const quickAfter = await evaluate(`(() => { const b = document.querySelector('.quick-body'); return { hidden: b.hasAttribute('hidden'), bodyH: Math.round(b.getBoundingClientRect().height), minus: document.querySelector('[data-action="toggle-quick"]').classList.contains('minus') }; })()`);
  assert(quickAfter.bodyH === 0, '收起后表单区域仍然占位：' + quickAfter.bodyH);
  assert(quickAfter.minus === !quickAfter.hidden, '合并快捷键点击后状态不同步');
  pass('记账「快速记一笔」⊕ ⊖', `30×30，点击切换正常`);

  /* ---------- 7. 日记写作区折叠仍可用 ---------- */
  await evaluate(`switchView('journal')`);
  await delay(350);
  const jr0 = await evaluate(`({ collapsed: !!state.settings.journalCollapsed, form: !!document.getElementById('journalForm'), minus: document.querySelector('[data-action="toggle-journal"]').classList.contains('minus') })`);
  assert(jr0.collapsed === true && jr0.form === false && jr0.minus === false, '进入日记页应默认收起：' + JSON.stringify(jr0));
  await evaluate(`document.querySelector('[data-action="toggle-journal"]').click()`);
  await delay(250);
  const jr1 = await evaluate(`({ collapsed: !!state.settings.journalCollapsed, form: !!document.getElementById('journalForm'), minus: document.querySelector('[data-action="toggle-journal"]').classList.contains('minus') })`);
  assert(jr1.collapsed === false && jr1.form === true && jr1.minus === true, '点击箭头后应展开写作区：' + JSON.stringify(jr1));
  await evaluate(`document.querySelector('[data-action="toggle-journal"]').click()`);
  await delay(250);
  const jr2 = await evaluate(`({ collapsed: !!state.settings.journalCollapsed, form: !!document.getElementById('journalForm') })`);
  assert(jr2.collapsed === true && jr2.form === false, '再点一次应收回：' + JSON.stringify(jr2));
  pass('日记写作区折叠', '进来自动收起，点箭头展开，再点收回');

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}：${results.length} 项`);
}

main().catch(err => { console.error('✗ ' + err.message); process.exitCode = 1; })
  .finally(() => setTimeout(() => browser.kill(), 300));
