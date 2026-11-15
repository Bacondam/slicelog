/** v2.0.A 回归：品牌更名 / 概览双数据卡 / 记账合并卡 / 日记全部收起 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9359;
const profile = path.join(root, '.edge-v20a-profile');
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
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, getScreenInfo(){return 'test';}, exportBackup(){}, setSystemBars(){}, openAppSettings(){} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate('state = seedState(); saveState(); render();');

  /* ---------- 1. 品牌：人生切片 / Slicelog ---------- */
  const brand = await evaluate(`(() => {
    const head = document.querySelector('.mobile-header .brand');
    const side = document.querySelector('.sidebar .brand');
    return {
      title: document.title,
      head: head ? { h1: head.querySelector('h1').textContent.trim(), sub: head.querySelector('.sub').textContent.trim() } : null,
      side: side ? { h1: side.querySelector('h1').textContent.trim(), sub: side.querySelector('.sub').textContent.trim() } : null
    };
  })()`);
  assert(brand.title.includes('人生切片') && brand.title.includes('Slicelog'), '页面标题未改为人生切片 · Slicelog：' + brand.title);
  assert(brand.head && brand.head.h1 === '人生切片', '顶部标题不是「人生切片」：' + JSON.stringify(brand.head));
  assert(brand.head.sub === 'Slicelog', '顶部副标题不是 Slicelog：' + brand.head.sub);
  assert(brand.side.h1 === '人生切片' && brand.side.sub === 'Slicelog', '侧栏品牌未同步：' + JSON.stringify(brand.side));
  pass('品牌更名', `${brand.head.h1} · ${brand.head.sub}（标题栏 / 侧栏一致）`);

  /* ---------- 2. 概览：四张卡，目标用一张双数据卡（v2.2 起不再有学习） ---------- */
  await evaluate(`switchView('dashboard')`);
  await delay(150);
  const dash = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#view-dashboard .stats .stat')];
    const active = state.goals.filter(g => !g.done).length;
    const monthPrefix = todayKey().slice(0, 7);
    const monthDone = state.goals.filter(g => g.done && g.doneAt && toKey(new Date(g.doneAt)).slice(0, 7) === monthPrefix).length;
    const dual = document.querySelector('#view-dashboard .stats .stat.dual');
    const cells = dual ? [...dual.querySelectorAll('.dual-cell')] : [];
    return {
      n: cards.length,
      labels: cards.map(c => (c.querySelector('.stat-top span') || {}).textContent.trim()),
      dualCells: cells.map(c => ({
        stat: c.dataset.stat,
        value: c.querySelector('strong').textContent.trim(),
        label: c.querySelector('span').textContent.trim()
      })),
      expectActive: active + '个',
      expectMonthDone: monthDone + '个',
      hintText: dual ? (dual.querySelector('.hint') ? dual.querySelector('.hint').textContent.trim() : '') : '',
      financeIndex: cards.findIndex(c => c.textContent.includes('本月结余')),
      journalIndex: cards.findIndex(c => c.textContent.includes('日记累计')),
      width: document.documentElement.scrollWidth
    };
  })()`);
  assert(dash.n === 4, `概览统计卡应为 4 张，实际 ${dash.n}`);
  assert(dash.labels.join(',') === '连续成长,目标,本月结余,日记累计', '统计卡顺序不对：' + dash.labels);
  assert(dash.dualCells.length === 2, '「目标」不是双数据卡');
  assert(dash.dualCells[0].label === '进行中' && dash.dualCells[0].value === dash.expectActive, `进行中目标数不对：${dash.dualCells[0].value} ≠ ${dash.expectActive}`);
  assert(dash.dualCells[1].stat === 'goals' && dash.dualCells[1].label === '本月完成' && dash.dualCells[1].value === dash.expectMonthDone, `本月完成目标数不对：${dash.dualCells[1].value} ≠ ${dash.expectMonthDone}`);
  assert(dash.hintText === '', `目标双数据卡不该再显示摘要行，实际「${dash.hintText}」`);
  assert(dash.financeIndex === 2 && dash.journalIndex === 3, '账单卡没有上移到第二行');
  assert(dash.width <= 452, `概览横向溢出 ${dash.width}`);

  /* 双数据卡两格都能进目标分析页 */
  const jump = [];
  for (const key of ['goals', 'goals']) {
    await evaluate(`switchView('dashboard'); document.querySelector('#view-dashboard .stat.dual .dual-cell[data-stat="${key}"]').click();`);
    const info = await evaluate(`(() => ({ view: currentView, detail: detailKey, title: document.getElementById('pageTitle').textContent }))()`);
    assert(info.view === 'detail' && info.detail === key, `${key}: 双数据卡点击未进入对应详情`);
    jump.push(info.title);
  }
  pass('概览双数据卡', `${dash.dualCells[0].value} 进行中 · ${dash.dualCells[1].value} 本月完成，进入「${jump[0]}」`);
  await evaluate(`switchView('dashboard')`);
  await delay(120);
  await shot('v20a-dashboard.png');

  /* ---------- 3. 记账：流水 + 支出分类合成一张卡，本月小结已移除 ---------- */
  await evaluate(`financeMode = 'month'; financeFilter = 'all'; finTab = 'tx'; switchView('finance')`);
  await delay(150);
  const fin = await evaluate(`(() => {
    const view = document.getElementById('view-finance');
    const card = view.querySelector('[data-key="fin:txs"]').closest('.fold-card');
    const panels = [...card.querySelectorAll('.fin-panel')];
    const txPanel = card.querySelector('.fin-panel[data-panel="tx"]');
    const catPanel = card.querySelector('.fin-panel[data-panel="cat"]');
    return {
      cards: view.querySelectorAll('.fold-card').length,
      hasSummary: view.textContent.includes('本月小结'),
      tabs: [...card.querySelectorAll('.fin-tabs button')].map(b => b.textContent.trim()),
      panels: panels.map(p => p.dataset.panel),
      txVisible: !!txPanel && !txPanel.hidden,
      catVisible: !!catPanel && !catPanel.hidden,
      rows: txPanel.querySelectorAll('.tx-row').length,
      catRows: catPanel.querySelectorAll('.cat-row').length,
      catNames: catPanel.querySelectorAll('.cat-name svg').length,
      filter: !!txPanel.querySelector('[data-fin-filter]'),
      headerBtn: !!view.querySelector('.page-actions .fin-add'),
      width: document.documentElement.scrollWidth
    };
  })()`);
  assert(fin.cards === 1, `记账页月度应有 1 张折叠卡（合并后），实际 ${fin.cards}`);
  assert(!fin.hasSummary, '「本月小结」仍然存在');
  assert(fin.tabs.join(',') === '流水,支出分类', '合并卡缺少分段切换：' + fin.tabs);
  assert(fin.panels.join(',') === 'tx,cat', '合并卡面板结构不对：' + fin.panels);
  assert(fin.txVisible && !fin.catVisible, '默认应显示流水面板');
  assert(fin.rows > 0 && fin.catRows > 0, `流水 ${fin.rows} 行 / 分类 ${fin.catRows} 行`);
  assert(fin.catNames > 0, '支出分类行缺少线性图标');
  assert(fin.filter, '流水面板缺少收支筛选');
  assert(fin.headerBtn, '记账页缺少「记一笔」按钮');
  assert(fin.width <= 452, `记账页横向溢出 ${fin.width}`);
  pass('记账合并卡', `1 张卡内含「${fin.tabs.join(' / ')}」两个页签：${fin.rows} 笔流水 + ${fin.catRows} 个分类，本月小结已移除`);

  /* 切到分类页签：面板互换，且不重新渲掉流水 */
  const tabbed = await evaluate(`(() => {
    document.querySelector('#view-finance .fin-tabs [data-tab="cat"]').click();
    const card = document.querySelector('#view-finance [data-key="fin:txs"]').closest('.fold-card');
    return {
      txHidden: card.querySelector('.fin-panel[data-panel="tx"]').hidden,
      catVisible: !card.querySelector('.fin-panel[data-panel="cat"]').hidden,
      active: card.querySelector('.fin-tabs button.active').textContent.trim(),
      donut: card.querySelectorAll('.fin-panel[data-panel="cat"] .donut circle').length
    };
  })()`);
  assert(tabbed.txHidden && tabbed.catVisible, '切到支出分类后页面板没有互换');
  assert(tabbed.active === '支出分类', '分段按钮高亮没跟上');
  assert(tabbed.donut >= 2, '支出分类页签里没有环形图');
  await shot('v20a-finance-cat.png');

  /* 切回流水 + 筛选仍然生效 */
  const filtered = await evaluate(`(() => {
    document.querySelector('#view-finance .fin-tabs [data-tab="tx"]').click();
    const sel = document.querySelector('#view-finance [data-fin-filter]');
    sel.value = 'income';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      active: document.querySelector('#view-finance .fin-tabs button.active').textContent.trim(),
      rows: document.querySelectorAll('#view-finance .fin-panel[data-panel="tx"] .tx-row').length,
      incomes: state.finance.transactions.filter(t => t.type === 'income' && String(t.date).slice(0, 7) === financeMonth).length,
      chips: [...document.querySelectorAll('#view-finance .tx-row .chip')].map(c => c.textContent.trim())
    };
  })()`);
  assert(filtered.active === '流水', '切回流水失败');
  assert(filtered.rows === filtered.incomes && filtered.chips.every(t => t === '收入'), `筛选收入后仍有 ${filtered.rows} 行，应为 ${filtered.incomes} 行`);
  pass('合并卡内筛选', `筛选「收入」后 ${filtered.rows} 行，切页签不影响筛选`);

  /* 折叠仍然只留一行标题 */
  const fold = await evaluate(`(() => {
    const btn = document.querySelector('#view-finance [data-key="fin:txs"]');
    const card = btn.closest('.fold-card');
    const before = Math.round(card.getBoundingClientRect().height);
    btn.click();
    const after = Math.round(document.querySelector('#view-finance [data-key="fin:txs"]').closest('.fold-card').getBoundingClientRect().height);
    document.querySelector('#view-finance [data-key="fin:txs"]').click();
    return { before, after };
  })()`);
  assert(fold.after < 80 && fold.before > fold.after * 2, `合并卡折叠异常：${fold.before}px → ${fold.after}px`);
  pass('合并卡折叠', `${fold.before}px → ${fold.after}px`);

  /* ---------- 4. 日记：全部展开后能一键全部收起 ---------- */
  await evaluate(`financeFilter = 'all'; state.settings.journalCollapsed = true; state.settings.journalFold = {}; switchView('journal')`);
  await delay(150);
  const jr1 = await evaluate(`(() => {
    const btn = document.querySelector('#view-journal [data-action="fold-journal-all"]');
    const label1 = btn.textContent.trim();
    btn.click();
    const btn2 = document.querySelector('#view-journal [data-action="fold-journal-all"]');
    return {
      label1,
      label2: btn2.textContent.trim(),
      openFlag: btn2.dataset.open,
      openHeads: document.querySelectorAll('#view-journal .fold-head.open').length,
      openBodies: document.querySelectorAll('#view-journal .fold-body, #view-journal .fold-sub').length,
      totalHeads: document.querySelectorAll('#view-journal .fold-head').length
    };
  })()`);
  assert(jr1.label1 === '全部展开', '未展开时按钮应为「全部展开」：' + jr1.label1);
  assert(jr1.label2 === '全部收起' && jr1.openFlag === '0', '全部展开后按钮没变成「全部收起」：' + jr1.label2);
  assert(jr1.openHeads === jr1.totalHeads && jr1.totalHeads > 0, `全部展开后仍有 ${jr1.totalHeads - jr1.openHeads} 个分组是收起的`);
  await shot('v20a-journal-open.png');

  const jr2 = await evaluate(`(() => {
    document.querySelector('#view-journal [data-action="fold-journal-all"]').click();
    const btn = document.querySelector('#view-journal [data-action="fold-journal-all"]');
    return {
      label: btn.textContent.trim(),
      openHeads: document.querySelectorAll('#view-journal .fold-head.open').length,
      bodies: document.querySelectorAll('#view-journal .fold-body').length
    };
  })()`);
  assert(jr2.label === '全部展开', '全部收起后按钮没回到「全部展开」：' + jr2.label);
  assert(jr2.openHeads === 0 && jr2.bodies === 0, `全部收起后仍有 ${jr2.openHeads} 个分展开着`);
  pass('日记全部收起', `${jr1.totalHeads} 个分组：展开 → 一键收起，按钮文案跟着换`);

  /* ---------- 5. 版本号 ---------- */
  const gradle = fs.readFileSync(path.join(root, 'app', 'build.gradle'), 'utf8');
  const ver = (gradle.match(/versionName\s+'([^']+)'/) || [])[1];
  const code = (gradle.match(/versionCode\s+(\d+)/) || [])[1];
  assert(/^2\.\d/.test(ver), '版本号应以 2.x 开头：' + ver);
  assert(Number(code) >= 17, 'versionCode 未递增：' + code);
  pass('版本号', `${ver}（versionCode ${code}）`);

  console.log(`\n${results.length} 项全部通过`);
  ws.close();
}

main().catch(e => { console.error('✗ ' + (e.stack || e.message)); process.exitCode = 1; })
  .finally(() => setTimeout(() => browser.kill(), 300));
