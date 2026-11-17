/**
 * v2.17 回归：日记页新增「倒数日」
 * 1) 位置：倒数日卡在「写今日日记」表单之上
 * 2) 天数：还有 / 就是今天 / 已过 三种口径，及卡片高亮
 * 3) 增删改：弹窗表单保存、编辑、删除（走确认框）
 * 4) 排序：上移下移交换顺序，首尾按钮禁用
 * 5) 布局：411dp 宽不横向溢出，按钮不压文字
 * 6) 持久化：写完刷新还在
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9371;
const profile = path.join(root, '.edge-v217-profile');
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

  /* ---------- 1. 位置：倒数日在写日记之上 ---------- */
  const layout = await evaluate(`(() => {
    state = seedState(); saveState(); switchView('journal');
    state.settings.journalCollapsed = false; render();
    const cd = document.getElementById('view-journal').querySelector('.fold-card');
    const form = document.querySelector('[data-form="journal"]');
    return {
      hasCd: !!cd, hasForm: !!form,
      cdTop: cd ? Math.round(cd.getBoundingClientRect().top) : -1,
      formTop: form ? Math.round(form.getBoundingClientRect().top) : -1,
      title: cd ? cd.querySelector('h3').textContent.trim() : ''
    };
  })()`);
  assert(layout.hasCd, '日记页没有倒数日卡片');
  assert(layout.cdTop < layout.formTop, `倒数日应在写日记之上：${layout.cdTop} vs ${layout.formTop}`);
  pass('位置', `${layout.title} 在写今日日记之上（${layout.cdTop} < ${layout.formTop}）`);

  /* ---------- 2. 三种天数口径 ---------- */
  const items = await evaluate(`(() => {
    const today = todayKey();
    const d = n => toKey(addDays(new Date(), n));
    state.countdowns = [
      { id: 'a', title: '妈妈生日', date: d(21), note: '订蛋糕', createdAt: 1 },
      { id: 'b', title: '就是今天', date: today, note: '', createdAt: 2 },
      { id: 'c', title: '去年的事', date: d(-8), note: '', createdAt: 3 },
      { id: 'd', title: '很久以后', date: d(400), note: '', createdAt: 4 }
    ];
    saveState(); render();
    const list = [...document.querySelectorAll('.cd-item')];
    return list.map(el => ({
      title: el.querySelector('.cd-title').textContent.trim(),
      cap: (el.querySelector('.cd-cap') || {}).textContent,
      num: el.querySelector('.cd-num').textContent.trim(),
      today: el.classList.contains('is-today'),
      past: el.classList.contains('is-past'),
      numPx: parseFloat(getComputedStyle(el.querySelector('.cd-num')).fontSize)
    }));
  })()`);
  assert(items.length === 4, '应渲染 4 条，实际 ' + items.length);
  assert(items[0].cap === '还有' && items[0].num === '21', '未来日期应显示「还有 21」：' + JSON.stringify(items[0]));
  assert(items[1].today && items[1].num === '今天', '当天应高亮并显示「今天」：' + JSON.stringify(items[1]));
  assert(items[2].past && items[2].cap === '已过' && items[2].num === '8', '过去应显示「已过 8」：' + JSON.stringify(items[2]));
  assert(items[3].num === '400' && items[3].numPx < items[0].numPx, '三位以上天数应缩小字号防撑破');
  pass('天数口径', `还有 21 天 / 今天 / 已过 8 天 / 400 天自动缩字号`);

  /* ---------- 3. 新增（走弹窗表单） ---------- */
  const added = await evaluate(`(() => {
    document.querySelector('.cd-item [data-action="add-countdown"] , .fold-card [data-action="add-countdown"]').click();
    const f = document.querySelector('#modalBox form[data-form="countdown"]');
    if (!f) return { err: '没有弹出表单' };
    f.querySelector('input[name="title"]').value = '交房租';
    f.querySelector('input[name="date"]').value = toKey(addDays(new Date(), 5));
    f.querySelector('input[name="note"]').value = '记得转账';
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const list = [...document.querySelectorAll('.cd-item')];
    return { n: list.length, last: list[list.length - 1].querySelector('.cd-title').textContent.trim(),
             cap: list[list.length - 1].querySelector('.cd-num').textContent.trim(),
             saved: (JSON.parse(localStorage.getItem('growth-os-v1')).countdowns || []).length };
  })()`);
  assert(!added.err, added.err);
  assert(added.n === 5 && added.last === '交房租', '新增应追加到末尾：' + JSON.stringify(added));
  assert(added.cap === '5', '新条目天数应为 5，实际 ' + added.cap);
  assert(added.saved === 5, '新增应写进 localStorage');
  pass('新增', '「交房租」追加到末尾，还有 5 天');

  /* ---------- 4. 编辑 ---------- */
  const edited = await evaluate(`(() => {
    const last = [...document.querySelectorAll('.cd-item')].pop();
    last.querySelector('[data-action="edit-countdown"]').click();
    const f = document.querySelector('#modalBox form[data-form="countdown"]');
    const pre = f.querySelector('input[name="title"]').value;
    f.querySelector('input[name="title"]').value = '交水电费';
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const last2 = [...document.querySelectorAll('.cd-item')].pop();
    return { pre, now: last2.querySelector('.cd-title').textContent.trim(), n: document.querySelectorAll('.cd-item').length };
  })()`);
  assert(edited.pre === '交房租', '编辑弹窗应带出原标题，实际 ' + edited.pre);
  assert(edited.now === '交水电费' && edited.n === 5, '编辑后标题应更新且不新增条目：' + JSON.stringify(edited));
  pass('编辑', '标题改掉，条目数不变');

  /* ---------- 5. 排序 ---------- */
  const moved = await evaluate(`(() => {
    const before = [...document.querySelectorAll('.cd-title')].map(e => e.textContent.trim());
    const first = document.querySelector('.cd-item');
    const firstUp = first.querySelector('[data-action="move-countdown"][data-dir="-1"]');
    const lastDown = [...document.querySelectorAll('.cd-item')].pop().querySelector('[data-action="move-countdown"][data-dir="1"]');
    document.querySelectorAll('.cd-item')[2].querySelector('[data-action="move-countdown"][data-dir="-1"]').click();
    const after = [...document.querySelectorAll('.cd-title')].map(e => e.textContent.trim());
    return { before, after, firstUpDisabled: firstUp.disabled, lastDownDisabled: lastDown.disabled,
             stored: JSON.parse(localStorage.getItem('growth-os-v1')).countdowns.map(c => c.title) };
  })()`);
  assert(moved.firstUpDisabled, '第一条的上移按钮应禁用');
  assert(moved.lastDownDisabled, '最后一条的下移按钮应禁用');
  assert(moved.after[1] === moved.before[2] && moved.after[2] === moved.before[1], '上移应交换相邻两条：' + JSON.stringify(moved.after));
  assert(moved.stored.join(',') === moved.after.join(','), '顺序应写进 localStorage');
  pass('排序', `${moved.before[1]} ↔ ${moved.before[2]} 已交换，首尾按钮禁用`);

  /* ---------- 6. 布局不溢出 ---------- */
  const fit = await evaluate(`(() => {
    const view = document.getElementById('view-journal');
    const item = document.querySelector('.cd-item');
    const title = item.querySelector('.cd-title');
    const ops = item.querySelector('.cd-ops');
    const r = item.getBoundingClientRect(), tr = title.getBoundingClientRect(), or = ops.getBoundingClientRect();
    return {
      overflowX: view.scrollWidth - view.clientWidth,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      itemW: Math.round(r.width), titleW: Math.round(tr.width),
      overlap: Math.round(tr.right - or.left),
      opsW: Math.round(or.width),
      heights: [...document.querySelectorAll('.cd-item')].map(e => Math.round(e.getBoundingClientRect().height))
    };
  })()`);
  assert(fit.overflowX <= 1 && fit.docOverflow <= 1, `横向溢出：view ${fit.overflowX} / doc ${fit.docOverflow}`);
  assert(fit.overlap <= 0, '标题与操作按钮重叠了 ' + fit.overlap + 'px');
  assert(fit.titleW >= 90, '标题区只剩 ' + fit.titleW + 'px，太窄');
  pass('布局', `卡片 ${fit.itemW}px / 标题 ${fit.titleW}px / 按钮 ${fit.opsW}px / 高 ${fit.heights.join(',')}px`);

  await evaluate(`(() => { window.scrollTo(0, 0); switchView('journal'); })()`);
  await delay(300);
  await shot('v217-journal.png');

  /* ---------- 6b. 深色主题可读性 ---------- */
  const dark = await evaluate(`(() => {
    state.settings.theme = 'pine'; applyTheme('pine'); render();
    const item = document.querySelector('.cd-item');
    const num = item.querySelector('.cd-num');
    const title = item.querySelector('.cd-title');
    const todayItem = document.querySelector('.cd-item.is-today');
    return {
      cardBg: getComputedStyle(item).backgroundColor,
      numColor: getComputedStyle(num).color,
      titleColor: getComputedStyle(title).color,
      todayBg: todayItem ? getComputedStyle(todayItem).backgroundColor : '',
      todayNum: todayItem ? getComputedStyle(todayItem.querySelector('.cd-num')).color : '',
      theme: document.documentElement.dataset.theme
    };
  })()`);
  assert(dark.theme === 'pine', '主题没切到深色，实际 ' + dark.theme);
  assert(dark.cardBg !== dark.todayBg, '当天卡片应与普通卡片有区分：' + dark.todayBg);
  pass('深色主题', `底 ${dark.cardBg} / 天数 ${dark.numColor} / 当天 ${dark.todayNum}`);
  await delay(350);
  await shot('v217-journal-dark.png');
  await evaluate(`(() => { state.settings.theme = 'oat'; applyTheme('oat'); render(); })()`);
  await delay(200);

  /* ---------- 6c. 编辑弹窗 ---------- */
  await evaluate(`(() => { document.querySelector('.cd-item').click(); })()`);
  await delay(350);
  const modal = await evaluate(`(() => {
    const f = document.querySelector('#modalBox form[data-form="countdown"]');
    const r = f.getBoundingClientRect();
    return { open: !!f, label: f.querySelector('label').textContent.trim(),
             inputs: [...f.querySelectorAll('input')].map(i => i.type || 'text'),
             title: f.querySelector('input[name="title"]').value,
             bottom: Math.round(r.bottom), vh: window.innerHeight };
  })()`);
  assert(modal.open, '点卡片应打开编辑弹窗');
  assert(modal.inputs.includes('date'), '缺少日期输入');
  assert(modal.title === '妈妈生日', '编辑弹窗应带出原标题：' + modal.title);
  assert(modal.bottom <= modal.vh, `弹窗超出屏幕：${modal.bottom} > ${modal.vh}`);
  pass('编辑弹窗', `${modal.label} / 字段 ${modal.inputs.join('+')} / 底 ${modal.bottom}px`);
  await shot('v217-countdown-form.png');
  await evaluate(`(() => closeModal())()`);
  await delay(150);

  /* ---------- 7. 删除（确认框） ---------- */
  const del = await evaluate(`(() => {
    const n0 = document.querySelectorAll('.cd-item').length;
    const first = document.querySelector('.cd-item');
    const name = first.querySelector('.cd-title').textContent.trim();
    first.querySelector('[data-action="del-countdown"]').click();
    const box = document.getElementById('confirm');
    const shown = !box.classList.contains('hidden');
    document.getElementById('confirmOk').click();
    return { shown, n0, n1: document.querySelectorAll('.cd-item').length, name,
             msg: document.getElementById('confirmMsg').textContent };
  })()`);
  assert(del.shown, '删除应先弹确认框');
  assert(del.n1 === del.n0 - 1, `确认后应少一条：${del.n0} → ${del.n1}`);
  pass('删除', `「${del.name}」确认后移除`);

  /* ---------- 8. 持久化 ---------- */
  const persisted = await evaluate(`(() => JSON.parse(localStorage.getItem('growth-os-v1')).countdowns.length)()`);
  const loaded2 = waitEvent('Page.loadEventFired');
  await send('Page.reload');
  await loaded2;
  await delay(900);
  const reloaded = await evaluate(`(() => {
    switchView('journal');
    return { n: document.querySelectorAll('.cd-item').length,
             titles: [...document.querySelectorAll('.cd-title')].map(e => e.textContent.trim()) };
  })()`);
  assert(reloaded.n === persisted, `刷新后条数对不上：${reloaded.n} vs ${persisted}`);
  pass('持久化', `刷新后仍是 ${reloaded.n} 条：` + reloaded.titles.join(' / '));

  /* ---------- 9. 空态 ---------- */
  const empty = await evaluate(`(() => {
    state.countdowns = []; saveState(); render();
    const card = document.getElementById('view-journal').querySelector('.fold-card');
    const btn = card.querySelector('[data-action="add-countdown"]');
    return { text: card.textContent.replace(/\\s+/g, ' ').trim(), hasBtn: !!btn };
  })()`);
  assert(/还没有倒数日/.test(empty.text), '空态文案缺失');
  assert(empty.hasBtn, '空态里应有添加入口');
  pass('空态', empty.text.slice(0, 26) + '…');

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
