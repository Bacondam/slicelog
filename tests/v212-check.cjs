/** v2.12 回归：年度支出构成环形图 / 日期框点开系统日历 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9362;
const profile = path.join(root, '.edge-v212-profile');
const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
let ws, nextId = 0;
const pending = new Map();
const events = new Map();
const results = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
function pass(name, detail) {
  results.push({ name, ok: true });
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
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const it = pending.get(m.id); pending.delete(m.id);
      m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result);
    } else if (m.method && events.has(m.method)) {
      const l = events.get(m.method); events.delete(m.method);
      l.forEach(r => r(m.params));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, screenWidth: 414, screenHeight: 896, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, getScreenInfo(){return 'test';}, exportBackup(){}, setSystemBars(){}, openAppSettings(){}, setGoalReminders(){}, notifyStatus(){return '{"notify":true,"guard":true,"battery":false,"api":34}';} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate(`state = seedState(); saveState(); render();`);
  await delay(300);

  /* ---------- 1. 年度卡片：环形图，不是折线 ---------- */
  await evaluate(`switchView('finance'); financeMode='year'; financeYear=2026; render();`);
  const card = await evaluate(`(() => {
    const c = [...document.querySelectorAll('.card')].find(x => {
      const h = x.querySelector('h3'); return h && /支出构成/.test(h.textContent);
    });
    const svg = c && c.querySelector('.donut');
    return {
      title: c ? c.querySelector('h3').textContent.trim() : '',
      hasDonut: !!svg,
      hasLine: !!document.querySelector('.y-line'),
      slices: svg ? svg.querySelectorAll('circle[stroke]:not([stroke="var(--line)"])').length : 0,
      rows: c ? c.querySelectorAll('.donut-legend li').length : 0,
      pct: c ? [...c.querySelectorAll('.donut-legend .dn-pct')].map(e => parseFloat(e.textContent)) : [],
      names: c ? [...c.querySelectorAll('.donut-legend .dn-name')].map(e => e.textContent) : [],
      centerVal: c && c.querySelector('.dn-v') ? c.querySelector('.dn-v').textContent : '',
      centerLabel: c && c.querySelector('.dn-l') ? c.querySelector('.dn-l').textContent : ''
    };
  })()`);
  assert(card.title === '支出构成', '卡片标题应为「支出构成」，实际：' + card.title);
  assert(card.hasDonut, '年度卡里没有渲染环形图');
  assert(!card.hasLine, '折线图结构仍然存在');
  assert(card.rows >= 3, '图例条目过少：' + card.rows);
  assert(card.centerLabel === '全年支出', '圆环中心标签应为「全年支出」，实际：' + card.centerLabel);
  assert(/¥|万/.test(card.centerVal), '圆环中心没有金额：' + card.centerVal);
  const pctSum = card.pct.reduce((a, b) => a + b, 0);
  assert(Math.abs(pctSum - 100) <= 1.5, '各分类占比合计应接近 100%，实际：' + pctSum);
  pass('年度支出构成环形图', `${card.rows} 个分类 · 占比合计 ${pctSum.toFixed(1)}% · 中心 ${card.centerVal}`);

  /* ---------- 2. 分类按金额从大到小排 ---------- */
  const ordered = await evaluate(`(() => {
    const c = [...document.querySelectorAll('.card')].find(x => {
      const h = x.querySelector('h3'); return h && /支出构成/.test(h.textContent);
    });
    const p = [...c.querySelectorAll('.donut-legend .dn-pct')].map(e => parseFloat(e.textContent));
    return p.every((v, i) => i === 0 || p[i - 1] >= v);
  })()`);
  assert(ordered, '图例没有按占比从大到小排');
  pass('图例排序', '占比从高到低');

  /* ---------- 3. 没有支出时给提示，而不是空圆环 ---------- */
  const emptyCase = await evaluate(`(() => {
    const bak = JSON.parse(JSON.stringify(state.finance));
    state.finance.transactions = [];
    saveState();
    financeMode = 'year'; financeYear = 2026; render();
    const c = [...document.querySelectorAll('.card')].find(x => {
      const h = x.querySelector('h3'); return h && /支出构成/.test(h.textContent);
    });
    const out = { hasDonut: !!c.querySelector('.donut'), empty: c.querySelector('.empty') ? c.querySelector('.empty').textContent.trim() : '' };
    state.finance = bak; saveState();
    financeMode = 'year'; financeYear = 2026; render();
    return out;
  })()`);
  assert(!emptyCase.hasDonut, '空数据时应隐藏环形图');
  assert(/还没有支出记录/.test(emptyCase.empty), '空数据提示文案不对：' + emptyCase.empty);
  pass('空数据兜底', '无支出时提示「还没有支出记录」');

  /* ---------- 4. 月度视图的环形图没被牵连 ---------- */
  const monthDonut = await evaluate(`(() => {
    financeMode = 'month'; financeMonth = '2026-08'; finTab = 'cat'; render();
    const panel = document.querySelector('.fin-panel[data-panel="cat"]');
    const out = { ok: !!panel, donut: !!(panel && panel.querySelector('.donut')), rows: panel ? panel.querySelectorAll('.donut-legend li').length : 0 };
    finTab = 'tx';
    return out;
  })()`);
  assert(monthDonut.ok && monthDonut.donut, '月度「支出分类」里的环形图被改坏了');
  assert(monthDonut.rows >= 2, '月度环形图图例条目异常：' + monthDonut.rows);
  pass('月度视图未受影响', `支出分类环形图仍正常 · ${monthDonut.rows} 个分类`);

  /* ---------- 5. 日期框：点一下真的能拉起日历 ---------- */
  const dateTap = await evaluate(`(() => {
    financeMode = 'month'; financeMonth = '2026-11';
    state.settings.finQuickCollapsed = false; render();
    const inp = document.querySelector('#txForm input[name="date"]');
    if (!inp) return { ok: false };
    window.__picks = 0;
    inp.showPicker = function () { window.__picks++; };
    inp.click();
    const afterFirst = window.__picks;
    inp.click(); /* 700ms 内的第二次应被防抖拦下，避免双弹 */
    return {
      ok: true,
      isDate: inp.type === 'date',
      afterFirst,
      afterSecond: window.__picks,
      userSelect: getComputedStyle(inp).webkitUserSelect || getComputedStyle(inp).userSelect,
      hasIcon: !!document.querySelector('#txForm .df-ico svg')
    };
  })()`);
  assert(dateTap.ok, '找不到记账表单的日期框');
  assert(dateTap.isDate, '日期框不是 input[type=date]');
  assert(dateTap.afterFirst === 1, '点日期框没有调用 showPicker，计数：' + dateTap.afterFirst);
  assert(dateTap.afterSecond === 1, '连点两次弹了两次日历，计数：' + dateTap.afterSecond);
  assert(dateTap.userSelect === 'none', '日期框仍允许选中文本（会导致手指按下变蓝色选中）：' + dateTap.userSelect);
  assert(dateTap.hasIcon, '日历图标丢了');
  pass('点日期框弹日历', 'showPicker 生效 · 连点不重复弹 · 文本不可选');

  /* ---------- 6. 编辑弹窗里的日期同样能点开 ---------- */
  const editTap = await evaluate(`(() => {
    const tx = state.finance.transactions[0];
    openTxModal(tx.id);
    const inp = document.querySelector('.modal input[name="date"]');
    if (!inp) return { ok: false };
    window.__picks2 = 0;
    inp.showPicker = function () { window.__picks2++; };
    inp.click();
    const n = window.__picks2;
    closeModal && closeModal();
    return { ok: true, picks: n, value: inp.value };
  })()`);
  assert(editTap.ok, '编辑弹窗里找不到日期框');
  assert(editTap.picks === 1, '编辑弹窗点日期没弹出日历，计数：' + editTap.picks);
  pass('编辑弹窗日期可点', '值 ' + editTap.value);

  /* ---------- 7. 提交后日期仍然写对 ---------- */
  const submitted = await evaluate(`(() => {
    financeMonth = '2026-11'; state.settings.finQuickCollapsed = false; render();
    const form = document.querySelector('#txForm');
    form.querySelector('[name="amount"]').value = '18';
    form.querySelector('[name="date"]').value = '2026-09-09';
    form.querySelector('[name="note"]').value = '环形图回归';
    form.requestSubmit();
    const hit = state.finance.transactions.filter(t => t.date === '2026-09-09');
    return { n: hit.length, amount: hit.length ? hit[hit.length - 1].amount : 0 };
  })()`);
  assert(submitted.n === 1, '提交后没找到 2026-09-09 这笔：' + submitted.n);
  assert(submitted.amount === 18, '金额写错：' + submitted.amount);
  pass('日期提交正确', '2026-09-09 记账成功');

  /* ---------- 8. 六套主题下环形图文字对比度 ---------- */
  const audit = await evaluate(`(() => {
    const parse = c => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
      const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
      return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); };
    const bgOf = el => { let n = el; while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > .97) return c; n = n.parentElement; }
      return parse(getComputedStyle(document.body).backgroundColor); };
    const pick = sel => { const el = document.querySelector(sel); if (!el) return null;
      const cs = getComputedStyle(el); const bg = bgOf(el);
      return { sel, ratio: +ratio(parse(cs.color), bg).toFixed(2) }; };

    const rows = {};
    for (const t of THEMES) {
      applyTheme(t.id);
      switchView('finance'); financeMode = 'year'; financeYear = 2026; render();
      rows[t.id] = [
        pick('.year-donut .dn-v'),
        pick('.year-donut .dn-l'),
        pick('.year-donut .donut-legend .dn-name'),
        pick('.year-donut .donut-legend .dn-pct'),
        pick('.year-donut .donut-legend .dn-val')
      ].filter(Boolean);
    }
    applyTheme('oat'); financeMode = 'month'; render();
    return rows;
  })()`);

  let bad = 0;
  for (const [id, list] of Object.entries(audit)) {
    const min = Math.min(...list.map(x => x.ratio));
    const ok = min >= 4.5;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(9)} 环形图文字最低 ${min.toFixed(2)}:1`);
    if (!ok) list.filter(x => x.ratio < 4.5).forEach(x => console.log(`      ${x.sel} = ${x.ratio}:1`));
  }
  assert(bad === 0, `有 ${bad} 套主题的环形图文字对比度低于 4.5:1`);
  pass('环形图对比度', '6 套主题全部 ≥ 4.5:1');

  /* ---------- 9. 提醒自检已移除（v2.15）：改由 v215-check.cjs 负责设置面板与提醒清除检查 ---------- */

  /* ---------- 10. 清空数据：两道确认，中间取消不删 ---------- */
  const wipe = await evaluate(`(async () => {
    state = seedState(); saveState(); switchView('finance'); render();
    const before = state.finance.transactions.length;
    document.querySelector('#resetBtn').click();
    const t1 = document.querySelector('#confirmTitle').textContent;
    document.querySelector('#confirmOk').click();
    await new Promise(r => setTimeout(r, 320));
    const t2 = document.querySelector('#confirmTitle').textContent;
    const keptAfterFirst = state.finance.transactions.length;
    document.querySelector('#confirmCancel').click();
    await new Promise(r => setTimeout(r, 80));
    const keptAfterCancel = state.finance.transactions.length;

    document.querySelector('#resetBtn').click();
    document.querySelector('#confirmOk').click();
    await new Promise(r => setTimeout(r, 320));
    document.querySelector('#confirmOk').click();
    await new Promise(r => setTimeout(r, 80));
    return {
      before, t1, t2, keptAfterFirst, keptAfterCancel,
      afterWipe: state.finance.transactions.length,
      drawerClosed: !document.querySelector('.sidebar-foot').classList.contains('mobile-open')
    };
  })()`);
  assert(wipe.t1 === '清空所有数据', '第一道确认标题不对：' + wipe.t1);
  assert(wipe.keptAfterFirst === wipe.before, '第一道确认后就把数据删了');
  assert(wipe.t2 === '真的要清空？', '第二道确认标题不对：' + wipe.t2);
  assert(wipe.keptAfterCancel === wipe.before, '第二道确认点取消仍然删了数据');
  assert(wipe.afterWipe === 0, '两道都确认后没有清空，剩余：' + wipe.afterWipe);
  assert(wipe.drawerClosed, '点清空后设置抽屉没有收起');
  pass('清空数据两道确认', '第一次不删 · 取消不删 · 都确认才清空');

  /* 恢复演示数据，别影响后面手工查看 */
  await evaluate(`state = seedState(); saveState(); render();`);

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main()
  .catch(e => {
    console.error('\n✗ ' + (e.stack || e.message));
    process.exitCode = 1;
  })
  .finally(() => {
    try { ws && ws.close(); } catch (_) {}
    setTimeout(() => browser.kill(), 300);
  });
