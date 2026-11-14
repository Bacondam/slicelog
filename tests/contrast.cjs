/* 逐主题读取关键元素的真实颜色并计算 WCAG 对比度 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

const ROOT = __dirname.replace(/[\\/]tests$/, '');
const PORT = 9433;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(ROOT, '.edge-contrast-profile')}`,
    'about:blank'], { stdio: 'ignore' });

  let pages;
  for (let i = 0; i < 80; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (pages.length) break; } catch (e) { }
    await delay(120);
  }
  const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge={getSafeInsets(){return '32,0,24,0';},exportBackup(){},setSystemBars(){},getScreenInfo(){return '';}};`
  });
  await send('Page.navigate', { url: pathToFileURL(path.join(ROOT, 'app/src/main/assets/index.html')).href });
  await delay(1800);

  const ids = await evaluate(`THEMES.map(t => t.id)`);
  const rows = [];
  for (const t of ids) {
    const r = await evaluate(`(() => {
      state.settings.theme = '${t}';
      applyTheme('${t}');
      render();
      const rgb = s => {
        const m = String(s).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map(x => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
      };
      const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
      const lum = c => {
        const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
        return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b);
      };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return Math.round((hi + .05) / (lo + .05) * 100) / 100; };
      const parseColor = el => {
        const cs = getComputedStyle(el);
        const bg = rgb(cs.backgroundColor);
        // 向上找第一个不透明的背景
        let n = el, base = null;
        while (n && n !== document.documentElement) {
          const c = rgb(getComputedStyle(n).backgroundColor);
          if (c && c.a > .6) { base = c; break; }
          n = n.parentElement;
        }
        if (!base) base = rgb(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
        const fgRaw = rgb(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
        const bgBase = bg && bg.a < .99 ? over(bg, base) : (bg || base);
        const fg = fgRaw.a < .99 ? over(fgRaw, bgBase) : fgRaw;
        return { fg, bg: bgBase };
      };
      const measure = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const { fg, bg } = parseColor(el);
        return { ratio: ratio(fg, bg), px: parseFloat(getComputedStyle(el).fontSize) };
      };
      const banner = measure('.demo-banner span');
      const hint = measure('.stat .hint');
      const label = measure('.stat .stat-top span');
      const navIdle = (() => {
        const b = [...document.querySelectorAll('#nav button')].find(x => !x.classList.contains('active'));
        if (!b) return null;
        const { fg, bg } = parseColor(b);
        return { ratio: ratio(fg, bg), px: parseFloat(getComputedStyle(b).fontSize) };
      })();
      const quote = measure('.page-sub.quote-line') || measure('#pageSub');
      const chip = measure('.chip');
      const navActive = (() => {
        const b = document.querySelector('#nav button.active');
        if (!b) return null;
        const { fg, bg } = parseColor(b);
        return { ratio: ratio(fg, bg), px: parseFloat(getComputedStyle(b).fontSize) };
      })();
      const primaryBtn = measure('.btn.primary');
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const onAccentEl = document.querySelector('.chip') || document.body;
      return { banner, hint, navIdle, navActive, chip, primaryBtn, quote, accent, mode: document.documentElement.dataset.mode };
    })()`);
    rows.push({ id: t, ...r });
  }

  console.log('主题'.padEnd(10), '模式'.padEnd(6), '提示条'.padEnd(10), '灰字'.padEnd(10), '底栏灰'.padEnd(9), '底栏选中'.padEnd(10), '分类chip'.padEnd(10), '主按钮');
  for (const r of rows) {
    const f = o => o ? String(o.ratio).padEnd(5) + '(' + o.px + ')' : '  -  ';
    console.log(r.id.padEnd(10), String(r.mode).padEnd(6), f(r.banner).padEnd(10), f(r.hint).padEnd(10), f(r.navIdle).padEnd(9), f(r.navActive).padEnd(10), f(r.chip).padEnd(10), f(r.primaryBtn));
  }
  const bad = rows.filter(r => [r.banner, r.hint, r.navIdle, r.navActive, r.chip, r.primaryBtn].some(o => o && o.ratio < 3));
  if (bad.length) console.log('\n低于 3:1 的：', bad.map(b => b.id).join(', ')); else console.log('\n全部 ≥3:1');
  ws.close(); browser.kill(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
