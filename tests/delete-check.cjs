/** 删除流程自检：确认「垃圾桶」按钮会弹出应用内确认框，并真正删除数据 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = 9339;
const profile = path.join(root, '.edge-delete-profile');
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0;
const pending = new Map();
let nativeDialogs = 0;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const app = `document.getElementById("app").contentWindow`;
const evalIn = (expr) => evaluate(`${app}.eval(${JSON.stringify(expr)})`);
const assert = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); };

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
    if (m.method === 'Page.javascriptDialogOpening') {
      nativeDialogs++;
      send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
    if (m.id && pending.has(m.id)) {
      const it = pending.get(m.id); pending.delete(m.id);
      m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result);
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8770/' });
  await delay(2600);

  // 进入习惯页
  await evaluate(`${app}.switchView('habits')`);
  await delay(500);
  const before = await evalIn("state.habits.length");
  assert(before > 0, '示例数据里没有习惯，无法测试');

  // 点第一个垃圾桶
  await evaluate(`${app}.document.querySelector('[data-action="del-habit"]').click()`);
  await delay(400);

  const dialog = await evaluate(`(() => {
    const d = ${app}.document;
    const box = d.getElementById('confirm');
    return {
      visible: !box.classList.contains('hidden'),
      title: d.getElementById('confirmTitle').textContent,
      msg: d.getElementById('confirmMsg').textContent,
      ok: d.getElementById('confirmOk').textContent,
      cardInView: (function () {
        const r = d.querySelector('.confirm-card').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= d.documentElement.clientHeight && r.left >= 0 && r.right <= d.documentElement.clientWidth;
      })()
    };
  })()`);
  console.log('dialog:', JSON.stringify(dialog));
  assert(dialog.visible, '点击删除后没有弹出确认框');
  assert(dialog.cardInView, '确认框超出屏幕可视区域');

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(root, 'tests', 'confirm-dialog.png'), Buffer.from(shot.data, 'base64'));

  // 先测「取消」不删数据
  await evaluate(`${app}.document.getElementById('confirmCancel').click()`);
  await delay(300);
  const afterCancel = await evalIn("state.habits.length");
  assert(afterCancel === before, `点取消后数据被改了：${before} → ${afterCancel}`);

  // 再点一次，确认删除
  await evaluate(`${app}.document.querySelector('[data-action="del-habit"]').click()`);
  await delay(300);
  await evaluate(`${app}.document.getElementById('confirmOk').click()`);
  await delay(400);
  const afterOk = await evaluate(`(() => ({
    habits: ${app}.eval('state.habits.length'),
    toast: ${app}.document.getElementById('toast').textContent,
    dialogHidden: ${app}.document.getElementById('confirm').classList.contains('hidden'),
    stored: JSON.parse(${app}.localStorage.getItem('growth-os-v1')).habits.length
  }))()`);
  console.log('after delete:', JSON.stringify(afterOk));
  assert(afterOk.habits === before - 1, `确认后没有删除：${before} → ${afterOk.habits}`);
  assert(afterOk.stored === before - 1, '删除结果没有写入本地存储');
  assert(afterOk.dialogHidden, '确认框没有关闭');
  assert(afterOk.toast.indexOf('已删除') >= 0, '删除后没有提示文案');

  // 其他板块的删除按钮同样要弹自定义确认框（不触发原生 dialog）
  for (const [view, action] of [['goals', 'del-goal'], ['journal', 'del-journal'], ['learning', 'del-item'], ['finance', 'del-tx']]) {
    await evaluate(`${app}.switchView('${view}')`);
    await delay(350);
    const has = await evaluate(`!!${app}.document.querySelector('[data-action="${action}"]')`);
    if (!has) { console.log('skip (no item):', action); continue; }
    await evaluate(`${app}.document.querySelector('[data-action="${action}"]').click()`);
    await delay(300);
    const shown = await evaluate(`!${app}.document.getElementById('confirm').classList.contains('hidden')`);
    assert(shown, action + ' 没有弹出应用内确认框');
    await evaluate(`${app}.document.getElementById('confirmCancel').click()`);
    await delay(200);
    console.log('ok:', action);
  }

  assert(nativeDialogs === 0, `仍触发了 ${nativeDialogs} 次浏览器原生对话框`);
  console.log('PASS: 删除确认框与删除逻辑均正常，未触发原生 confirm');
  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
