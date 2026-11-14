/** v1.9.E 新增元素跨主题对比度：已归档行 / 批量整理弹窗 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const port = 9356;
const profile = path.join(root, '.edge-v19e-contrast');
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

  await evaluate(`(() => {
    state = seedState();
    const n = Date.now(), d = 86400000;
    state.goals.push({ id: 'x1', title: '早起 100 天', category: '健康', current: 100, target: 100, unit: '天', deadline: '', createdAt: n - d * 120, done: true, doneAt: n - d * 30, subtasks: [] });
    state.archivedGoals = [{ id: 'a1', title: '连续记账 90 天', category: '财务', current: 90, target: 90, unit: '天', done: true, doneAt: n - d * 45, archivedAt: n - d * 10, subtasks: [], createdAt: n - d * 200 }];
    state.settings.archOpen = true;
    saveState(); render(); switchView('goals');
  })()`);
  await delay(200);

  const audit = await evaluate(`(() => {
    const parse = c => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
      const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
      return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); };
    const bgOf = el => { let n = el; while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > .97) return c; n = n.parentElement; }
      return parse(getComputedStyle(document.body).backgroundColor); };

    const pick = (sel) => {
      const el = document.querySelector(sel); if (!el) return null;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color); const bg = bgOf(el);
      return { sel, color: cs.color, bg: \`rgb(\${bg.r},\${bg.g},\${bg.b})\`, ratio: +ratio(fg, bg).toFixed(2), size: cs.fontSize };
    };

    const rows = {};
    for (const t of THEMES) {
      applyTheme(t.id);
      render();
      rows[t.id] = {
        dark: !!t.dark,
        texts: [
          pick('#view-goals .arch-row .ar-title'),
          pick('#view-goals .arch-row .ar-meta'),
          pick('#view-goals .arch-row [data-action="arch-restore"]'),
          pick('#view-goals .head-tools [data-action="open-goal-batch"]')
        ].filter(Boolean),
        borders: (() => {
          const el = document.querySelector('#view-goals .arch-row');
          const c = parse(getComputedStyle(el).borderTopColor);
          return { ratio: +ratio(c, bgOf(el)).toFixed(2) };
        })()
      };
    }

    /* 弹窗（深色主题最容易翻车） */
    applyTheme('pine'); render();
    openGoalBatchModal();
    document.querySelectorAll('#modalBox [data-gb-id]')[0].click();
    const gb = {
      card: parse(getComputedStyle(document.querySelector('#modalBox .gb-item')).backgroundColor),
      texts: [
        pick('#modalBox .gb-title'),
        pick('#modalBox .gb-meta'),
        pick('#modalBox .gb-note'),
        pick('#modalBox .link-btn'),
        pick('#modalBox [data-gb="delete"]'),
        pick('#modalBox [data-gb="archive"]')
      ].filter(Boolean),
      checkBorder: (() => {
        const el = document.querySelector('#modalBox .gb-item:nth-child(2) .gb-check');
        const c = parse(getComputedStyle(el).borderTopColor);
        return +ratio(c, bgOf(el)).toFixed(2);
      })()
    };
    closeModal();
    applyTheme('oat'); render();
    return { rows, gb };
  })()`);

  let bad = 0;
  for (const [id, v] of Object.entries(audit.rows)) {
    const min = Math.min(...v.texts.map(t => t.ratio));
    const ok = min >= 4.5;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(9)} 归档文字最低 ${min.toFixed(2)}:1 · 虚线描边 ${v.borders.ratio}:1`);
    if (!ok) v.texts.filter(t => t.ratio < 4.5).forEach(t => console.log(`      ${t.sel} ${t.color} on ${t.bg} = ${t.ratio}:1`));
  }
  const gbMin = Math.min(...audit.gb.texts.map(t => t.ratio));
  console.log(`  ${gbMin >= 4.5 ? '✓' : '✗'} pine/弹窗  文字最低 ${gbMin.toFixed(2)}:1 · 勾选框描边 ${audit.gb.checkBorder}:1`);
  if (gbMin < 4.5) bad++;

  assert(bad === 0, `有 ${bad} 处对比度低于 4.5:1`);
  assert(audit.gb.checkBorder >= 1.5, `勾选框描边太淡：${audit.gb.checkBorder}:1`);
  console.log('\n对比度全部达标');
  ws.close();
})().catch(e => { console.error('✗ ' + (e.stack || e.message)); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
