/**
 * v2.18 回归：目标分类收到「短期 / 长期」，新增「优先 / 普通」标签
 * 1) 分类只剩两个，默认长期
 * 2) 标签选择器两个选项，默认普通，点优先能写回
 * 3) 保存后卡片带 is-prio + 优先胶囊，普通卡没有
 * 4) 排序：优先整段置顶，同档按建立时间升序
 * 5) 分段顺序：优先 → 短期 → 长期
 * 6) 分类筛选仍然可用
 * 7) 老数据迁移：学习/健康/财务 等一律并成长期，标签补普通
 * 8) 已完成的目标不再显示优先胶囊
 * 9) 411dp 宽不横向溢出
 * 10) 刷新后标签还在
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9373;
const profile = path.join(root, '.edge-v218-profile');
const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
let ws, nextId = 0;
const pending = new Map(), events = new Map(), results = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
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
function pass(name, detail) {
  results.push({ name, ok: true });
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}
async function shot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, file), Buffer.from(r.data, 'base64'));
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
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const it = pending.get(m.id); pending.delete(m.id);
      m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result);
    } else if (m.method && events.has(m.method)) {
      const l = events.get(m.method); events.delete(m.method);
      l.forEach(r => r(m.params));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 411, height: 905, screenWidth: 411, screenHeight: 905, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = {
      getSafeInsets(){return '34,0,24,0';}, getScreenInfo(){return 'test';},
      exportBackup(){}, shareBackup(){}, autoBackup(){}, readAutoBackup(){return '';},
      setSystemBars(){}, openAppSettings(){}
    };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await delay(1100);

  /* ---------- 1. 分类只剩两个 ---------- */
  const form1 = await evaluate(`(() => {
    state.goals = []; saveState(); switchView('goals'); render();
    openGoalModal();
    const f = document.querySelector('form[data-form="goal"]');
    const cats = [...f.querySelectorAll('.cat-opt')].map(b => b.textContent.trim());
    const on = (f.querySelector('.cat-opt.on') || {}).textContent || '';
    const tags = [...f.querySelectorAll('.tag-opt')].map(b => b.querySelector('b').textContent.trim());
    const tagOn = (f.querySelector('.tag-opt.on b') || {}).textContent || '';
    const catHidden = f.querySelector('input[name="category"]').value;
    const tagHidden = f.querySelector('input[name="tag"]').value;
    return { cats, on, tags, tagOn, catHidden, tagHidden,
      cols: getComputedStyle(f.querySelector('.cat-picker')).gridTemplateColumns.split(' ').length,
      tagCols: getComputedStyle(f.querySelector('.tag-picker')).gridTemplateColumns.split(' ').length };
  })()`);
  assert(form1.cats.length === 2, `分类应只剩 2 个，实际 ${form1.cats.join('/')}`);
  assert(form1.cats.join('/') === '短期/长期', `分类文案不对：${form1.cats.join('/')}`);
  assert(form1.on === '长期' && form1.catHidden === '长期', '新建目标默认分类应为长期');
  assert(form1.cols === 2, '分类选择器应排 2 列');
  pass('分类收窄', form1.cats.join(' / ') + '，默认长期');

  /* ---------- 2. 标签选择器 ---------- */
  assert(form1.tags.join('/') === '优先/普通', `标签选项不对：${form1.tags.join('/')}`);
  assert(form1.tagOn === '普通' && form1.tagHidden === 'normal', '新建目标默认标签应为普通');
  assert(form1.tagCols === 2, '标签选择器应排 2 列');
  const tagClick = await evaluate(`(() => {
    document.querySelector('.tag-opt[data-tag="priority"]').click();
    const f = document.querySelector('form[data-form="goal"]');
    return { hidden: f.querySelector('input[name="tag"]').value,
      onCount: f.querySelectorAll('.tag-opt.on').length,
      onText: f.querySelector('.tag-opt.on b').textContent.trim() };
  })()`);
  assert(tagClick.hidden === 'priority' && tagClick.onCount === 1 && tagClick.onText === '优先',
    '点「优先」没写回隐藏字段：' + JSON.stringify(tagClick));
  pass('标签选择', `点优先 → 隐藏字段 ${tagClick.hidden}，选中态唯一`);
  await shot('v218-modal.png');

  /* ---------- 3. 保存后卡片标记 ---------- */
  const saved = await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    f.querySelector('input[name="title"]').value = '带优先标签的目标';
    f.querySelector('input[name="category"]').value = '短期';
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const g = state.goals[state.goals.length - 1];
    const card = document.querySelector('.goal-card[data-id="' + g.id + '"]');
    return { tag: g.tag, cat: g.category, isPrio: card.classList.contains('is-prio'),
      chip: !!card.querySelector('.chip.tag-prio'),
      catChip: card.querySelector('.chip.cat-0') ? card.querySelector('.chip.cat-0').textContent.trim() : '',
      bar: getComputedStyle(card, '::before').backgroundColor };
  })()`);
  assert(saved.tag === 'priority' && saved.cat === '短期', '保存后字段不对：' + JSON.stringify(saved));
  assert(saved.isPrio && saved.chip, '优先卡没有 is-prio 或优先胶囊');
  assert(saved.catChip === '短期', '分类胶囊没显示短期');
  pass('优先卡片样式', `is-prio + 优先胶囊 + 左侧色条 ${saved.bar}`);

  /* ---------- 4. 排序：优先置顶，同档按建立时间升序 ---------- */
  const order = await evaluate(`(() => {
    const now = Date.now(), day = 86400000;
    state.goals = [
      { id: 'a', title: '普通-早', category: '长期', tag: 'normal', createdAt: now - day * 9, done: false, subtasks: [] },
      { id: 'b', title: '优先-晚', category: '长期', tag: 'priority', createdAt: now - day * 3, done: false, subtasks: [] },
      { id: 'c', title: '优先-早', category: '长期', tag: 'priority', createdAt: now - day * 12, done: false, subtasks: [] },
      { id: 'd', title: '普通-晚', category: '长期', tag: 'normal', createdAt: now - day * 1, done: false, subtasks: [] }
    ];
    saveState(); render();
    return [...document.querySelectorAll('#view-goals .goal-card:not(.is-done) .goal-title')].map(el => el.textContent.trim());
  })()`);
  assert(order.join(',') === '优先-早,优先-晚,普通-早,普通-晚', '排序不对：' + order.join(','));
  pass('排序规则', '优先置顶，同档内越早建立越靠上 → ' + order.join(' / '));

  /* ---------- 5. 分段顺序：优先 → 短期 → 长期 ---------- */
  const sections = await evaluate(`(() => {
    const now = Date.now(), day = 86400000;
    state.goals = [
      { id: 'a', title: '长期普通', category: '长期', tag: 'normal', createdAt: now - day * 4, done: false, subtasks: [] },
      { id: 'b', title: '短期普通', category: '短期', tag: 'normal', createdAt: now - day * 5, done: false, subtasks: [] },
      { id: 'c', title: '优先目标', category: '长期', tag: 'priority', createdAt: now - day * 6, done: false, subtasks: [] }
    ];
    saveState(); render();
    return [...document.querySelectorAll('#view-goals .goal-group .group-head')].map(h => h.textContent.replace(/\\s+/g, '').trim());
  })()`);
  assert(sections.length === 3 && sections[0].startsWith('优先') && sections[1].startsWith('短期') && sections[2].startsWith('长期'),
    '分段顺序不对：' + sections.join(' | '));
  pass('分段顺序', sections.join(' → '));

  /* ---------- 6. 分类筛选 ---------- */
  const filter = await evaluate(`(() => {
    document.querySelector('.filter-chip[data-cat="短期"]').click();
    const heads = [...document.querySelectorAll('#view-goals .goal-group .group-head')].map(h => h.textContent.replace(/\\s+/g, '').trim());
    const cards = [...document.querySelectorAll('#view-goals .goal-card')].map(c => c.querySelector('.goal-title').textContent.trim());
    document.querySelector('.filter-chip[data-cat="all"]').click();
    return { heads, cards };
  })()`);
  assert(filter.cards.length === 1 && filter.cards[0] === '短期普通', '筛选短期后只剩短期目标：' + filter.cards.join(','));
  assert(!filter.heads.some(h => h.startsWith('长期')), '筛选短期后不该出现长期分段：' + filter.heads.join('|'));
  pass('分类筛选', `短期 → ${filter.cards.join(',')}`);

  /* ---------- 7. 老数据迁移 ---------- */
  const migrate = await evaluate(`(() => {
    const raw = {
      goals: [
        { id: 'x1', title: '老学习目标', category: '学习', createdAt: 1, subtasks: [] },
        { id: 'x2', title: '老健康目标', category: '健康', createdAt: 2, subtasks: [] },
        { id: 'x3', title: '老财务目标', category: '财务', createdAt: 3, subtasks: [] }
      ],
      archivedGoals: [{ id: 'x4', title: '归档的旧目标', category: '关系', archivedAt: 9, subtasks: [] }]
    };
    const s = normalizeState(raw);
    return {
      cats: s.goals.map(g => g.category + '/' + g.tag),
      arch: s.archivedGoals[0].category + '/' + s.archivedGoals[0].tag
    };
  })()`);
  assert(migrate.cats.every(x => x === '长期/normal'), '老目标没迁到长期/普通：' + migrate.cats.join(','));
  assert(migrate.arch === '长期/normal', '归档目标没迁对：' + migrate.arch);
  pass('老数据迁移', '学习/健康/财务/关系 → 长期 + 普通');

  /* ---------- 8. 已完成目标不显示优先胶囊 ---------- */
  const done = await evaluate(`(() => {
    state.goals = [{ id: 'z', title: '已完成优先目标', category: '短期', tag: 'priority', createdAt: 1, done: true, doneAt: Date.now() - 1000, subtasks: [] }];
    state.settings.doneOpen = { z: true };
    saveState(); render();
    const card = document.querySelector('.goal-card.is-done');
    return { chips: card.querySelectorAll('.chip.tag-prio').length, prioClass: card.classList.contains('is-prio') };
  })()`);
  assert(done.chips === 0, '已完成卡片不该再挂优先胶囊');
  pass('已完成卡片', '收起了优先标记，避免和「完成于」抢注意力');

  /* ---------- 9. 411dp 不横向溢出 ---------- */
  const fit = await evaluate(`(() => {
    const now = Date.now();
    state.goals = [
      { id: 'f1', title: '把这一年想读完的二十四本书全部读完并且每本写一篇读书笔记', category: '长期', tag: 'priority', createdAt: now - 1000, done: false, subtasks: [{ id: 's1', title: '第一本', done: false }] },
      { id: 'f2', title: '短期目标', category: '短期', tag: 'normal', createdAt: now, done: false, subtasks: [] }
    ];
    saveState(); switchView('goals'); render();
    const v = document.getElementById('view-goals');
    const card = v.querySelector('.goal-card');
    const top = card.querySelector('.goal-top');
    return { overflow: v.scrollWidth - v.clientWidth,
      topOverflow: top.scrollWidth - top.clientWidth,
      tall: Math.round(card.getBoundingClientRect().height) };
  })()`);
  assert(fit.overflow <= 1, '目标页横向溢出 ' + fit.overflow + 'px');
  assert(fit.topOverflow <= 1, '卡片顶部一行溢出 ' + fit.topOverflow + 'px');
  pass('窄屏排版', `411dp 无横向溢出，卡片高 ${fit.tall}px`);
  await shot('v218-goals.png');

  /* ---------- 10. 持久化 ---------- */
  const persisted = await evaluate(`(() => {
    const g = JSON.parse(localStorage.getItem('growth-os-v1')).goals.find(x => x.id === 'f1');
    return { tag: g.tag, cat: g.category, createdAt: g.createdAt > 0 };
  })()`);
  assert(persisted.tag === 'priority' && persisted.cat === '长期' && persisted.createdAt, '标签没写进本地存储');
  pass('持久化', '标签随目标一起落盘');

  console.log('\n  全部通过：' + results.length + ' 项');
}

main().then(() => {
  try { ws.close(); } catch (_) {}
  try { browser.kill(); } catch (_) {}
  process.exit(0);
}).catch(err => {
  console.error('\n  ✗ ' + err.message);
  try { ws.close(); } catch (_) {}
  try { browser.kill(); } catch (_) {}
  process.exit(1);
});
