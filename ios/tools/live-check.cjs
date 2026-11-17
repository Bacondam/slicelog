// 线上链接真机环境模拟校验：iPhone 15 尺寸 + iOS UA，检查渲染、SW、manifest、图标
const { spawn } = require('child_process');
const path = require('path');

const URL = process.env.LIVE_URL || 'https://wbapp-ta9bl1atjke0tbawyzidpx.app.workbuddy.host/?sharecode=IKR7IT74IO';
const PORT = 9351;
const root = path.resolve(__dirname, '..');

const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(root, '.edge-live-profile')}`,
  'about:blank',
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map(), events = new Map();

function send(m, p = {}) {
  return new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
}
function waitEvent(n) {
  return new Promise(res => { const l = events.get(n) || []; l.push(res); events.set(n, l); });
}
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
}

(async () => {
  let pages;
  for (let i = 0; i < 100; i++) {
    try {
      pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (pages.length) break;
    } catch (_) {}
    await delay(150);
  }
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const it = pending.get(m.id); pending.delete(m.id);
      m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result);
    } else if (m.method && events.has(m.method)) {
      const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params));
    }
  });

  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 393, height: 852, screenWidth: 393, screenHeight: 852, deviceScaleFactor: 3, mobile: true,
  });
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: URL });
  await loaded;
  await delay(900);

  const title = await ev('document.title');
  check('页面标题正确', title.includes('Slicelog'), title);

  const urlOk = await ev('location.protocol');
  check('https 安全上下文', urlOk === 'https:', urlOk);

  const cards = await ev(`document.querySelectorAll('#view-dashboard .card, #view-dashboard .stat').length`);
  check('概览已渲染', cards > 3, `卡片数 ${cards}`);

  const overflow = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
  check('无横向溢出', overflow.sw <= overflow.cw + 1, `${overflow.sw}/${overflow.cw}`);

  const vis = await ev(`(() => { const b = document.body.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  check('视口尺寸贴合', vis.w === 393, JSON.stringify(vis));

  const manifestHref = await ev(`document.querySelector('link[rel="manifest"]') ? document.querySelector('link[rel="manifest"]').href : ''`);
  const manifestOk = await ev(`fetch(document.querySelector('link[rel="manifest"]').href).then(r => r.ok ? r.json().then(j => j.name) : 'HTTP_' + r.status).catch(e => 'ERR_' + e.message)`);
  check('manifest 可取到', typeof manifestOk === 'string' && manifestOk.includes('Slicelog'), `${manifestOk} | ${manifestHref}`);

  const iconOk = await ev(`fetch('icons/icon-180.png').then(r => r.ok ? r.status + ' ' + (r.headers.get('content-type')||'') : 'HTTP_' + r.status).catch(e => 'ERR')`);
  check('主屏图标可下载', String(iconOk).includes('200'), String(iconOk));

  const swState = await ev(`navigator.serviceWorker.getRegistration().then(r => r ? (r.active ? 'active' : (r.installing ? 'installing' : 'waiting')) : 'none').catch(e => 'ERR_' + e.message)`);
  check('离线缓存已激活', swState === 'active', String(swState));

  const cached = await ev(`caches.keys().then(ks => Promise.all(ks.map(k => caches.open(k).then(c => c.keys().then(a => a.length))))).then(a => a.join(',')).catch(() => 'none')`);
  check('缓存内有资源', cached !== 'none' && !cached.startsWith('0'), String(cached));

  const appleMeta = await ev(`!!document.querySelector('meta[name="apple-mobile-web-app-capable"]') && !!document.querySelector('link[rel="apple-touch-icon"]')`);
  check('iOS 主屏 meta 齐全', appleMeta === true);

  const safe = await ev(`(() => { const s = getComputedStyle(document.documentElement); return { t: s.getPropertyValue('--sat').trim(), b: s.getPropertyValue('--sab').trim() }; })()`);
  check('安全区变量已注入', safe.t !== undefined, JSON.stringify(safe));

  await send('Page.captureScreenshot', { format: 'png' }).then(async r => {
    require('fs').writeFileSync(path.join(root, 'shots', 'live-iphone.png'), Buffer.from(r.data, 'base64'));
  });

  // 切换到目标页与记账页各截一张
  for (const [view, name] of [['goals', 'live-goals.png'], ['finance', 'live-finance.png']]) {
    await ev(`switchView('${view}')`);
    await delay(500);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(root, 'shots', name), Buffer.from(r.data, 'base64'));
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
  ws.close();
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => setTimeout(() => browser.kill(), 400));
