/**
 * Find X8 Ultra 适配测试
 * 机型：6.82" 1440×3168，约 510ppi，默认显示尺寸下 CSS 视口约 452×994dp
 * 同时覆盖 412×915（系统显示放大一档）与横屏 994×452
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9334;
const profile = path.join(root, '.edge-fit-profile');
const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
let ws, nextId = 0;
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
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

// 安卓外壳模拟：状态栏 32 / 手势条 24（Find X8 Ultra 实际值随系统设置在 28~36 之间）
const CONFIGS = [
  { name: 'oppo-452', width: 452, height: 994, dpr: 3.19, sat: 32, sab: 24, screen: [452, 994] },
  { name: 'oppo-412', width: 412, height: 915, dpr: 3.5, sat: 30, sab: 22, screen: [412, 915] },
  { name: 'oppo-landscape', width: 994, height: 452, dpr: 3.19, sat: 24, sab: 20, screen: [994, 452] }
];

async function prepareBridge(cfg) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__exportCalls = [];
      window.__barCalls = [];
      window.AndroidBridge = {
        getSafeInsets() { return '${cfg.sat},0,${cfg.sab},0'; },
        getScreenInfo() { return 'dp=${cfg.width}x${cfg.height}'; },
        exportBackup(json, name) { window.__exportCalls.push({ json, name }); },
        setSystemBars(color, dark) { window.__barCalls.push({ color, dark }); }
      };
    `
  });
}

async function measure(cfg) {
  return evaluate(`(() => {
    const rect = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    const cs = sel => getComputedStyle(document.documentElement).getPropertyValue(sel).trim();
    const header = rect('.mobile-header');
    const logo = rect('.mobile-header .logo');
    const settingsBtn = rect('#mobileSettings');
    const nav = rect('#nav');
    const navItems = [...document.querySelectorAll('#nav button')].map(b => {
      const r = b.getBoundingClientRect();
      return { view: b.dataset.view, left: r.left, right: r.right, width: r.width,
               top: r.top, bottom: r.bottom, label: b.innerText.trim(), hidden: r.width === 0 };
    });
    const firstCard = rect('#view-dashboard .card');
    const main = rect('.main');
    const overflowing = [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
    }).slice(0, 6).map(el => el.className || el.tagName);
    return {
      vw: innerWidth, vh: innerHeight,
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      varTop: cs('--sat'), varBottom: cs('--sab'),
      header: header && { top: header.top, bottom: header.bottom, height: header.height },
      logo: logo && { top: logo.top, left: logo.left },
      settingsBtn: settingsBtn && { left: settingsBtn.left, right: settingsBtn.right, top: settingsBtn.top },
      nav: nav && { top: nav.top, bottom: nav.bottom, height: nav.height },
      navItems, mainTop: main && main.top,
      firstCardTop: firstCard && firstCard.top,
      overflowing,
      headerFont: getComputedStyle(document.querySelector('.mobile-header h1')).fontSize,
      navFont: getComputedStyle(document.querySelector('#nav button')).fontSize,
      bodyFont: getComputedStyle(document.body).fontSize
    };
  })()`);
}

async function capture(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', `${name}.png`), Buffer.from(shot.data, 'base64'));
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
  const page = pages.find(p => p.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
      else item.resolve(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      const list = events.get(msg.method);
      events.delete(msg.method);
      list.forEach(r => r(msg.params));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const htmlUrl = pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href;
  const report = [];

  for (const cfg of CONFIGS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: cfg.width, height: cfg.height, screenWidth: cfg.screen[0], screenHeight: cfg.screen[1],
      deviceScaleFactor: cfg.dpr, mobile: true
    });
    await prepareBridge(cfg);
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url: htmlUrl });
    await loaded;
    await evaluate('document.fonts.ready');
    await evaluate(`state = seedState(); saveState(); render();`);
    await delay(500);

    const m = await measure(cfg);
    // 安全区确实生效
    assert(Math.abs(parseFloat(m.varTop) - cfg.sat) < 1, `${cfg.name}: 顶部安全区未生效 ${m.varTop}`);
    assert(Math.abs(parseFloat(m.varBottom) - cfg.sab) < 1, `${cfg.name}: 底部安全区未生效 ${m.varBottom}`);
    // 无横向溢出
    assert(m.scrollW <= m.vw + 1, `${cfg.name}: 页面横向溢出 ${m.scrollW} > ${m.vw}`);
    assert(m.overflowing.length === 0, `${cfg.name}: 元素越界 ${m.overflowing.join(', ')}`);
    // 顶栏内容在状态栏/挖孔下方
    assert(m.logo.top >= cfg.sat - 0.6, `${cfg.name}: 顶栏压到状态栏 ${m.logo.top} < ${cfg.sat}`);
    assert(m.settingsBtn.right <= m.vw - 0.5, `${cfg.name}: 设置按钮被右侧裁切`);
    // 底栏贴底且内容在手势条上方
    assert(Math.abs(m.nav.bottom - m.vh) < 1.5, `${cfg.name}: 底栏未贴底 ${m.nav.bottom} / ${m.vh}`);
    assert(m.navItems.length === 6, `${cfg.name}: 底部导航项数 ${m.navItems.length}`);
    assert(m.navItems.every(i => i.left >= -0.5 && i.right <= m.vw + 0.5), `${cfg.name}: 导航项越界`);
    assert(m.navItems.every(i => i.width >= 40), `${cfg.name}: 导航项过窄 ${m.navItems.map(i => Math.round(i.width))}`);
    assert(m.navItems.every(i => i.bottom <= m.vh - cfg.sab + 1.5), `${cfg.name}: 导航文字压到手势条`);
    // 内容不被固定顶栏遮挡
    assert(m.firstCardTop >= m.header.bottom - 1, `${cfg.name}: 首张卡片被顶栏遮挡`);

    await capture(`fit-${cfg.name}`);
    report.push({
      device: cfg.name, viewport: `${m.vw}x${m.vh}`, insets: `${m.varTop}/${m.varBottom}`,
      headerHeight: Math.round(m.header.height), navHeight: Math.round(m.nav.height),
      navItemWidth: Math.round(m.navItems[0].width), font: m.navFont, scrollW: m.scrollW
    });
  }

  // 回到主机型做功能回归
  const main = CONFIGS[0];
  await send('Emulation.setDeviceMetricsOverride', {
    width: main.width, height: main.height, screenWidth: main.screen[0], screenHeight: main.screen[1],
    deviceScaleFactor: main.dpr, mobile: true
  });
  await prepareBridge(main);
  let loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: htmlUrl });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate(`state = seedState(); saveState(); render();`);

  const passed = [];
  await evaluate(`document.querySelector('[data-action="nav"][data-view="goals"]').click()`);
  assert(await evaluate('currentView') === 'goals', '切换目标页失败');
  await evaluate(`document.querySelector('[data-action="add-goal"]').click()`);
  await delay(200);
  const modalFit = await evaluate(`(() => {
    const m = document.querySelector('.modal').getBoundingClientRect();
    return { top: m.top, bottom: m.bottom, vh: innerHeight, sab: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab')) };
  })()`);
  assert(modalFit.bottom <= modalFit.vh - modalFit.sab + 1, `弹窗底部被手势条遮挡 ${JSON.stringify(modalFit)}`);
  await evaluate(`(() => { const f = document.querySelector('form[data-form="goal"]');
    f.elements.title.value = 'Find X8 Ultra 测试'; f.elements.target.value = '30'; f.requestSubmit(); })()`);
  assert(await evaluate(`state.goals.some(g => g.title === 'Find X8 Ultra 测试')`), '新建目标失败');
  passed.push('目标创建 + 弹窗安全区');

  await evaluate(`switchView('finance'); document.querySelector('[data-action="fin-mode"][data-mode="year"]').click()`);
  await delay(300);
  const annual = await evaluate(`(() => {
    const wrap = document.querySelector('.fin-table-wrap');
    const total = document.querySelector('.fin-table tr.total');
    return {
      columns: total ? [...total.children].filter(td => getComputedStyle(td).display !== 'none').length : 0,
      rows: document.querySelectorAll('.fin-table tbody tr').length,
      bars: document.querySelectorAll('.y-chart .y-col').length,
      pageW: document.documentElement.scrollWidth,
      wrapClient: wrap ? wrap.clientWidth : 0,
      wrapScroll: wrap ? wrap.scrollWidth : 0
    };
  })()`);
  assert(annual.columns === 4, `年度总表列数 ${annual.columns}`);
  assert(annual.rows === 13 && annual.bars === 12, '年度明细或柱形图数量异常');
  assert(annual.pageW <= main.width + 1, '年度页横向溢出');
  assert(annual.wrapScroll <= annual.wrapClient + 1, '年度总表在卡片内溢出');
  passed.push('年度总表四列完整');
  await delay(1200);
  await capture('fit-oppo-annual');

  await evaluate(`document.getElementById('mobileSettings').click()`);
  assert(await evaluate(`document.querySelector('.sidebar-foot').classList.contains('mobile-open')`), '设置面板未打开');
  const panel = await evaluate(`(() => { const r = document.querySelector('.sidebar-foot').getBoundingClientRect();
    return { top: r.top, right: r.right, vw: innerWidth }; })()`);
  assert(panel.right <= panel.vw + 0.5, '设置面板右侧越界');
  assert(panel.top >= 40, '设置面板顶到状态栏');
  passed.push('设置面板位置');
  await capture('fit-oppo-settings');

  await evaluate(`closeMobileTools()`);
  await evaluate(`androidHandleBack(); switchView('learning'); androidHandleBack()`);
  passed.push('返回键');

  console.log(JSON.stringify({ report, passed }, null, 2));
  ws.close();
}

main().catch(e => {
  console.error(e.stack || e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
