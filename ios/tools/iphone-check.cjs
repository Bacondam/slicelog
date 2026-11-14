/** iPhone 15 模拟回归：node tools/iphone-check.cjs */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.resolve(__dirname, '..');
const PORT = 8772;
const CDP = 9352;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(root, p.replace(/^\//, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(root, '.edge-ios-profile')}`,
  '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
let ws, nextId = 0;
const pending = new Map(), events = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(n) { return new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); }); }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'shots', name), Buffer.from(r.data, 'base64'));
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });

  let pages;
  for (let i = 0; i < 120; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (pages.length) break; } catch (_) {}
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
  await send('Page.enable');
  await send('Runtime.enable');

  // iPhone 15：393 × 852 CSS px，DPR 3；灵动岛机型 顶部 59 / 底部 34
  await send('Emulation.setDeviceMetricsOverride', {
    width: 393, height: 852, screenWidth: 393, screenHeight: 852, deviceScaleFactor: 3, mobile: true
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', { userAgent: IOS_UA, platform: 'iPhone', acceptLanguage: 'zh-CN,zh;q=0.9' });

  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.removeItem('growth-os-ios-hint'); } catch (e) {}`
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await loaded;
  await evaluate('document.fonts.ready');
  await delay(300);

  const pass = [];
  const check = (name, ok, detail) => {
    if (!ok) throw new Error(`✗ ${name}${detail ? ' — ' + detail : ''}`);
    pass.push(name); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  };

  /* 1. 头部 meta */
  const meta = await evaluate(`(() => {
    const m = n => { const e = document.querySelector('meta[name="' + n + '"]'); return e ? e.content : ''; };
    return {
      capable: m('apple-mobile-web-app-capable'),
      title: m('apple-mobile-web-app-title'),
      bar: m('apple-mobile-web-app-status-bar-style'),
      viewport: document.querySelector('meta[name="viewport"]').content,
      icon: document.querySelector('link[rel="apple-touch-icon"]') ? document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href') : '',
      manifest: document.querySelector('link[rel="manifest"]') ? document.querySelector('link[rel="manifest"]').getAttribute('href') : ''
    };
  })()`);
  check('PWA meta 完整', meta.capable === 'yes' && meta.title === '成长日志' && meta.icon === 'icons/icon-180.png' && meta.manifest === 'manifest.webmanifest', `status-bar=${meta.bar}`);
  check('viewport 支持刘海屏', meta.viewport.includes('viewport-fit=cover'));

  /* 2. 资源可达 + Service Worker */
  const res = await evaluate(`Promise.all([
    fetch('manifest.webmanifest').then(r => r.status),
    fetch('icons/icon-180.png').then(r => r.status),
    fetch('sw.js').then(r => r.status)
  ])`);
  check('manifest / 图标 / SW 可访问', res[0] === 200 && res[1] === 200 && res[2] === 200, JSON.stringify(res));
  const swReady = await evaluate(`navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)`);
  check('Service Worker 已激活（可离线）', swReady === true);

  /* 3. 模拟 iPhone 安全区后布局 */
  await evaluate('window.applySafeInsets(59, 0, 34, 0)');
  await evaluate(`state = seedState(); saveState(); render();`);
  await delay(350);
  const layout = await evaluate(`(() => {
    const h = document.querySelector('.mobile-header');
    const nav = document.querySelector('.nav');
    const cs = getComputedStyle(h);
    const csn = getComputedStyle(nav);
    return {
      headerPadTop: parseFloat(cs.paddingTop),
      headerH: Math.round(h.getBoundingClientRect().height),
      navPadBottom: parseFloat(csn.paddingBottom),
      scrollW: document.documentElement.scrollWidth,
      vw: innerWidth,
      inputFont: (() => { const i = document.querySelector('.modal-box input'); return i ? getComputedStyle(i).fontSize : 'n/a'; })(),
      overflow: document.documentElement.scrollWidth - innerWidth
    };
  })()`);
  check('顶部避开灵动岛', layout.headerPadTop >= 59, `header 上内边距 ${layout.headerPadTop}px`);
  check('底部避开手势条', layout.navPadBottom >= 34, `nav 下内边距 ${layout.navPadBottom}px`);
  check('无横向溢出', layout.overflow <= 0, `scrollWidth ${layout.scrollW} / vw ${layout.vw}`);
  await shot('ios-01-dashboard.png');

  /* 4. 各页面截图与交互 */
  await evaluate(`switchView('goals')`); await delay(350);
  const goals = await evaluate(`(() => ({
    strips: document.querySelectorAll('.done-strip').length,
    cards: document.querySelectorAll('.goal-card').length,
    plus: !!document.querySelector('.done-strip .collapse-btn.pm'),
    overflow: document.documentElement.scrollWidth - innerWidth
  }))()`);
  check('目标页渲染正常', goals.cards >= 1 && goals.strips >= 1 && goals.plus && goals.overflow <= 0, `卡片 ${goals.cards} / 折叠 ${goals.strips}`);
  await evaluate(`document.querySelector('.done-strip').scrollIntoView({block:'center'})`);
  await delay(200);
  await shot('ios-02-goals.png');

  await evaluate(`switchView('journal')`); await delay(350);
  const journal = await evaluate(`(() => ({
    heads: document.querySelectorAll('.fold-head').length,
    pm: document.querySelectorAll('.fold-head .collapse-btn.pm').length,
    overflow: document.documentElement.scrollWidth - innerWidth
  }))()`);
  check('日记页年月折叠正常', journal.heads >= 1 && journal.pm === journal.heads && journal.overflow <= 0, `${journal.heads} 个折叠项`);
  await evaluate(`document.querySelector('.fold-block').scrollIntoView({block:'start'}); window.scrollBy(0,-80)`);
  await delay(200);
  await shot('ios-03-journal.png');

  await evaluate(`switchView('finance')`); await delay(400);
  const fin = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.form-row')];
    const cols = rows.map(r => getComputedStyle(r).gridTemplateColumns.split(' ').length);
    const inp = document.querySelector('.quick-body input');
    return {
      singleCol: cols.every(c => c === 1),
      inputFont: inp ? getComputedStyle(inp).fontSize : 'n/a',
      quickBtn: (() => { const b = document.querySelector('[data-action="toggle-quick"]'); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      overflow: document.documentElement.scrollWidth - innerWidth
    };
  })()`);
  check('表单在 393px 下为单列', fin.singleCol === true);
  check('输入框字号 ≥16px（不触发自动放大）', parseFloat(fin.inputFont) >= 16, fin.inputFont);
  check('折叠按钮可点尺寸', fin.quickBtn.w >= 32 && fin.quickBtn.h >= 32, JSON.stringify(fin.quickBtn));
  check('记账页无横向溢出', fin.overflow <= 0);
  await evaluate(`window.scrollTo(0, 260)`); await delay(200);
  await shot('ios-04-finance.png');

  /* 5. 备份：导出 / 分享 / 自动存档 */
  const backup = await evaluate(`(() => {
    const json = JSON.stringify(state);
    const out = {};
    try { window.AndroidBridge.exportBackup(json, '成长日志备份-2026-11-14.json'); out.export = 'ok'; }
    catch (e) { out.export = 'err:' + e.message; }
    try { window.AndroidBridge.shareBackup(json, '成长日志备份-2026-11-14.json'); out.share = 'ok'; }
    catch (e) { out.share = 'err:' + e.message; }
    window.AndroidBridge.autoBackup(json);
    out.restored = !!window.AndroidBridge.readAutoBackup();
    out.hasGetInsets = typeof window.AndroidBridge.getSafeInsets === 'function';
    return out;
  })()`);
  check('导出备份不报错', backup.export === 'ok');
  check('分享备份不报错（无分享面板时回落下载）', backup.share === 'ok');
  check('自动存档可写可读', backup.restored === true);
  check('未拦截 iOS 原生安全区', backup.hasGetInsets === false);

  /* 6. 首次安装提示 */
  const hint = await evaluate(`(() => {
    const el = document.querySelector('.ios-install-hint');
    if (!el) return { shown: false };
    const r = el.getBoundingClientRect();
    return { shown: true, bottom: Math.round(innerHeight - r.bottom), h: Math.round(r.height) };
  })()`);
  check('Safari 首访显示「添加到主屏幕」提示', hint.shown === true, `距底部 ${hint.bottom}px`);
  await shot('ios-05-install-hint.png');
  await evaluate(`document.querySelector('.ios-install-hint button').click()`);
  await delay(200);
  const dismissed = await evaluate(`!document.querySelector('.ios-install-hint') && !!localStorage.getItem('growth-os-ios-hint')`);
  check('提示可关闭且只出现一次', dismissed === true);

  /* 7. 设置面板里的备份入口 */
  await evaluate(`switchView('dashboard'); document.getElementById('mobileSettings').click()`);
  await delay(350);
  const settings = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.sidebar-foot button')].map(b => b.textContent.trim());
    return { btns, overflow: document.documentElement.scrollWidth - innerWidth };
  })()`);
  check('设置面板含分享/导出/恢复备份', settings.btns.some(t => t.includes('分享')) && settings.btns.some(t => t.includes('导出')) && settings.btns.some(t => t.includes('恢复')), settings.btns.join(' / '));
  await shot('ios-06-settings.png');

  console.log(`\n全部通过：${pass.length} 项`);
  ws.close();
})().catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(() => setTimeout(() => {
    try { server.close(); } catch (_) {}
    browser.kill();
  }, 300));
