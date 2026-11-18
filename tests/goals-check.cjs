/** 目标流程自检：分类筛选、小目标、完成移区、恢复、数据持久化 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const port = 9341;
const profile = path.join(root, '.edge-goals-profile');
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
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
function waitEvent(n) {
  return new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const assert = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); };
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', name + '.png'), Buffer.from(s.data, 'base64'));
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
    } else if (m.method && events.has(m.method)) {
      const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params));
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 452, height: 994, screenWidth: 452, screenHeight: 994, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge={getSafeInsets(){return '32,0,24,0';},exportBackup(){},setSystemBars(){},getScreenInfo(){return '';}};`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await evaluate('state = seedState(); saveState(); render();');
  await evaluate(`switchView('goals')`);
  await delay(500);

  // 0. v1.7：已完成默认折叠，且一条目标一行
  const folded = await evaluate(`(() => ({
    strips: document.querySelectorAll('.done-strip').length,
    doneCards: document.querySelectorAll('.goal-card.is-done').length,
    titles: [...document.querySelectorAll('.done-strip .ds-titles')].map(e => e.textContent.trim())
  }))()`);
  assert(folded.strips >= 1 && folded.doneCards === 0, '已完成目标未默认折叠');
  assert(folded.titles.length === folded.strips && folded.titles.every(t => t.length > 0), '折叠行没有显示大目标名称');
  await evaluate(`document.querySelector('[data-action="toggle-done-goals"]').click()`);
  await delay(400);

  // 1. 两区结构
  const layout = await evaluate(`(() => {
    const v = document.getElementById('view-goals');
    const secs = [...v.querySelectorAll('.goal-section .section-head h3')].map(h => h.textContent);
    const cards = [...v.querySelectorAll('.goal-card')];
    return {
      sections: secs,
      activeCards: v.querySelectorAll('.goal-section:first-of-type .goal-card:not(.is-done)').length,
      doneCards: v.querySelectorAll('.goal-card.is-done').length,
      filters: [...v.querySelectorAll('.filter-chip')].map(b => b.textContent.trim()),
      firstDone: cards.filter(c => c.classList.contains('is-done')).map(c => ({
        line: getComputedStyle(c.querySelector('.goal-title')).textDecorationLine,
        color: getComputedStyle(c.querySelector('.goal-title')).color,
        bg: getComputedStyle(c).backgroundColor,
        checked: !!c.querySelector('.goal-check.on')
      }))[0],
      pageWidth: document.documentElement.scrollWidth,
      vw: innerWidth
    };
  })()`);
  console.log('layout:', JSON.stringify(layout));
  assert(layout.sections.join(',') === '进行中,已完成', '缺少进行中/已完成两区');
  assert(layout.doneCards === 1, '已完成区没有自动收纳完成的目标');
  assert(layout.firstDone.line.includes('line-through'), '完成目标的标题没有删除线');
  assert(layout.firstDone.checked, '完成目标没有显示勾选');
  assert(layout.pageWidth <= layout.vw, `页面横向溢出：${layout.pageWidth} > ${layout.vw}`);
  await shot('goals-layout');

  // 2. 勾选小目标：已完成的取消、未完成的勾上
  const subBefore = await evaluate(`(() => {
    const g = state.goals.find(x => x.id === 'g1');
    return g.subtasks.map(t => t.done);
  })()`);
  await evaluate(`document.querySelector('[data-action="toggle-sub"][data-id="g1"]').click()`);
  await delay(300);
  const subAfter = await evaluate(`(() => {
    const g = state.goals.find(x => x.id === 'g1');
    return { flags: g.subtasks.map(t => t.done), stored: JSON.parse(localStorage.getItem('growth-os-v1')).goals.find(x => x.id === 'g1').subtasks.map(t => t.done) };
  })()`);
  console.log('subtask:', JSON.stringify({ subBefore, subAfter }));
  assert(subAfter.flags[0] !== subBefore[0], '勾选小目标没有生效');
  assert(JSON.stringify(subAfter.flags) === JSON.stringify(subAfter.stored), '小目标状态没有写入本地存储');

  // 3. 新增小目标（表单提交）
  await evaluate(`(() => {
    const form = document.querySelector('.sub-add[data-id="g2"]');
    form.querySelector('input').value = '每周一次长距离';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await delay(400);
  const added = await evaluate(`state.goals.find(x => x.id === 'g2').subtasks.map(t => t.title)`);
  console.log('subtasks g2:', JSON.stringify(added));
  assert(added.includes('每周一次长距离'), '新增小目标失败');

  // 4. 完成目标 → 移到已完成区（先勾完小目标，符合新的完成门禁）
  await evaluate(`(() => {
    const g = state.goals.find(x => x.id === 'g1');
    g.subtasks.forEach(t => { t.done = true; });
    saveState(); render();
  })()`);
  await evaluate(`document.querySelector('[data-action="toggle-goal"][data-id="g1"]').click()`);
  await delay(400);
  const completed = await evaluate(`(() => {
    const g = state.goals.find(x => x.id === 'g1');
    const v = document.getElementById('view-goals');
    const doneSec = [...v.querySelectorAll('.goal-section')][1];
    const strip = [...doneSec.querySelectorAll('.done-strip')].find(s => s.dataset.id === 'g1');
    const firstTitle = doneSec.querySelector('.goal-title');
    return {
      done: g.done,
      doneAt: !!g.doneAt,
      inDoneSection: !!strip,
      stripText: strip ? strip.querySelector('.ds-titles').textContent.trim() : '',
      struck: firstTitle ? getComputedStyle(firstTitle).textDecorationLine : '',
      activeCount: v.querySelectorAll('.goal-card:not(.is-done)').length,
      doneCount: v.querySelectorAll('.goal-card.is-done').length + doneSec.querySelectorAll('.done-strip').length
    };
  })()`);
  console.log('complete:', JSON.stringify(completed));
  assert(completed.done && completed.doneAt, '完成状态没有写入');
  assert(completed.inDoneSection, '完成的目标没有移到已完成区');
  assert(completed.stripText.length > 0, '已完成区没有显示该目标名称');
  assert(completed.struck.includes('line-through'), '已完成目标没有划线');
  assert(completed.doneCount === 2, `已完成区数量不对：${completed.doneCount}`);
  await shot('goals-completed');

  // 5. 恢复为进行中（先展开这条折叠行再点恢复）
  await evaluate(`document.querySelector('.done-strip[data-id="g1"]').click()`);
  await delay(300);
  await evaluate(`document.querySelector('[data-action="toggle-goal"][data-id="g1"]').click()`);
  await delay(400);
  const restored = await evaluate(`(() => {
    const g = state.goals.find(x => x.id === 'g1');
    const v = document.getElementById('view-goals');
    const activeSec = [...v.querySelectorAll('.goal-section')][0];
    return { done: g.done, backInActive: !!activeSec.querySelector('[data-action="toggle-goal"][data-id="g1"]'), doneCount: v.querySelectorAll('.goal-card.is-done').length };
  })()`);
  console.log('restore:', JSON.stringify(restored));
  assert(restored.done === false && restored.backInActive, '恢复为进行中失败');

  // 6. 分类筛选
  await evaluate(`document.querySelector('.filter-chip[data-cat="长期"]').click()`);
  await delay(350);
  const filtered = await evaluate(`(() => ({
    on: document.querySelector('.filter-chip.on').textContent.trim(),
    cards: [...document.querySelectorAll('#view-goals .goal-card .chip[class*="cat-"]')].map(c => c.textContent.trim())
  }))()`);
  console.log('filter:', JSON.stringify(filtered));
  assert(filtered.cards.length > 0 && filtered.cards.every(c => c === '长期'), '分类筛选没有过滤掉其他分类');
  await shot('goals-filter');

  // 7. 新建目标时填写小目标
  await evaluate(`document.querySelector('.filter-chip[data-cat="all"]').click()`);
  await delay(200);
  await evaluate(`document.querySelector('[data-action="add-goal"]').click()`);
  await delay(350);
  await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    f.querySelector('[name="title"]').value = '拿下驾照';
    f.querySelector('[name="category"]').value = '长期';
    f.querySelector('[name="subtasks"]').value = '科目一\\n科目二\\n科目三';
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await delay(450);
  const created = await evaluate(`(() => {
    const g = state.goals.find(x => x.title === '拿下驾照');
    return g ? { subs: g.subtasks.map(t => t.title), done: g.done } : null;
  })()`);
  console.log('created:', JSON.stringify(created));
  assert(created && created.subs.length === 3, '新建目标没有带上小目标');
  assert(created.done === false, '新建目标不应是已完成状态');

  console.log('PASS: 分类 / 小目标 / 完成移区 / 恢复 全部正常');
  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
