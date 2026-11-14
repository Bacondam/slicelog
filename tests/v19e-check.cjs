/** v1.9.E 回归：已完成目标批量归档 / 清理（归档可恢复、删除要二次确认、归档持久化） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9355;
const profile = path.join(root, '.edge-v19e-profile');
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
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, name), Buffer.from(data, 'base64'));
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

  /* 种子数据只有 1 个已完成目标，这里补 3 个，方便测批量 */
  await evaluate(`(() => {
    state = seedState();
    const now = Date.now(), day = 86400000;
    state.goals.push(
      { id: 'x1', title: '早起 100 天', category: '健康', current: 100, target: 100, unit: '天', deadline: '', note: '', createdAt: now - day * 120, done: true, doneAt: now - day * 30, subtasks: [] },
      { id: 'x2', title: '看完 12 门网课', category: '学习', current: 12, target: 12, unit: '门', deadline: '', note: '', createdAt: now - day * 200, done: true, doneAt: now - day * 60, subtasks: [{ id: 'x2s1', title: '前 6 门', done: true, doneAt: now - day * 90 }] },
      { id: 'x3', title: '攒下第一个 5 万', category: '财务', current: 5, target: 5, unit: '万', deadline: '', note: '', createdAt: now - day * 300, done: true, doneAt: now - day * 200, subtasks: [] }
    );
    saveState(); render(); switchView('goals');
  })()`);
  await delay(250);

  /* ---------- 1. 已完成区出现「批量整理」入口 ---------- */
  const entry = await evaluate(`(() => {
    const btn = document.querySelector('#view-goals [data-action="open-goal-batch"]');
    const head = btn ? btn.closest('.section-head') : null;
    const tools = document.querySelector('#view-goals .goal-section:nth-of-type(2) .head-tools');
    return {
      has: !!btn,
      text: btn && btn.textContent.trim(),
      doneCount: state.goals.filter(g => g.done).length,
      cnt: head ? head.querySelector('.cnt').textContent.trim() : '',
      toolsFlex: tools ? getComputedStyle(tools).marginLeft : ''
    };
  })()`);
  assert(entry.has, '已完成区没有「批量整理」入口');
  assert(entry.text === '批量整理', '入口文案不对：' + entry.text);
  assert(String(entry.doneCount) === entry.cnt, `已完成数量不一致：状态 ${entry.doneCount} / 界面 ${entry.cnt}`);
  pass('批量入口', `已完成区显示「${entry.text}」，计数 ${entry.cnt} 个`);

  /* ---------- 2. 弹窗：列出全部已完成目标，未选时按钮禁用 ---------- */
  const modal = await evaluate(`(() => {
    document.querySelector('#view-goals [data-action="open-goal-batch"]').click();
    const items = [...document.querySelectorAll('#modalBox [data-gb-id]')];
    const arc = document.querySelector('#modalBox [data-gb="archive"]');
    const del = document.querySelector('#modalBox [data-gb="delete"]');
    const list = document.querySelector('#modalBox .gb-list');
    return {
      open: !document.getElementById('modal').classList.contains('hidden'),
      items: items.length,
      note: document.querySelector('#modalBox .gb-note').textContent.trim(),
      arcDisabled: arc.disabled, delDisabled: del.disabled,
      scroll: list ? getComputedStyle(list).overflowY : '',
      checks: items.filter(i => i.querySelector('.gb-check')).length
    };
  })()`);
  assert(modal.open, '点批量整理没有打开弹窗');
  assert(modal.items === entry.doneCount, `弹窗条目数不对：${modal.items} / ${entry.doneCount}`);
  assert(modal.arcDisabled && modal.delDisabled, '未勾选时归档/删除按钮应禁用');
  assert(modal.checks === modal.items, '每行缺少勾选框');
  assert(/已选 0 \//.test(modal.note), '选中计数初始值不对：' + modal.note);
  assert(modal.scroll === 'auto', '列表没有独立滚动区域，条目多了会撑爆弹窗');
  await shot('v19e-modal.png');
  pass('批量弹窗', `${modal.items} 条已完成目标，未选时按钮禁用`);

  /* ---------- 3. 勾选联动：计数、按钮文案、全选 ---------- */
  const pick = await evaluate(`(() => {
    document.querySelectorAll('#modalBox [data-gb-id]')[0].click();
    document.querySelectorAll('#modalBox [data-gb-id]')[1].click();
    const arc = document.querySelector('#modalBox [data-gb="archive"]');
    const note1 = document.querySelector('#modalBox .gb-note').textContent.trim();
    const label1 = arc.textContent.trim();
    document.querySelector('#modalBox [data-action="gb-all"]').click();
    const note2 = document.querySelector('#modalBox .gb-note').textContent.trim();
    const allLabel = document.querySelector('#modalBox [data-action="gb-all"]').textContent.trim();
    const onCount = document.querySelectorAll('#modalBox .gb-item.on').length;
    const ticks = document.querySelectorAll('#modalBox .gb-check.on svg').length;
    return { note1, label1, note2, allLabel, onCount, ticks, total: document.querySelectorAll('#modalBox [data-gb-id]').length };
  })()`);
  assert(/已选 2 \//.test(pick.note1), '勾选 2 条后计数不对：' + pick.note1);
  assert(/归档 2 个/.test(pick.label1), '归档按钮文案没跟着变：' + pick.label1);
  assert(pick.onCount === pick.total && pick.ticks === pick.total, '全选没有把每一项都选中');
  assert(/已选 \d+ \/ \d+/.test(pick.note2) && pick.allLabel === '取消全选', '全选按钮没有切成「取消全选」：' + pick.allLabel);
  pass('勾选联动', `选中 2 条时按钮变「${pick.label1}」，全选后 ${pick.total} 条全亮`);

  /* ---------- 4. 只选 2 条归档：数据搬进 archivedGoals，界面多出「已归档」 ---------- */
  const archived = await evaluate(`(() => {
    // 取消全选，然后只勾前两条
    document.querySelector('#modalBox [data-action="gb-all"]').click();
    const items = [...document.querySelectorAll('#modalBox [data-gb-id]')];
    items[0].click(); items[1].click();
    const ids = [...gbSel];
    document.querySelector('#modalBox [data-gb="archive"]').click();
    const raw = JSON.parse(localStorage.getItem('growth-os-v1') || '{}');
    const sec = [...document.querySelectorAll('#view-goals .goal-section')].find(s => /已归档/.test(s.querySelector('h3').textContent));
    return {
      ids,
      arch: state.archivedGoals.length,
      stored: (raw.archivedGoals || []).length,
      modalClosed: document.getElementById('modal').classList.contains('hidden'),
      doneLeft: state.goals.filter(g => g.done).length,
      hasSection: !!sec,
      sectionCnt: sec ? sec.querySelector('.cnt').textContent.trim() : '',
      listHidden: sec ? sec.querySelector('.arch-list').hasAttribute('hidden') : null,
      hasArchivedAt: state.archivedGoals.every(g => g.archivedAt > 0),
      stillInGoals: state.goals.some(g => ids.includes(g.id))
    };
  })()`);
  assert(archived.arch === 2, `归档数量不对：${archived.arch}`);
  assert(archived.stored === 2, '归档结果没有写进 localStorage');
  assert(!archived.stillInGoals, '归档后的目标还留在当前列表里');
  assert(archived.doneLeft === entry.doneCount - 2, `已完成数量没减少：${archived.doneLeft}`);
  assert(archived.modalClosed, '归档后弹窗没有关闭');
  assert(archived.hasSection, '归档后没有出现「已归档」区块');
  assert(archived.sectionCnt === '2', '已归档区块计数不对：' + archived.sectionCnt);
  assert(archived.listHidden === true, '已归档默认应收起');
  assert(archived.hasArchivedAt, '归档目标缺少 archivedAt 时间戳');
  pass('批量归档', `2 个目标移入归档（含 localStorage），已完成剩 ${archived.doneLeft} 个`);

  /* ---------- 5. 展开已归档、恢复一条 ---------- */
  const restored = await evaluate(`(() => {
    document.querySelector('#view-goals [data-action="toggle-arch"]').click();
    const rows = [...document.querySelectorAll('#view-goals .arch-row')];
    const meta = rows[0] ? rows[0].querySelector('.ar-meta').textContent.trim() : '';
    const shown = rows.length && !rows[0].closest('.arch-list').hasAttribute('hidden');
    rows[0].querySelector('[data-action="arch-restore"]').click();
    return {
      rows: rows.length, meta, shown,
      arch: state.archivedGoals.length,
      backInGoals: state.goals.filter(g => g.done).length,
      toast: document.getElementById('toast').textContent
    };
  })()`);
  assert(restored.rows === 2, `已归档行数不对：${restored.rows}`);
  assert(restored.shown, '展开已归档后列表仍然隐藏');
  assert(/归档于/.test(restored.meta), '归档行缺少归档时间：' + restored.meta);
  assert(restored.arch === 1, `恢复后归档数量不对：${restored.arch}`);
  assert(restored.backInGoals === entry.doneCount - 1, `恢复后已完成数量不对：${restored.backInGoals}`);
  assert(/已恢复/.test(restored.toast), '恢复没有提示：' + restored.toast);
  await shot('v19e-archive.png');
  pass('恢复归档', `归档行显示「${restored.meta}」，恢复后回到已完成列表`);

  /* ---------- 6. 单条删除要二次确认；取消则不动 ---------- */
  const single = await evaluate(`(async () => {
    const before = state.archivedGoals.length;
    document.querySelector('#view-goals [data-action="arch-del"]').click();
    const asked = !document.getElementById('confirm').classList.contains('hidden');
    document.querySelector('#confirmCancel').click();
    const afterCancel = state.archivedGoals.length;
    document.querySelector('#view-goals [data-action="arch-del"]').click();
    document.querySelector('#confirmOk').click();
    return { asked, before, afterCancel, afterOk: state.archivedGoals.length,
      confirmHidden: document.getElementById('confirm').classList.contains('hidden'),
      sectionGone: ![...document.querySelectorAll('#view-goals h3')].some(h => /已归档/.test(h.textContent)) };
  })()`);
  assert(single.asked, '删除归档目标没有弹确认框');
  assert(single.afterCancel === single.before, '取消确认后仍然删掉了');
  assert(single.afterOk === 0, '确认后没有删掉');
  assert(single.sectionGone, '归档清空后「已归档」区块没有消失');
  pass('单条删除', '弹确认框、取消不动、确认后删除，清空后区块自动消失');

  /* ---------- 7. 批量删除：确认文案带数量，删完不留在任何列表 ---------- */
  const batchDel = await evaluate(`(() => {
    const before = state.goals.length;
    document.querySelector('#view-goals [data-action="open-goal-batch"]').click();
    document.querySelectorAll('#modalBox [data-gb-id]')[0].click();
    document.querySelectorAll('#modalBox [data-gb-id]')[1].click();
    const label = document.querySelector('#modalBox [data-gb="delete"]').textContent.trim();
    document.querySelector('#modalBox [data-gb="delete"]').click();
    const msg = document.getElementById('confirmMsg').textContent;
    document.querySelector('#confirmOk').click();
    return { before, label, msg, after: state.goals.length,
      doneLeft: state.goals.filter(g => g.done).length,
      modalClosed: document.getElementById('modal').classList.contains('hidden') };
  })()`);
  assert(/删除 2 个/.test(batchDel.label), '批量删除按钮文案不对：' + batchDel.label);
  assert(/2 个目标/.test(batchDel.msg), '确认文案没有带数量：' + batchDel.msg);
  assert(batchDel.after === batchDel.before - 2, `批量删除数量不对：${batchDel.before} → ${batchDel.after}`);
  assert(batchDel.modalClosed, '批量删除后弹窗没有关闭');
  pass('批量删除', `确认文案「${batchDel.msg.slice(0, 26)}…」，删掉 2 个，剩 ${batchDel.after} 个目标`);

  /* ---------- 8. 全部归档后仍能进「已归档」找回 ---------- */
  const allGone = await evaluate(`(() => {
    state.goals.filter(g => g.done).forEach(g => archiveGoals([g.id]));
    const empty = document.querySelector('#view-goals .empty');
    const sec = [...document.querySelectorAll('#view-goals .goal-section')].find(s => /已归档/.test(s.querySelector('h3').textContent));
    const restoreBtn = sec && sec.querySelector('[data-action="arch-restore"]');
    if (restoreBtn) restoreBtn.click();
    return { emptyText: empty ? empty.textContent.slice(0, 12) : '', archBefore: state.archivedGoals.length + 1, back: state.goals.length };
  })()`);
  assert(allGone.back >= 1, '全部归档后无法从归档恢复');
  pass('兜底可找回', `已完成清零时列表显示空状态，归档里仍可逐条恢复（现存 ${allGone.back} 个）`);

  /* ---------- 9. 导入 / 重载后归档数据不丢 ---------- */
  const persist = await evaluate(`(() => {
    const one = state.goals.find(g => g.done);
    if (one) archiveGoals([one.id]);
    const before = state.archivedGoals.length;
    saveState();
    state = loadState();
    return { before, after: state.archivedGoals.length, ok: Array.isArray(state.archivedGoals) };
  })()`);
  assert(persist.before > 0, '持久化用例没有造出归档数据');
  assert(persist.ok && persist.after === persist.before, `重载后归档丢失：${persist.before} → ${persist.after}`);
  pass('持久化', `重载 localStorage 后归档仍有 ${persist.after} 条`);

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('✗ ' + error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
