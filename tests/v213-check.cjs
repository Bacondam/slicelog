/**
 * 【历史留档】v2.13 回归：提醒改成到点触发 / 后台守护状态 / 30 秒真机验证通道。
 * v2.15 起「目标到期提醒」整体移除（站内弹层 / 系统通知 / 后台守护 / 提醒自检），
 * 本脚本断言的函数与元素已不存在，不再纳入回归；当前回归请看 v215-check.cjs。
 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9363;
const profile = path.join(root, '.edge-v213-profile');
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
    source: `window.AndroidBridge = {
      getSafeInsets(){return '32,0,24,0';}, getScreenInfo(){return 'test';},
      exportBackup(){}, setSystemBars(){}, openAppSettings(){},
      setGoalReminders(j){ window.__alarms = j; },
      notifyStatus(){ return '{"notify":true,"guard":true,"battery":false,"api":34}'; },
      scheduleTestReminder(s){ window.__testSec = s; return true; },
      restartGuard(){ window.__guardRestart = (window.__guardRestart || 0) + 1; },
      openAutoStart(){ window.__autoStart = true; },
      testNotification(){ window.__immediate = true; },
      notifyGoal(t, m){ window.__notifyGoal = t; }
    };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await delay(2600);

  /* ---------- 1. 同步给系统的时刻 = 截止时刻，不是提前 1 小时 ---------- */
  const synced = await evaluate(`(() => {
    state = seedState();
    const t = new Date(Date.now() + 3 * 60000);
    const tk = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const hm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    state.goals = [{ id: 'g-1', title: '三分钟后到期', deadline: tk(t), dueTime: hm(t), done: false, createdAt: Date.now(), remindedFor: null }];
    saveState();
    window.__alarms = '';
    syncGoalAlarms(true);
    const list = JSON.parse(window.__alarms || '[]');
    const due = goalDueMs(state.goals[0]);
    return { count: list.length, at: list[0] ? list[0].at : 0, due, now: Date.now(), title: list[0] ? list[0].title : '' };
  })()`);
  assert(synced.count === 1, '1 小时内到期的目标应该被排上，实际 ' + synced.count + ' 条');
  assert(synced.at === synced.due, `同步的时刻应为截止时刻 ${synced.due}，实际 ${synced.at}`);
  assert(synced.at > synced.now, '排程时刻应在将来');
  pass('到点提醒', `3 分钟后到期的目标已排程（差 ${Math.round((synced.at - synced.now) / 1000)}s）`);

  /* ---------- 2. 已到截止时刻而未提醒 → 打开页面补弹 ---------- */
  const late = await evaluate(`(() => {
    const t = new Date(Date.now() - 60000);
    const tk = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const hm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    state.goals = [{ id: 'g-2', title: '刚刚到点', deadline: tk(t), dueTime: hm(t), done: false, createdAt: Date.now(), remindedFor: null }];
    saveState(); render();
    const hit = checkGoalReminders();
    const box = document.querySelector('#remind');
    return { hit, shown: box.classList.contains('show'), msg: document.querySelector('#remindMsg').textContent, notified: window.__notifyGoal || '' };
  })()`);
  assert(late.hit === true, '到点目标没有被识别');
  assert(late.shown, '到点后没有弹出站内提醒');
  assert(/已经到截止时间/.test(late.msg), '提醒文案没改成到点口径：' + late.msg);
  pass('到点补弹', late.msg.slice(0, 22) + '…');

  /* ---------- 3. 过期超过 12 小时不再补弹 ---------- */
  const stale = await evaluate(`(() => {
    const t = new Date(Date.now() - 13 * 3600000);
    const tk = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const hm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    state.goals = [{ id: 'g-3', title: '昨天就过期', deadline: tk(t), dueTime: hm(t), done: false, createdAt: Date.now(), remindedFor: null }];
    saveState(); render();
    return checkGoalReminders();
  })()`);
  assert(stale === false, '过期 13 小时的目标不该再弹提醒');
  pass('超期不骚扰', '过期 13 小时已跳过');

  /* ---------- 4. 已提醒过的不重复弹 ---------- */
  const once = await evaluate(`(() => {
    const g = state.goals[0];
    g.remindedFor = goalRemindKey(g);
    saveState();
    closeReminder();
    return checkGoalReminders();
  })()`);
  assert(once === false, '同一个截止时间不该提醒第二次');
  pass('只提醒一次', 'remindedFor 生效');

  /* ---------- 5. 「30 秒后提醒我」走真实链路 ---------- */
  const later = await evaluate(`(() => {
    window.__testSec = null;
    openReminderHelp();
    document.querySelector('[data-action="notify-test-later"]').click();
    return { sec: window.__testSec, closed: document.querySelector('#modal').classList.contains('hidden') };
  })()`);
  assert(later.sec === 30, '测试通道应排 30 秒后的提醒，实际：' + later.sec);
  assert(later.closed, '点完应该收起弹窗，方便用户马上去划掉应用');
  pass('30 秒测试通道', '已排 30 秒，弹窗自动收起');

  /* ---------- 6. 自检面板的状态与按钮 ---------- */
  const panel = await evaluate(`(() => {
    window.__guardRestart = 0; window.__autoStart = false;
    openReminderHelp();
    const box = document.querySelector('#modalBox');
    const rows = [...box.querySelectorAll('.rm-row')].map(r => ({
      label: r.querySelector('strong').textContent,
      on: !!r.querySelector('.rm-dot.on')
    }));
    box.querySelector('[data-action="guard-fix"]').click();
    const guard = window.__guardRestart;
    openReminderHelp();
    document.querySelector('#modalBox [data-action="autostart-fix"]').click();
    return { rows, guard, autoStart: !!window.__autoStart };
  })()`);
  assert(panel.rows.length === 3, '自检面板应有三行，实际 ' + panel.rows.length);
  assert(panel.rows[0].on && panel.rows[1].on, '通知与后台守护应显示已开启：' + JSON.stringify(panel.rows));
  assert(!panel.rows[2].on, '白名单在测试环境里是关闭的，应显示为未开启');
  assert(panel.rows[1].label === '后台守护', '第二行应是后台守护，实际 ' + panel.rows[1].label);
  assert(panel.guard === 1, '「重启守护」没有调到原生方法');
  assert(panel.autoStart, '「自启动 / 后台」没有调到原生跳转');
  pass('自检面板', panel.rows.map(r => r.label + (r.on ? '✓' : '!')).join(' '));

  /* ---------- 7. 已提醒状态不会跨截止时间误用 ---------- */
  const rearm = await evaluate(`(() => {
    const g = state.goals[0];
    g.remindedFor = '2020-01-01 09:00';
    const fresh = goalRemindKey(g);
    return fresh !== g.remindedFor;
  })()`);
  assert(rearm, '改了截止时间后应重新提醒');
  pass('改期重提醒', 'remindedFor 与新的截止键不一致');

  console.log(`\n全部通过：${results.length} 项`);
  try { ws.close(); } catch (_) {}
  browser.kill();
  process.exit(0);
}

main().catch(e => {
  console.error('\n✗ ' + e.message);
  try { browser.kill(); } catch (_) {}
  process.exit(1);
});
