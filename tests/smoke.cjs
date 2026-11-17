const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9333;
const profile = path.join(root, '.edge-smoke-profile');
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
  const result = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
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
  const page = pages.find(item => item.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
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
    width: 390, height: 844, screenWidth: 390, screenHeight: 844,
    deviceScaleFactor: 1, mobile: true
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__exportCalls = [];
      window.__barCalls = [];
      window.AndroidBridge = {
        exportBackup(json, name) { window.__exportCalls.push({ json, name }); },
        setSystemBars(color, dark) { window.__barCalls.push({ color, dark }); }
      };
    `
  });
  const loaded = waitEvent('Page.loadEventFired');
  const htmlUrl = pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href;
  await send('Page.navigate', { url: htmlUrl });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate(`state = seedState(); saveState(); render();`);

  const layout = await evaluate(`(() => {
    const settings = document.getElementById('mobileSettings').getBoundingClientRect();
    const nav = [...document.querySelectorAll('#nav button')].map(b => {
      const r = b.getBoundingClientRect();
      return { view: b.dataset.view, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    return {
      width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      settings: { left: settings.left, right: settings.right, top: settings.top },
      nav
    };
  })()`);
  assert(layout.width === 390, `手机视口宽度异常：${layout.width}`);
  assert(layout.scrollWidth <= 390, `页面存在横向溢出：${layout.scrollWidth}`);
  assert(layout.settings.left >= 0 && layout.settings.right <= 390, '设置按钮被裁切');
  assert(layout.nav.length === 5, '底部导航不是五项');
  assert(layout.nav.every(item => item.left >= 0 && item.right <= 390), '底部导航被裁切');

  const screenshot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true
  });
  fs.writeFileSync(path.join(root, 'tests', 'mobile-390.png'), Buffer.from(screenshot.data, 'base64'));

  const results = [];
  await evaluate(`document.querySelector('[data-action="nav"][data-view="goals"]').click()`);
  assert(await evaluate(`currentView`) === 'goals', '无法切换到目标页');
  await evaluate(`document.querySelector('[data-action="add-goal"]').click()`);
  assert(await evaluate(`!document.getElementById('modal').classList.contains('hidden')`), '目标弹窗未打开');
  await evaluate(`(() => {
    const form = document.querySelector('form[data-form="goal"]');
    form.elements.title.value = '安卓测试目标';
    form.requestSubmit();
  })()`);
  assert(await evaluate(`state.goals.some(g => g.title === '安卓测试目标')`), '新建目标失败');
  assert(await evaluate(`localStorage.getItem('growth-os-v1').includes('安卓测试目标')`), '目标未保存到本地');
  results.push('目标创建与本地保存');

  await evaluate(`document.getElementById('mobileSettings').click()`);
  assert(await evaluate(`document.querySelector('.sidebar-foot').classList.contains('mobile-open')`), '设置面板未打开');
  await evaluate(`document.getElementById('themeBtn').click()`);
  await evaluate(`document.querySelector('[data-action="set-theme"][data-theme="pine"]').click()`);
  assert(await evaluate(`document.documentElement.dataset.theme`) === 'pine', '主题切换失败');
  assert(await evaluate(`window.__barCalls.some(call => call.dark)`), '未同步安卓深色系统栏');
  await evaluate(`closeModal(); closeMobileTools()`);
  results.push('设置面板与深色主题');

  await evaluate(`document.getElementById('mobileSettings').click()`);
  await evaluate(`document.getElementById('exportBtn').click()`);
  const exported = await evaluate(`window.__exportCalls[window.__exportCalls.length - 1]`);
  assert(exported && exported.name.endsWith('.json'), '未调用安卓备份导出');
  assert(exported.json.includes('安卓测试目标'), '导出内容缺少新数据');
  results.push('安卓备份导出桥接');

  await evaluate(`switchView('learning')`);
  assert(await evaluate(`androidHandleBack()`) === true, '返回键未处理子页面');
  assert(await evaluate(`currentView`) === 'dashboard', '返回键未回到概览');
  assert(await evaluate(`androidHandleBack()`) === false, '概览返回键状态错误');
  results.push('安卓返回键逻辑');

  await evaluate(`switchView('finance')`);
  await evaluate(`document.querySelector('[data-action="fin-mode"][data-mode="year"]').click()`);
  const annual = await evaluate(`(() => {
    const sum = financeYearSummary(financeYear);
    const wrap = document.querySelector('.fin-table-wrap');
    const total = document.querySelector('.fin-table tr.total');
    return {
      mode: financeMode,
      year: financeYear,
      stats: document.querySelectorAll('.fin-stats .stat').length,
      bars: document.querySelectorAll('.year-donut .donut-legend li').length,
      rows: document.querySelectorAll('.fin-table tbody tr').length,
      total: total ? total.innerText : '',
      income: fmtMoney(sum.income),
      expense: fmtMoney(sum.expense),
      balance: fmtMoney(sum.balance),
      columns: total ? [...total.children].filter(td => getComputedStyle(td).display !== 'none').length : 0,
      pageWidth: document.documentElement.scrollWidth,
      wrapClientWidth: wrap ? wrap.clientWidth : 0,
      wrapScrollWidth: wrap ? wrap.scrollWidth : 0
    };
  })()`);
  assert(annual.mode === 'year', '未切换到年度账单');
  assert(annual.stats === 4, `年度汇总卡片不是四项：${annual.stats}`);
  assert(annual.bars >= 1, `年度支出构成环形图缺少分类图例：${annual.bars}`);
  assert(annual.rows === 13, `月度明细表行数异常：${annual.rows}`);
  assert(annual.total.includes(annual.income), '年度总表缺少正确的收入合计');
  assert(annual.total.includes(annual.expense), '年度总表缺少正确的支出合计');
  assert(annual.total.includes(annual.balance), '年度总表缺少正确的结余合计');
  assert(annual.pageWidth <= 390, `年度页存在横向溢出：${annual.pageWidth}`);
  assert(annual.columns === 4, `手机年度总表未完整显示四列：${annual.columns}`);
  assert(annual.wrapScrollWidth <= annual.wrapClientWidth + 1, '手机年度总表仍在页面内横向溢出');
  results.push('年度汇总卡片与支出构成环形图');

  const monthJump = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.fin-table tbody tr')].find(tr => !tr.classList.contains('zero'));
    if (!row) return null;
    const month = row.dataset.month;
    row.click();
    return { month, mode: financeMode, view: currentView, selected: financeMonth };
  })()`);
  assert(monthJump && monthJump.mode === 'month' && monthJump.month === monthJump.selected, '点击年度月份未返回当月明细');
  assert(monthJump.view === 'finance', '月份跳转后离开了记账页');
  results.push('年度月份跳转月度明细');

  await evaluate(`document.querySelector('[data-action="fin-mode"][data-mode="year"]').click(); applyTheme('oat'); scrollTo(0, 0)`);
  await delay(2400);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 1200, screenWidth: 390, screenHeight: 844,
    deviceScaleFactor: 1, mobile: true
  });
  const annualTop = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true
  });
  fs.writeFileSync(path.join(root, 'tests', 'annual-top-390.png'), Buffer.from(annualTop.data, 'base64'));
  const tableTop = await evaluate(`(() => {
    const el = document.querySelector('.fin-table-wrap');
    return el ? Math.max(0, el.getBoundingClientRect().top + scrollY - 90) : 0;
  })()`);
  await evaluate(`scrollTo(0, ${tableTop})`);
  await delay(150);
  const annualTable = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true
  });
  fs.writeFileSync(path.join(root, 'tests', 'annual-table-390.png'), Buffer.from(annualTable.data, 'base64'));

  console.log(JSON.stringify({ layout, annual, passed: results }, null, 2));
  ws.close();
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => browser.kill(), 300);
});
