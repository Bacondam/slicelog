/** v2.2 新增元素跨主题对比度：按数量目标的「更新进度」行 / 弹窗里的推进方式分段 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const port = 9362;
const profile = path.join(root, '.edge-v22-contrast');
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

    state = seedState(); saveState();
    const rows = {};
    for (const t of THEMES) {
      applyTheme(t.id);
      switchView('goals'); render();
      const cardTexts = [
        pick('#view-goals .goal-card.is-count .cl-tip'),
        pick('#view-goals .goal-card.is-count .count-line .link-btn'),
        pick('#view-goals .goal-card .goal-prog .cnt'),
        pick('#view-goals .goal-card .goal-due'),
        pick('#view-goals .goal-card .sub-empty'),
        pick('#view-goals .filter-chip'),
        pick('#view-goals .filter-chip.on')
      ].filter(Boolean);

      openGoalModal();
      const modalTexts = [
        pick('#modal .track-seg button'),
        pick('#modal .track-seg button.active'),
        pick('#modal .tl-note'),
        pick('#modal .cat-opt.on')
      ].filter(Boolean);
      const segBorder = (() => {
        const el = document.querySelector('#modal .track-seg');
        return +ratio(parse(getComputedStyle(el).borderTopColor), bgOf(el)).toFixed(2);
      })();
      closeModal();

      rows[t.id] = { dark: !!t.dark, texts: cardTexts.concat(modalTexts), segBorder };
    }
    applyTheme('oat'); switchView('dashboard'); render();
    return { rows };
  })()`);

  let bad = 0;
  for (const [id, v] of Object.entries(audit.rows)) {
    const min = Math.min(...v.texts.map(t => t.ratio));
    const ok = min >= 4.5;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(9)} 目标卡 / 推进方式文字最低 ${min.toFixed(2)}:1 · 分段描边 ${v.segBorder}:1`);
    if (!ok) v.texts.filter(t => t.ratio < 4.5).forEach(t => console.log(`      ${t.sel} ${t.color} on ${t.bg} = ${t.ratio}:1`));
  }
  assert(bad === 0, `有 ${bad} 套主题的对比度低于 4.5:1`);
  console.log('\n目标卡与「怎么推进」分段对比度全部达标');
  ws.close();
})().catch(e => { console.error('✗ ' + (e.stack || e.message)); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
