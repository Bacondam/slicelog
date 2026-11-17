/** v2.11 回归：月份选择器 / 日期回到原生日历（年度图断言已迁到 v212-check） */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9361;
const profile = path.join(root, '.edge-v211-profile');
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
    source: `window.AndroidBridge = { getSafeInsets(){return '32,0,24,0';}, getScreenInfo(){return 'test';}, exportBackup(){}, setSystemBars(){}, openAppSettings(){}, setGoalReminders(){}, notifyStatus(){return '{"notify":true,"exact":true,"battery":false,"api":34}';} };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate(`state = seedState(); saveState(); render();`);
  await delay(300);

  /* 年度卡片已改成「支出构成」环形图，折线相关断言迁到 v212-check.cjs */
  await evaluate(`switchView('finance'); financeMode='month'; financeMonth='2026-07'; render();`);

  /* ---------- 4. 月份选择器 ---------- */
  const pick = await evaluate(`(() => {
    document.querySelector('[data-action="fin-pick-month"]').click();
    const grid = document.querySelector('.mon-grid');
    return {
      open: !!grid,
      cells: grid ? grid.querySelectorAll('.mon-cell').length : 0,
      on: grid ? (grid.querySelector('.mon-cell.on') || {}).dataset?.m : '',
      hasAmounts: grid ? [...grid.querySelectorAll('.mon-cell.has span')].length : 0
    };
  })()`);
  assert(pick.open, '点「2026年X月」没有弹出月份面板');
  assert(pick.cells === 12, '月份格子应为 12 个，实际：' + pick.cells);
  assert(pick.on === '2026-07', '当前月高亮不对：' + pick.on);
  assert(pick.hasAmounts === 5, '有记录的月份应有金额提示，实际：' + pick.hasAmounts);
  pass('月份选择器', '12 格 · 当前月高亮 · 5 个月显示结余');

  const afterPick = await evaluate(`(() => {
    document.querySelector('.mon-cell[data-m="2026-03"]').click();
    return { month: financeMonth, closed: !document.querySelector('.mon-grid') };
  })()`);
  assert(afterPick.month === '2026-03', '选 3 月后 financeMonth 不对：' + afterPick.month);
  assert(afterPick.closed, '选完月份面板没有关闭');
  pass('选月生效', '跳到 2026-03 并收起面板');

  /* ---------- 5. 日期回到原生输入 ---------- */
  const dateField = await evaluate(`(() => {
    financeMonth = '2026-11'; state.settings.finQuickCollapsed = false; render();
    const form = document.querySelector('#txForm');
    const inp = form && form.querySelector('input[name="date"]');
    return {
      isNative: !!inp && inp.type === 'date',
      value: inp ? inp.value : '',
      hasSegments: !!form.querySelector('[name="dateY"], .date-pick'),
      hasIcon: !!(form.querySelector('.df-ico svg'))
    };
  })()`);
  assert(dateField.isNative, '日期不是原生 date 输入');
  assert(!dateField.hasSegments, '三段下拉的残留还在');
  assert(dateField.hasIcon, '日期框缺少日历图标');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(dateField.value), '日期初值格式异常：' + dateField.value);
  pass('日期用原生日历', 'input[type=date] + 自带图标，值 ' + dateField.value);

  /* ---------- 6. 提交后日期写对，表单自动折叠 ---------- */
  const submitted = await evaluate(`(() => {
    const form = document.querySelector('#txForm');
    form.querySelector('[name="amount"]').value = '12.5';
    form.querySelector('[name="date"]').value = '2026-08-05';
    form.querySelector('[name="note"]').value = '回归测试';
    form.requestSubmit();
    const hit = state.finance.transactions.filter(t => t.date === '2026-08-05');
    return {
      n: hit.length,
      amount: hit.length ? hit[hit.length - 1].amount : 0,
      collapsed: !!state.settings.finQuickCollapsed,
      savedNote: (state.settings.finNotes || []).includes('回归测试')
    };
  })()`);
  assert(submitted.n === 1, '提交后没找到 2026-08-05 这笔，条数：' + submitted.n);
  assert(submitted.amount === 12.5, '金额写错：' + submitted.amount);
  assert(submitted.collapsed, '提交后表单没有自动折叠');
  assert(submitted.savedNote, '备注没有进「常用」');
  pass('日期提交正确', '2026-08-05 记账成功 · 表单自动收起 · 备注入常用');

  /* ---------- 7. 编辑弹窗里也是原生日期 ---------- */
  const editForm = await evaluate(`(() => {
    const tx = state.finance.transactions[0];
    openTxModal(tx.id);
    const inp = document.querySelector('.modal input[name="date"]');
    const seg = document.querySelector('.modal [name="dateY"], .modal .date-pick');
    return { isNative: !!inp && inp.type === 'date', value: inp ? inp.value : '', seg: !!seg };
  })()`);
  assert(editForm.isNative, '编辑弹窗里的日期不是原生输入');
  assert(!editForm.seg, '编辑弹窗里仍有三段下拉');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(editForm.value), '编辑弹窗日期值异常：' + editForm.value);
  pass('编辑弹窗同步', '同样走原生日历，值 ' + editForm.value);

  /* ---------- 8. 五套主题下，折线标注 / 月份格子文字的对比度 ---------- */
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
      const a = [];
      financeMode = 'month'; render();
      openMonthPicker('2026-11', () => {});
      const b = [pick('.mon-cell b'), pick('.mon-cell span'), pick('.mon-cell.on b')].filter(Boolean);
      closePicker();
      rows[t.id] = a.concat(b);
    }
    applyTheme('oat'); financeMode = 'month'; render();
    return rows;
  })()`);

  let bad = 0;
  for (const [id, list] of Object.entries(audit)) {
    const min = Math.min(...list.map(x => x.ratio));
    const ok = min >= 4.5;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(9)} 月份面板文字最低 ${min.toFixed(2)}:1`);
    if (!ok) list.filter(x => x.ratio < 4.5).forEach(x => console.log(`      ${x.sel} = ${x.ratio}:1`));
  }
  assert(bad === 0, `有 ${bad} 套主题的月份面板文字对比度低于 4.5:1`);
  pass('月份面板对比度', '5 套主题全部 ≥ 4.5:1');

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
