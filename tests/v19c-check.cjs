/** v1.9.C 回归：折叠箭头 / 记账线性图标 / 学习记录按类型分化 / 五套主题与交互令牌 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9353;
const profile = path.join(root, '.edge-v19c-profile');
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
  await evaluate(`state = seedState(); saveState(); render();`);
  await delay(300);

  /* ---------- 1. 折叠按钮：一律是线性箭头，不再出现 ⊕/⊖ 文字 ---------- */
  await evaluate(`switchView('journal')`);
  const fold = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.collapse-btn.pm')];
    const texts = btns.map(b => b.textContent.trim()).filter(Boolean);
    const chevs = btns.map(b => !!b.querySelector('svg.pm-chev'));
    const openBtn = document.querySelector('.collapse-btn.pm.minus');
    const rot = openBtn ? getComputedStyle(openBtn.querySelector('.pm-chev')).transform : '';
    const closed = document.querySelector('.collapse-btn.pm:not(.minus)');
    const rot2 = closed ? getComputedStyle(closed.querySelector('.pm-chev')).transform : '';
    return { count: btns.length, texts, chevs, rot, rot2 };
  })()`);
  assert(fold.count >= 3, `折叠按钮数量异常：${fold.count}`);
  assert(fold.texts.length === 0, '折叠按钮里仍残留 ⊕/⊖ 文字：' + JSON.stringify(fold.texts));
  assert(fold.chevs.every(Boolean), '折叠按钮缺少箭头 svg');
  assert(/matrix\(0,\s*1,\s*-1,\s*0/.test(fold.rot), '展开态箭头没有旋转 90°：' + fold.rot);
  assert(!/matrix\(0,\s*1,\s*-1,\s*0/.test(fold.rot2), '收起态箭头不应旋转：' + fold.rot2);
  pass('折叠图标统一', `${fold.count} 个按钮全部为箭头 svg，收起朝右 / 展开朝下`);

  /* ---------- 2. 记账：分类图标与行内按钮全部是线性 svg ---------- */
  await evaluate(`switchView('finance')`);
  const fin = await evaluate(`(() => {
    const icons = [...document.querySelectorAll('#view-finance .tx-icon')];
    const acts = [...document.querySelectorAll('#view-finance .tx-row .icon-btn')];
    const options = [...document.querySelectorAll('#view-finance select[name="category"] option')].map(o => o.textContent.trim());
    const catNames = [...document.querySelectorAll('#view-finance .cat-name')];
    return {
      rows: icons.length,
      allSvg: icons.every(el => el.querySelector('svg')),
      emoji: /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(document.querySelector('#view-finance').textContent),
      actSvg: acts.length > 0 && acts.every(b => b.querySelector('svg')),
      options,
      catSvg: catNames.length > 0 && catNames.every(el => el.querySelector('svg'))
    };
  })()`);
  assert(fin.rows > 0, '账单明细没有渲染');
  assert(fin.allSvg, '账单行分类图标不是 svg');
  assert(fin.actSvg, '账单行编辑/删除按钮不是 svg');
  assert(fin.catSvg, '支出分类列表图标不是 svg');
  assert(!fin.emoji, '记账页仍残留 emoji 字符');
  assert(fin.options.every(t => !/\s/.test(t)), '分类下拉里混入了图标：' + JSON.stringify(fin.options));
  pass('记账图标统一', `${fin.rows} 行分类 + 行内按钮 + 分类列表全部线性 svg，下拉仅文字`);

  /* ---------- 3. 记录学习：三种类型字段不一样 ---------- */
  await evaluate(`switchView('learning')`);
  const book = await evaluate(`(() => { openSessionModal('l1');
    const p = document.querySelector('#sessProg');
    return { has: !!p, max: p && p.max, hint: (document.querySelector('.sp-head span') || {}).textContent,
      stars: document.querySelectorAll('[data-sess-level] button').length }; })()`);
  assert(book.has && book.max === '400', '阅读记录缺少页码进度输入');
  assert(/读到第几页/.test(book.hint || ''), '阅读记录的字段文案不对：' + book.hint);
  assert(book.stars === 0, '阅读记录不应出现熟练度星星');

  const course = await evaluate(`(() => { openSessionModal('l3');
    const p = document.querySelector('#sessProg');
    return { has: !!p, max: p && p.max, hint: (document.querySelector('.sp-head span') || {}).textContent }; })()`);
  assert(course.has && course.max === '24', '课程记录缺少讲数进度输入');
  assert(/完成到第几节/.test(course.hint || ''), '课程记录文案不对：' + course.hint);

  const skill = await evaluate(`(() => { openSessionModal('l2');
    return { prog: !!document.querySelector('#sessProg'), stars: document.querySelectorAll('[data-sess-level] button').length,
      level: document.querySelector('[name="level"]').value }; })()`);
  assert(!skill.prog, '技能记录不应出现页码输入');
  assert(skill.stars === 5, '技能记录缺少 5 星熟练度');
  pass('学习记录分类型', '阅读→页码 / 课程→讲数 / 技能→时长+熟练度，三种字段不同');

  /* ---------- 4. 提交后进度与熟练度真的写回 ---------- */
  const submit = await evaluate(`(() => {
    openSessionModal('l1');
    const form = document.querySelector('form[data-form="session"]');
    form.elements.minutes.value = '40';
    document.querySelector('#sessProg').value = '260';
    form.requestSubmit();
    const it = state.learning.items.find(x => x.id === 'l1');
    const last = state.learning.sessions[state.learning.sessions.length - 1];
    openSessionModal('l2');
    const f2 = document.querySelector('form[data-form="session"]');
    document.querySelector('[data-action="sess-level"][data-level="4"]').click();
    f2.requestSubmit();
    const sk = state.learning.items.find(x => x.id === 'l2');
    return { cur: it.current, sp: last.progress, min: last.minutes, lv: sk.level, closed: document.getElementById('modal').classList.contains('hidden') };
  })()`);
  assert(submit.cur === 260, `阅读进度没有写回：${submit.cur}`);
  assert(submit.sp === 260 && submit.min === 40, '记录没有保存页码/时长');
  assert(submit.lv === 4, `技能熟练度没有写回：${submit.lv}`);
  assert(submit.closed, '提交后弹窗没有关闭');
  pass('进度自动推进', '读到 260/400 写回项目；熟练度点星后写入 4 级');

  /* ---------- 5. 交互令牌：五套主题都有，松烟夜的控件描边比结构线更亮 ---------- */
  const tokens = await evaluate(`(() => {
    const lum = hex => {
      const h = hex.replace('#', '');
      const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
    };
    const out = [];
    for (const t of THEMES) {
      applyTheme(t.id);
      const cs = getComputedStyle(document.documentElement);
      const line = cs.getPropertyValue('--line').trim();
      const ctl = cs.getPropertyValue('--line-ctl').trim();
      out.push({ id: t.id, line, ctl, bg: cs.getPropertyValue('--bg').trim(), card: cs.getPropertyValue('--card').trim(), dark: !!t.dark,
        ratio: (lum(ctl) + 0.05) / (lum(cs.getPropertyValue('--card').trim()) + 0.05) });
    }
    applyTheme('oat');
    return out;
  })()`);
  assert(tokens.length === 5, `主题数量不对：${tokens.length}`);
  assert(tokens.every(t => t.line && t.ctl), '有主题缺少 --line-ctl 令牌');
  const pine = tokens.find(t => t.id === 'pine');
  assert(pine.ratio >= 1.8, `松烟夜的控件描边太暗，与卡片对比只有 ${pine.ratio.toFixed(2)}:1`);
  pass('交互令牌', `松烟夜 --line-ctl 与卡片对比 ${pine.ratio.toFixed(2)}:1，五套主题均定义了控件令牌`);

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('✗ ' + error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
