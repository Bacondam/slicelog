/**
 * iPhone 15 模拟回归（V1.0）：node tools/iphone-check.cjs
 * 393×852 CSS px / DPR 3 / 灵动岛安全区 59 + 34
 * 覆盖：PWA meta、Service Worker、安全区布局、四视图渲染、倒数日、设置面板与版本号、备份桥接、首访提示
 */
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

/* 任何一步卡住都不能拖死整个流程：统一 8 秒上限 */
async function evaluate(expression, timeout = 8000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    delay(timeout).then(() => { throw new Error('evaluate 超时：' + expression.slice(0, 60)); })
  ]);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'shots', name), Buffer.from(r.data, 'base64'));
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const results = [];
function pass(name, detail) { results.push(name); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }

setTimeout(() => { console.error('整体超时（90s），可能有步骤卡住'); process.exit(3); }, 90000);

(async () => {
  await new Promise((r, j) => { server.once('error', j); server.listen(PORT, '127.0.0.1', r); });
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });

  let pages;
  for (let i = 0; i < 100; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (pages.length) break; } catch (_) {}
    await delay(120);
  }
  assert(pages && pages.length, '无法连接测试浏览器');

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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 393, height: 852, screenWidth: 393, screenHeight: 852, deviceScaleFactor: 3, mobile: true
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', { userAgent: IOS_UA, platform: 'iPhone', acceptLanguage: 'zh-CN,zh;q=0.9' });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.removeItem('growth-os-ios-hint'); } catch (e) {}`
  });

  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?nosplash=1` });
  await Promise.race([loaded, delay(10000)]);
  await delay(600);

  /* ---------- 1. PWA meta ---------- */
  const meta = await evaluate(`(() => {
    const m = n => { const e = document.querySelector('meta[name="' + n + '"]'); return e ? e.content : ''; };
    const iconEl = document.querySelector('link[rel="apple-touch-icon"]');
    return {
      capable: m('apple-mobile-web-app-capable'),
      title: m('apple-mobile-web-app-title'),
      titleTag: document.title,
      bar: m('apple-mobile-web-app-status-bar-style'),
      viewport: document.querySelector('meta[name="viewport"]').content,
      icon: iconEl ? iconEl.getAttribute('href') : '',
      manifest: document.querySelector('link[rel="manifest"]') ? document.querySelector('link[rel="manifest"]').getAttribute('href') : ''
    };
  })()`);
  assert(meta.capable === 'yes', '缺少 apple-mobile-web-app-capable');
  assert(meta.title === '人生切片', '主屏名称应为「人生切片」，实际「' + meta.title + '」');
  assert(meta.titleTag.indexOf('Slicelog') >= 0, '页面标题应含 Slicelog：' + meta.titleTag);
  assert(meta.icon === 'icons/icon-180.png', '缺少 apple-touch-icon');
  assert(meta.manifest === 'manifest.webmanifest', '缺少 manifest 引用');
  assert(meta.viewport.includes('viewport-fit=cover'), 'viewport 缺 viewport-fit=cover');
  pass('PWA meta', `${meta.title} · ${meta.titleTag}`);

  /* ---------- 2. 资源 + Service Worker ---------- */
  const res = await evaluate(`Promise.all([
    fetch('manifest.webmanifest').then(r => r.status),
    fetch('icons/icon-180.png').then(r => r.status),
    fetch('sw.js').then(r => r.status)
  ])`);
  assert(res.join(',') === '200,200,200', '资源不可访问：' + JSON.stringify(res));
  const swReady = await evaluate(`Promise.race([
    navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false),
    new Promise(r => setTimeout(() => r(false), 6000))
  ])`, 9000);
  assert(swReady === true, 'Service Worker 未激活，离线不可用');
  pass('离线缓存', 'manifest / 图标 / SW 均可访问，SW 已激活');

  /* ---------- 3. 安全区与布局 ---------- */
  await evaluate(`window.applySafeInsets(59, 0, 34, 0)`);
  await evaluate(`state = seedState(); saveState(); render();`);
  await delay(450);
  const layout = await evaluate(`(() => {
    const nav = document.querySelector('.nav');
    return {
      safeTop: getComputedStyle(document.documentElement).getPropertyValue('--sat').trim(),
      navPadBottom: parseFloat(getComputedStyle(nav).paddingBottom),
      overflow: document.documentElement.scrollWidth - innerWidth
    };
  })()`);
  assert(layout.safeTop === '59px', '安全区变量没写进 --sat：' + layout.safeTop);
  assert(layout.navPadBottom >= 34, '底部导航没避开手势条：' + layout.navPadBottom);
  assert(layout.overflow <= 0, '页面横向溢出 ' + layout.overflow + 'px');
  pass('安全区布局', `--sat ${layout.safeTop} / nav 下内边距 ${layout.navPadBottom}px / 无横向溢出`);
  await shot('ios-01-dashboard.png');

  /* ---------- 4. 四个视图 ---------- */
  await evaluate(`switchView('goals')`); await delay(400);
  const goals = await evaluate(`(() => ({
    cards: document.querySelectorAll('.goal-card').length,
    overflow: document.documentElement.scrollWidth - innerWidth
  }))()`);
  assert(goals.cards >= 1 && goals.overflow <= 0, '目标页异常：卡片 ' + goals.cards);
  await shot('ios-02-goals.png');

  await evaluate(`switchView('finance')`); await delay(450);
  const fin = await evaluate(`(() => {
    const inp = document.querySelector('input[type="number"]') || document.querySelector('input');
    return {
      inputFont: inp ? parseFloat(getComputedStyle(inp).fontSize) : 0,
      overflow: document.documentElement.scrollWidth - innerWidth
    };
  })()`);
  assert(fin.inputFont >= 16, '输入框字号 <16px，Safari 会放大整页：' + fin.inputFont);
  assert(fin.overflow <= 0, '记账页横向溢出 ' + fin.overflow + 'px');
  await shot('ios-03-finance.png');

  await evaluate(`switchView('journal')`); await delay(400);
  const journal = await evaluate(`(() => ({
    heads: document.querySelectorAll('.fold-head').length,
    overflow: document.documentElement.scrollWidth - innerWidth
  }))()`);
  assert(journal.heads >= 1 && journal.overflow <= 0, '日记页折叠异常：' + journal.heads);
  await shot('ios-04-journal.png');
  pass('四视图渲染', `目标 ${goals.cards} 卡 · 日记 ${journal.heads} 个折叠 · 输入框 ${fin.inputFont}px`);

  /* ---------- 4b. 倒数日（日记页顶部） ---------- */
  const cd = await evaluate(`(() => {
    state = seedState(); switchView('journal');
    state.settings.journalCollapsed = false; render();
    const items = [...document.querySelectorAll('.cd-item')];
    const card = document.getElementById('view-journal').querySelector('.fold-card');
    const form = document.querySelector('[data-form="journal"]');
    return {
      n: items.length,
      caps: items.map(e => (e.querySelector('.cd-cap') || {}).textContent || '今天'),
      above: !!card && !!form && card.getBoundingClientRect().top < form.getBoundingClientRect().top,
      ops: items[0] ? items[0].querySelectorAll('.cd-ops button').length : 0,
      overflow: document.documentElement.scrollWidth - innerWidth,
      titleW: items[0] ? Math.round(items[0].querySelector('.cd-title').getBoundingClientRect().width) : 0
    };
  })()`);
  assert(cd.n >= 2, '倒数日没渲染出来：' + cd.n);
  assert(cd.above, '倒数日应在「写今日日记」之上');
  assert(cd.ops === 4, '每条应有 4 个操作按钮，实际 ' + cd.ops);
  assert(cd.overflow <= 0, '倒数日导致横向溢出 ' + cd.overflow + 'px');
  assert(cd.titleW >= 90, 'iPhone 宽度下标题区只剩 ' + cd.titleW + 'px');
  await shot('ios-06-countdown.png');
  pass('倒数日', `${cd.n} 条 · ${cd.caps.join('/')} · 每卡 ${cd.ops} 个操作 · 标题 ${cd.titleW}px`);

  /* ---------- 5. 设置面板与版本号 ---------- */
  await evaluate(`switchView('dashboard'); scrollTo(0,0);`);
  await delay(250);
  await evaluate(`document.getElementById('mobileSettings').click()`);
  await delay(450);
  const panel = await evaluate(`(() => {
    const f = document.querySelector('.sidebar-foot');
    const cs = getComputedStyle(f);
    const rect = f.getBoundingClientRect();
    const ver = f.querySelector('.sf-ver');
    return {
      open: cs.display !== 'none',
      groupCount: f.querySelectorAll('.sf-group').length,
      labels: [...f.querySelectorAll('.sf-label')].map(l => l.textContent.trim()),
      btns: [...f.querySelectorAll('button')].map(b => b.textContent.trim()),
      ver: ver ? ver.textContent.replace(/\\s+/g, ' ').trim() : '',
      bottom: Math.round(rect.bottom), vh: innerHeight
    };
  })()`);
  assert(panel.open, '设置面板没打开');
  assert(panel.groupCount === 3, '设置应分三组，实际 ' + panel.groupCount);
  assert(/V1\.0/.test(panel.ver), '设置面板里没有 V1.0：' + panel.ver);
  assert(panel.bottom <= panel.vh + 1, `面板超出屏幕：${panel.bottom} > ${panel.vh}`);
  assert(!panel.btns.some(t => t.indexOf('提醒') >= 0), '设置面板里还有提醒相关按钮');
  pass('设置面板', `${panel.labels.join(' / ')} + 危险区 · ${panel.ver} · 底 ${panel.bottom}/${panel.vh}px`);
  await shot('ios-05-settings.png');

  /* ---------- 6. 备份桥接 ---------- */
  const backup = await evaluate(`(() => {
    const json = JSON.stringify(state);
    const out = {};
    try { window.AndroidBridge.exportBackup(json, 'Slicelog-备份.json'); out.export = 'ok'; } catch (e) { out.export = 'err:' + e.message; }
    try { window.AndroidBridge.shareBackup(json, 'Slicelog-备份.json'); out.share = 'ok'; } catch (e) { out.share = 'err:' + e.message; }
    window.AndroidBridge.autoBackup(json);
    out.restored = !!window.AndroidBridge.readAutoBackup();
    out.hasInsets = typeof window.AndroidBridge.getSafeInsets === 'function';
    return out;
  })()`);
  assert(backup.export === 'ok', '导出备份报错：' + backup.export);
  assert(backup.share === 'ok', '分享备份报错：' + backup.share);
  assert(backup.restored === true, '自动存档写不进去');
  assert(backup.hasInsets === false, '网页版不该有 getSafeInsets（会覆盖 iOS 真实安全区）');
  pass('备份桥接', '导出 / 分享 / 自动存档均可用，安全区未被覆盖');

  /* ---------- 7. 首次访问提示 ---------- */
  const hint = await evaluate(`(() => {
    const el = document.querySelector('.ios-install-hint');
    if (!el) return { shown: false };
    const r = el.getBoundingClientRect();
    return { shown: true, bottom: Math.round(innerHeight - r.bottom) };
  })()`);
  assert(hint.shown, 'Safari 首访没出现「添加到主屏幕」提示');
  await shot('ios-06-install-hint.png');
  await evaluate(`document.querySelector('.ios-install-hint button').click()`);
  await delay(250);
  const dismissed = await evaluate(`!document.querySelector('.ios-install-hint') && !!localStorage.getItem('growth-os-ios-hint')`);
  assert(dismissed, '提示关不掉或没记住');
  pass('首访提示', `距底部 ${hint.bottom}px，可关闭且只出现一次`);

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
})().catch(e => { console.error('✗ ' + e.message); process.exitCode = 1; })
  .finally(() => setTimeout(() => {
    try { server.close(); } catch (_) {}
    browser.kill();
    process.exit(process.exitCode || 0);
  }, 300));
