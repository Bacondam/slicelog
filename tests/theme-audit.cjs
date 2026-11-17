/** v1.9.D 主题审计：六套配色 × 全部视图/弹窗，逐项检查文字与控件对比度 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9363;
const profile = path.join(root, '.edge-audit-profile');
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
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, getScreenInfo(){return 'test';}, exportBackup(){}, setSystemBars(){}, openAppSettings(){} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate(`state = seedState(); state.settings.journalCollapsed = true; saveState(); render();`);
  await delay(300);


  /* 页面内工具：把 rgba 叠成实际底色，再算 WCAG 对比度 */
  const TOOL = `
    window.__audit = {
      parse(c) {
        const m = c && c.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
      },
      lum(c) {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      },
      effBg(el) {
        const chain = [];
        let n = el;
        while (n) { chain.push(n); n = n.parentElement; }
        chain.reverse();
        let acc = { r: 255, g: 255, b: 255 };
        for (const node of chain) {
          const c = this.parse(getComputedStyle(node).backgroundColor);
          if (c && c.a > 0) acc = { r: c.r * c.a + acc.r * (1 - c.a), g: c.g * c.a + acc.g * (1 - c.a), b: c.b * c.a + acc.b * (1 - c.a) };
        }
        return acc;
      },
      ratio(fg, bg) {
        const a = this.lum(fg), b = this.lum(bg);
        const hi = Math.max(a, b), lo = Math.min(a, b);
        return (hi + 0.05) / (lo + 0.05);
      },
      textRatio(el) {
        const cs = getComputedStyle(el);
        const fg = this.parse(cs.color);
        const bg = this.effBg(el);
        if (!fg) return null;
        const solid = fg.a >= 1 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
        return this.ratio(solid, bg);
      },
      borderRatio(el) {
        const cs = getComputedStyle(el);
        const bc = this.parse(cs.borderTopColor);
        if (!bc || !parseFloat(cs.borderTopWidth)) return null;
        const bg = this.effBg(el);
        const solid = bc.a >= 1 ? bc : { r: bc.r * bc.a + bg.r * (1 - bc.a), g: bc.g * bc.a + bg.g * (1 - bc.a), b: bc.b * bc.a + bg.b * (1 - bc.a) };
        return this.ratio(solid, bg);
      },
      visible(el) {
        if (!el || el.offsetParent === null) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      },
      scanText(selectors) {
        const list = [];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            if (!this.visible(el)) return;
            if (!el.textContent.trim()) return;
            const r = this.textRatio(el);
            if (r == null) return;
            list.push({ sel, text: el.textContent.trim().slice(0, 18), ratio: +r.toFixed(2) });
          });
        }
        return list;
      },
      scanBorder(selectors) {
        const list = [];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            if (!this.visible(el)) return;
            const r = this.borderRatio(el);
            if (r == null) return;
            list.push({ sel, ratio: +r.toFixed(2) });
          });
        }
        return list;
      },
      whites() {
        const hits = [];
        document.querySelectorAll('*').forEach(el => {
          if (!this.visible(el)) return;
          const c = getComputedStyle(el).backgroundColor;
          if (c === 'rgb(255, 255, 255)') hits.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
        });
        return [...new Set(hits)].slice(0, 12);
      }
    };`;
  await evaluate(TOOL);

  const TEXT_SEL = ['h2', 'h3', 'strong', 'p', '.muted', '.small', '.hint', '.stat-top span', '.fin-fact span',
    '.fin-fact strong', '.tx-title', '.tx-sub', '.tx-amount', '.sdate', '.stitle', '.smin', '.fname', '.fcount',
    '.chip', '.link-btn', '.btn.ghost', '.cselect-btn', '.label', '.tag', '.cat-top span', '.donut-legend li'];
  const CTRL_SEL = ['input', 'textarea', '.cselect-btn', '.icon-btn', '.collapse-btn.pm', '.btn.ghost', '.mini-select + *', '.month-nav .nav-btn', '.seg'];
  const VIEWS = ['dashboard', 'goals', 'habits', 'journal', 'learning', 'finance'];

  const report = [];
  const failures = [];

  for (const theme of ['oat', 'mist', 'clay', 'cedar', 'paper', 'ink']) {
    await evaluate(`applyTheme('${theme}')`);
    const dark = await evaluate(`document.documentElement.getAttribute('data-mode') === 'dark'`);
    let minText = 99, minTextWhat = '', minCtl = 99, minCtlWhat = '', total = 0, lowText = 0, all = [];
    for (const view of VIEWS) {
      await evaluate(`switchView('${view}')`);
      await delay(120);
      const t = await evaluate(`__audit.scanText(${JSON.stringify(TEXT_SEL)})`);
      const b = await evaluate(`__audit.scanBorder(${JSON.stringify(CTRL_SEL)})`);
      for (const row of t) {
        total++;
        all.push(Object.assign({ view }, row));
        if (row.ratio < 4.5) lowText++;
        if (row.ratio < minText) { minText = row.ratio; minTextWhat = `${view} ${row.sel}「${row.text}」`; }
      }
      for (const row of b) {
        if (row.ratio < minCtl) { minCtl = row.ratio; minCtlWhat = `${view} ${row.sel}`; }
      }
    }
    let whites = [];
    if (dark) whites = await evaluate(`__audit.whites()`);
    all.sort((a, b) => a.ratio - b.ratio);
    report.push({ theme, dark, worst: all.slice(0, 5), minText: +minText.toFixed(2), minTextWhat, minCtl: +minCtl.toFixed(2), minCtlWhat, samples: total, lowText, whites });
    if (minText < 3.0) failures.push(`${theme} 有文字对比度只有 ${minText.toFixed(2)}:1（${minTextWhat}）`);
    if (minCtl < 1.4) failures.push(`${theme} 有控件描边只有 ${minCtl.toFixed(2)}:1（${minCtlWhat}）`);
    if (dark && whites.length) failures.push(`${theme} 深色下仍有纯白底元素：${whites.join(' / ')}`);
  }

  console.log('\n  主题       模式   文字最低   控件描边最低   样本   低于4.5:1');
  report.forEach(r => {
    console.log(`  ${r.theme.padEnd(9)} ${r.dark ? '深色' : '浅色'}  ${String(r.minText).padStart(6)}:1  ${String(r.minCtl).padStart(9)}:1  ${String(r.samples).padStart(5)}  ${String(r.lowText).padStart(6)}`);
    console.log('     最低几处：' + r.worst.map(w => `${w.view} ${w.sel} ${w.ratio}`).join(' | '));
    console.log('     描边最低：' + r.minCtlWhat + ' ' + r.minCtl);
  });
  console.log('');
  assert(failures.length === 0, failures.join('\n'));
  pass('六套主题 × 六个视图对比度', `文字最低 ${Math.min(...report.map(r => r.minText)).toFixed(2)}:1，控件描边最低 ${Math.min(...report.map(r => r.minCtl)).toFixed(2)}:1`);

  /* ---------- 下拉：全部换成自绘，原生 select 不再直接出现在界面 ---------- */
  await evaluate(`applyTheme('ink'); switchView('finance')`);
  await delay(150);
  const sel = await evaluate(`(() => {
    const all = [...document.querySelectorAll('#view-finance select')];
    const wrapped = all.filter(s => s.classList.contains('cselect-native'));
    const visibleNative = all.filter(s => __audit.visible(s));
    return { total: all.length, wrapped: wrapped.length, visibleNative: visibleNative.length };
  })()`);
  assert(sel.total > 0 && sel.wrapped === sel.total, `还有原生下拉没被接管：${sel.wrapped}/${sel.total}`);
  assert(sel.visibleNative === 0, '界面上仍有可见的原生 select');
  pass('下拉全部自绘', `${sel.total} 个 select 均被主题化按钮接管`);

  /* ---------- 下拉面板在每套主题下都可读 ---------- */
  const popRatios = [];
  for (const theme of ['oat', 'mist', 'clay', 'cedar', 'paper', 'ink']) {
    const r = await evaluate(`(async () => {
      applyTheme('${theme}');
      switchView('finance');
      openTxModal();
      document.querySelector('#modalBox [data-action="open-cselect"]').click();
      await new Promise(r => setTimeout(r, 220));
      const opts = [...document.querySelectorAll('#cselectPop .cs-opt')];
      const list = opts.map(o => __audit.textRatio(o));
      const sheetBg = __audit.effBg(document.querySelector('#cselectPop .cs-sheet'));
      document.querySelector('#cselectPop .cs-mask').click();
      await new Promise(r => setTimeout(r, 220));
      closeModal();
      return { min: Math.min(...list), count: opts.length, sheetBg };
    })()`);
    assert(r.count === 2, `下拉选项数量异常：${r.count}`);
    assert(r.min >= 4.5, `${theme} 下拉选项对比度只有 ${r.min.toFixed(2)}:1`);
    popRatios.push(+r.min.toFixed(2));
  }
  pass('下拉面板可读', `六套主题选项对比度最低 ${Math.min(...popRatios)}:1`);

  /* ---------- 弹窗框架：描边比结构线更亮，深色下也不糊 ---------- */
  const modal = await evaluate(`(async () => {
    applyTheme('ink');
    switchView('finance');
    openTxModal();
    await new Promise(r => setTimeout(r, 120));
    const m = document.querySelector('#modalBox');
    const border = __audit.borderRatio(m);
    const bg = __audit.effBg(m);
    const txt = __audit.textRatio(m.querySelector('h3'));
    closeModal();
    applyTheme('oat');
    return { border, bg, txt };
  })()`);
  assert(modal.border >= 1.4, `弹窗描边太弱：${modal.border.toFixed(2)}:1`);
  assert(modal.txt >= 4.5, `弹窗标题对比度不足：${modal.txt.toFixed(2)}:1`);
  pass('弹窗框架', `深色下描边 ${modal.border.toFixed(2)}:1，标题 ${modal.txt.toFixed(2)}:1`);

  /* ---------- 收起只留一行：大卡片折叠后高度明显变小 ---------- */
  await evaluate(`applyTheme('oat'); switchView('finance')`);
  await delay(150);
  const fold = await evaluate(`(() => {
    const card = document.querySelector('[data-key="fin:txs"]').closest('.fold-card');
    const before = Math.round(card.getBoundingClientRect().height);
    document.querySelector('[data-key="fin:txs"]').click();
    const after = Math.round(document.querySelector('[data-key="fin:txs"]').closest('.fold-card').getBoundingClientRect().height);
    const stored = state.settings.cardFold['fin:txs'];
    document.querySelector('[data-key="fin:txs"]').click();
    return { before, after, stored };
  })()`);
  assert(fold.after < 80, `大卡片收起后仍有 ${fold.after}px 高`);
  assert(fold.before > fold.after * 2, '大卡片折叠前后高度差不明显');
  assert(fold.stored === false, '折叠状态没有写入 settings.cardFold');
  pass('大卡片折叠', `账单明细 ${fold.before}px → ${fold.after}px，状态已记忆`);

  /* ---------- 日记：保存后自动收起并露出刚写的那篇 ---------- */
  await evaluate(`state.settings.journalCollapsed = false; switchView('journal', { openJournal: true })`);
  await delay(150);
  const jr = await evaluate(`(() => {
    const form = document.getElementById('journalForm');
    form.elements.good.value = '今天把记账页的框架理了一遍';
    form.requestSubmit();
    return {
      formGone: !document.getElementById('journalForm'),
      collapsed: !!state.settings.journalCollapsed,
      firstEntry: (document.querySelector('#view-journal .journal-entry p') || {}).textContent || '',
      entries: document.querySelectorAll('#view-journal .journal-entry').length
    };
  })()`);
  assert(jr.formGone && jr.collapsed, '保存日记后写作区没有收起');
  assert(jr.entries >= 1, '保存后看不到日记列表');
  assert(/记账页/.test(jr.firstEntry), '刚写的日记没有出现在列表里');
  await evaluate(`switchView('dashboard'); switchView('journal')`);
  await delay(120);
  const jr2 = await evaluate(`({ form: !!document.getElementById('journalForm'), collapsed: !!state.settings.journalCollapsed })`);
  assert(jr2.form === false && jr2.collapsed, '再次进入日记页时写作区没有保持收起');
  pass('日记保存后收起', '存完立即收起并露出新日记，再进来保持收起');

  /* ---------- 换了收支类型，分类下拉的按钮文案要跟着变 ---------- */
  const sync = await evaluate(`(async () => {
    applyTheme('ink');
    state.settings.finQuickCollapsed = false;
    switchView('finance');
    const form = document.getElementById('txForm');
    const typeSel = form.querySelector('select[name="type"]');
    form.querySelector('.cselect-btn').click();
    await new Promise(r => setTimeout(r, 200));
    document.querySelector('#cselectPop .cs-opt[data-idx="1"]').click();
    await new Promise(r => setTimeout(r, 260));
    const catSel = form.querySelector('select[name="category"]');
    const catBtn = catSel.closest('.cselect').querySelector('.cselect-btn');
    return {
      type: typeSel.value,
      typeLabel: form.querySelector('.cselect-btn').textContent.trim(),
      catLabel: catBtn.textContent.trim(),
      catFirst: catSel.options[0].textContent.trim(),
      catCount: catSel.options.length
    };
  })()`);
  assert(sync.type === 'income' && /收入/.test(sync.typeLabel), `类型下拉没有切到收入：${sync.typeLabel}`);
  assert(sync.catLabel === sync.catFirst, `分类按钮没跟着换：按钮「${sync.catLabel}」/ 首项「${sync.catFirst}」`);
  assert(sync.catCount === 6, `收入分类数量不对：${sync.catCount}`);
  pass('联动下拉', `切到收入后分类按钮同步为「${sync.catLabel}」，共 ${sync.catCount} 类`);

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('✗ ' + error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
