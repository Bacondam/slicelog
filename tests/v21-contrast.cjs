/** v2.1 新增元素跨主题对比度：学习型目标卡 / 学习投入 / 概览「目标与学习」 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const port = 9358;
const profile = path.join(root, '.edge-v21-contrast');
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
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
    if (m.id && pending.has(m.id)) { const it = pending.get(m.id); pending.delete(m.id); m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result); }
    else if (m.method && events.has(m.method)) { const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params)); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 452, height: 994, screenWidth: 452, screenHeight: 994, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, exportBackup(){}, setSystemBars(){}, getScreenInfo(){return '';} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded;
  await evaluate('document.fonts.ready');

  await evaluate(`(() => { state = seedState(); saveState(); switchView('goals'); })()`);
  await delay(250);

  const audit = await evaluate(`(() => {
    const parse = c => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
      const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
      return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); };
    const bgOf = el => { let n = el; while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > .97) return c; n = n.parentElement; }
      return parse(getComputedStyle(document.body).backgroundColor); };
    const pick = (sel, root) => {
      const el = (root || document).querySelector(sel); if (!el) return null;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color); const bg = bgOf(el);
      return { sel, color: cs.color, bg: \`rgb(\${bg.r},\${bg.g},\${bg.b})\`, ratio: +ratio(fg, bg).toFixed(2), size: cs.fontSize };
    };

    const rows = {};
    for (const t of THEMES) {
      applyTheme(t.id);
      switchView('goals');
      const goalTexts = [
        pick('#view-goals .goal-card.is-learn .chip.kind'),
        pick('#view-goals .goal-card.is-learn .learn-line'),
        pick('#view-goals .goal-card.is-learn .goal-due'),
        pick('#view-goals .learn-strip .ls-item'),
        pick('#view-goals .learn-strip .ls-item b'),
        pick('#view-goals .filter-chip.learn'),
        pick('#view-goals .filter-chip.learn.on')
      ].filter(Boolean);
      switchView('dashboard');
      const dashTexts = [
        pick('#view-dashboard .mini-kind'),
        pick('#view-dashboard .mini-learn span'),
        pick('#view-dashboard .goal-mini .row .link-btn')
      ].filter(Boolean);
      rows[t.id] = {
        dark: !!t.dark,
        texts: goalTexts.concat(dashTexts),
        chipBorder: (() => {
          switchView('goals');
          const el = document.querySelector('#view-goals .filter-chip.learn');
          if (!el) return 0;
          return +ratio(parse(getComputedStyle(el).borderTopColor), bgOf(el)).toFixed(2);
        })()
      };
    }
    applyTheme('oat'); switchView('goals'); render();
    return { rows, cardCount: document.querySelectorAll('#view-goals .goal-card.is-learn').length };
  })()`);

  assert(audit.cardCount === 3, `学习卡数量异常：${audit.cardCount}`);

  let bad = 0;
  for (const [id, v] of Object.entries(audit.rows)) {
    const min = Math.min(...v.texts.map(t => t.ratio));
    const ok = min >= 4.5;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(9)} 学习元素文字最低 ${min.toFixed(2)}:1 · 类型 chip 描边 ${v.chipBorder}:1`);
    if (!ok) v.texts.filter(t => t.ratio < 4.5).forEach(t => console.log(`      ${t.sel} ${t.color} on ${t.bg} = ${t.ratio}:1`));
  }
  assert(bad === 0, `有 ${bad} 套主题的对比度低于 4.5:1`);
  console.log('\n学习相关元素对比度全部达标');
  ws.close();
})().catch(e => { console.error('✗ ' + (e.stack || e.message)); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
