/**
 * v2.15 回归：提醒功能已整体移除 + 设置面板分组排版
 * 1) 页面里不应再有任何提醒入口 / 弹层 / 桥接调用
 * 2) 手机端设置面板：三组（备份 / 外观 / 危险区）、按钮两列对齐、不溢出屏幕
 * 3) 桌面侧栏：分组纵向排列，按钮等宽、图标对齐
 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9365;
const profile = path.join(root, '.edge-v215-profile');
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
    source: `window.__calls = [];
      window.AndroidBridge = {
        getSafeInsets(){return '32,0,24,0';}, getScreenInfo(){return 'test';},
        exportBackup(){window.__calls.push('export');}, setSystemBars(){}, openAppSettings(){},
        shareBackup(){window.__calls.push('share');}, autoBackup(){}, readAutoBackup(){return '';},
        setGoalReminders(){window.__calls.push('alarms');},
        notifyGoal(){window.__calls.push('notify');}
      };`
  });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await delay(1200);

  /* ---------- 1. 提醒功能彻底移除 ---------- */
  const gone = await evaluate(`(() => ({
    remindBox: !!document.getElementById('remind'),
    remindBtn: !!document.getElementById('remindBtn'),
    hasHelp: typeof openReminderHelp !== 'undefined',
    hasSync: typeof syncGoalAlarms !== 'undefined',
    hasCheck: typeof checkGoalReminders !== 'undefined',
    bell: !!document.querySelector('.sidebar-foot [data-ico="bell"]'),
    actions: [...document.querySelectorAll('[data-action]')].map(e => e.dataset.action).filter(a => /remind|notify|guard|battery|autostart/.test(a))
  }))()`);
  assert(!gone.remindBox, '页面里还留着提醒弹层 #remind');
  assert(!gone.remindBtn, '侧栏还留着「提醒自检」按钮');
  assert(!gone.hasHelp && !gone.hasSync && !gone.hasCheck, '提醒相关函数没有清干净');
  assert(!gone.bell, '侧栏还在渲染铃铛图标');
  assert(gone.actions.length === 0, '还留着提醒相关 action：' + gone.actions.join(','));
  pass('提醒已移除', '弹层 / 按钮 / 函数 / 桥接调用全部清空');

  /* ---------- 2. 目标表单不再提「提醒」 ---------- */
  const form = await evaluate(`(() => {
    state = seedState(); render();
    openGoalModal();
    const txt = document.querySelector('#modalBox form').textContent;
    return { hasRemind: /提醒/.test(txt), tip: txt.match(/具体时间[^。]*。/) ? txt.match(/具体时间[^。]*。/)[0] : '' };
  })()`);
  assert(!form.hasRemind, '目标表单里还有「提醒」字样：' + form.tip);
  pass('表单文案', form.tip);

  const timeChip = await evaluate(`(() => {
    closeModal();
    openGoalModal();
    document.querySelector('#modalBox .field-btn').click();
    return [...document.querySelectorAll('.chip-btn')].map(b => b.textContent.trim());
  })()`);
  assert(timeChip.includes('不设时间'), '时间选择器里应改成「不设时间」：' + timeChip.join('/'));
  pass('时间选择', '不设时间 / 此刻 / 自定义');

  /* ---------- 3. 手机端设置面板布局 ---------- */
  await evaluate(`(() => { closeModal(); closePicker(); switchView('dashboard'); document.getElementById('mobileSettings').click(); })()`);
  await delay(320);
  const panel = await evaluate(`(() => {
    const f = document.querySelector('.sidebar-foot');
    const cs = getComputedStyle(f);
    const shown = cs.display !== 'none';
    const groups = [...f.querySelectorAll('.sf-group')].map(g => ({
      label: g.querySelector('.sf-label') ? g.querySelector('.sf-label').textContent.trim() : '',
      btns: [...g.querySelectorAll('button')].length
    }));
    const buttons = [...f.querySelectorAll('button')].map(b => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent.trim(), w: Math.round(r.w || r.width), h: Math.round(r.height), left: Math.round(r.left), ico: !!b.querySelector('.bi') };
    });
    const rect = f.getBoundingClientRect();
    const firstGroupBtn = f.querySelector('.sf-group button').getBoundingClientRect();
    const wideRect = f.querySelector('.sf-wide').getBoundingClientRect();
    const ver = f.querySelector('.sf-ver');
    const vr = ver ? ver.getBoundingClientRect() : null;
    return {
      shown, groups, buttons, icoCount: buttons.filter(b => b.ico).length,
      ver: vr ? { text: ver.textContent.replace(/\s+/g, ' ').trim(), bottom: Math.round(vr.bottom), w: Math.round(vr.width) } : null,
      rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) },
      wideW: Math.round(wideRect.width),
      innerW: Math.round(f.clientWidth - 28),
      vh: innerHeight, vw: innerWidth,
      overflowY: f.scrollHeight > f.clientHeight + 2,
      docOverflowX: document.documentElement.scrollWidth > innerWidth + 1
    };
  })()`);
  assert(panel.shown, '设置面板没有展开');
  assert(panel.groups.length === 3, '设置应分三组，实际 ' + panel.groups.length);
  assert(panel.groups[0].label === '备份', '第一组应是备份，实际 ' + panel.groups[0].label);
  assert(panel.groups[1].label === '外观', '第二组应是外观，实际 ' + panel.groups[1].label);
  assert(panel.groups[0].btns === 4, '备份组应有 4 个按钮');
  assert(panel.buttons.length === 6, '面板按钮总数应为 6，实际 ' + panel.buttons.length);
  assert(panel.buttons[0].t === '分享备份到微信', '第一个按钮应是分享备份：' + panel.buttons[0].t);
  assert(panel.buttons[5].t === '清空数据', '最后一个按钮应是清空数据：' + panel.buttons[5].t);
  assert(panel.icoCount === 6, '每个按钮都应有图标，实际 ' + panel.icoCount);
  assert(panel.rect.bottom <= panel.vh + 1, `面板溢出屏幕：bottom=${panel.rect.bottom} vh=${panel.vh}`);
  assert(panel.rect.right <= panel.vw + 1 && panel.rect.left >= 0, '面板横向越界');
  assert(!panel.docOverflowX, '页面出现横向滚动');
  assert(Math.abs(panel.wideW - panel.innerW) <= 3, `跨列按钮没铺满：${panel.wideW} vs ${panel.innerW}`);
  assert(panel.buttons.every(b => b.h >= 40), '按钮太矮，点不准：' + JSON.stringify(panel.buttons.map(b => b.h)));
  assert(panel.ver, '设置面板里没有版本号');
  assert(/V1\.0/.test(panel.ver.text), '版本号应为 V1.0，实际「' + panel.ver.text + '」');
  assert(panel.ver.bottom <= panel.rect.bottom + 1, `版本号被面板底部裁掉：${panel.ver.bottom} > ${panel.rect.bottom}`);
  pass('设置分组', panel.groups.map(g => `${g.label}(${g.btns})`).join(' / '), );
  pass('版本号', panel.ver.text);
  pass('面板不溢出', `高 ${panel.rect.bottom - panel.rect.top}px / 屏 ${panel.vh}px，跨列按钮 ${panel.wideW}px`);

  await send('Page.captureScreenshot', { format: 'png' }).then(r =>
    require('fs').writeFileSync(path.join(__dirname, 'v215-settings.png'), Buffer.from(r.data, 'base64')));

  /* ---------- 3b. 深色主题下面板同样成立 ---------- */
  const dark = await evaluate(`(() => {
    const f = document.querySelector('.sidebar-foot');
    if (f.classList.contains('mobile-open')) document.getElementById('mobileSettings').click();
    state.settings.theme = 'pine'; applyTheme('pine'); render();
    document.getElementById('mobileSettings').click();
    const cs = getComputedStyle(f);
    const lab = f.querySelector('.sf-label');
    return { bg: cs.backgroundColor, color: getComputedStyle(f.querySelector('button')).color,
             label: lab ? getComputedStyle(lab).color : '', opened: f.classList.contains('mobile-open') };
  })()`);
  assert(dark.opened, '深色主题下设置面板没打开');
  pass('深色主题', '面板背景 ' + dark.bg);
  await delay(400);
  await send('Page.captureScreenshot', { format: 'png' }).then(r =>
    require('fs').writeFileSync(path.join(__dirname, 'v215-settings-dark.png'), Buffer.from(r.data, 'base64')));
  await evaluate(`(() => {
    const f = document.querySelector('.sidebar-foot');
    if (f.classList.contains('mobile-open')) document.getElementById('mobileSettings').click();
    state.settings.theme = 'oat'; applyTheme('oat'); render();
  })()`);
  await delay(200);

  /* ---------- 4. 点按钮会收起面板、点外部也会收起 ---------- */
  const close = await evaluate(`(() => {
    const f = document.querySelector('.sidebar-foot');
    if (f.classList.contains('mobile-open')) document.getElementById('mobileSettings').click();
    document.getElementById('mobileSettings').click();
    const open1 = f.classList.contains('mobile-open');
    document.getElementById('mobileSettings').click();
    const close1 = f.classList.contains('mobile-open');
    document.getElementById('mobileSettings').click();
    document.body.click();
    const close2 = f.classList.contains('mobile-open');
    return { open1, close1, close2 };
  })()`);
  assert(close.open1 && !close.close1 && !close.close2, '设置面板开合异常：' + JSON.stringify(close));
  pass('开合', '再点一次收起，点空白处也收起');

  /* ---------- 5. 桌面侧栏：单列分组、图标对齐 ---------- */
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, screenWidth: 1280, screenHeight: 860, deviceScaleFactor: 1, mobile: false });
  await delay(420);
  const desk = await evaluate(`(() => {
    const f = document.querySelector('.sidebar-foot');
    const btns = [...f.querySelectorAll('button')].map(b => {
      const r = b.getBoundingClientRect();
      const ico = b.querySelector('.bi');
      return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), icoL: ico ? Math.round(ico.getBoundingClientRect().left) : -1 };
    });
    const side = document.querySelector('.sidebar').getBoundingClientRect();
    return {
      btns, sideBottom: Math.round(side.bottom), vh: innerHeight,
      sameWidth: new Set(btns.map(b => b.w)).size === 1,
      icoAligned: new Set(btns.map(b => b.icoL)).size === 1,
      footVisible: getComputedStyle(f).display !== 'none',
      resetColor: getComputedStyle(f.querySelector('#resetBtn')).color
    };
  })()`);
  assert(desk.footVisible, '桌面侧栏里设置区不见了');
  assert(desk.btns.length === 6, '桌面侧栏按钮数应为 6，实际 ' + desk.btns.length);
  assert(desk.sameWidth, '桌面按钮宽度不一致');
  assert(desk.icoAligned, '桌面按钮图标没有左对齐');
  pass('桌面侧栏', `6 个按钮 ${desk.btns[0].w}px 等宽，图标对齐`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, screenWidth: 1280, screenHeight: 860, deviceScaleFactor: 1, mobile: false });
  await send('Page.captureScreenshot', { format: 'png' }).then(r =>
    require('fs').writeFileSync(path.join(__dirname, 'v215-desktop.png'), Buffer.from(r.data, 'base64')));

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
