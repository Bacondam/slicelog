/** v1.9.A 回归：每日一句 / 目标表单精简 / 分类胶囊 / 自绘截止选择器 / 小目标折叠 / 按钮统一 */
const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9343;
const profile = path.join(root, '.edge-v19-profile');
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
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + '?nosplash=1' });
  await loaded;
  await evaluate('document.fonts.ready');
  await evaluate(`state = seedState(); saveState(); render();`);
  await delay(300);

  /* ---------- 1. 每日一句：库完整 + 按天轮换 + 真正显示 ---------- */
  const quoteInfo = await evaluate(`(() => {
    const seen = new Set();
    const base = new Date(2026, 0, 1);
    for (let i = 0; i < 365; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      seen.add(quoteOfDay(d));
    }
    return {
      total: QUOTES.length,
      uniq: new Set(QUOTES).size,
      yearUnique: seen.size,
      maxLen: Math.max(...QUOTES.map(s => s.length)),
      today: quoteOfDay(),
      sub: document.getElementById('pageSub').textContent,
      hasClass: document.getElementById('pageSub').classList.contains('quote-line'),
      hidden: document.getElementById('pageSub').hidden
    };
  })()`);
  assert(quoteInfo.total === 365, `文案不是 365 条：${quoteInfo.total}`);
  assert(quoteInfo.uniq === 365, `文案有重复：${quoteInfo.uniq}`);
  assert(quoteInfo.yearUnique === 365, `一年内有重复，只取到 ${quoteInfo.yearUnique} 条`);
  assert(quoteInfo.maxLen <= 14, `有文案超长：${quoteInfo.maxLen} 字`);
  assert(quoteInfo.sub === quoteInfo.today && quoteInfo.hasClass && !quoteInfo.hidden, '概览没显示当天文案：' + JSON.stringify(quoteInfo));
  pass('每日一句', `365 条不重复，最长 ${quoteInfo.maxLen} 字，今天「${quoteInfo.today}」`);

  /* ---------- 2. 新建目标表单：只剩 5 个字段 ---------- */
  await evaluate(`switchView('goals')`);
  await delay(250);
  await evaluate(`document.querySelector('[data-action="add-goal"]').click()`);
  await delay(250);
  const fields = await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    return {
      names: [...f.elements].map(e => e.name).filter(Boolean),
      labels: [...f.querySelectorAll(':scope > label')].map(l => l.firstChild.textContent.trim()),
      hasSelect: !!f.querySelector('select'),
      chips: f.querySelectorAll('.cat-opt').length,
      chipOn: (f.querySelector('.cat-opt.on') || {}).textContent,
      deadlineText: f.querySelector('.fb-val').textContent.trim(),
      inputBgs: [...f.querySelectorAll('input:not([type=hidden]), textarea')].map(e => getComputedStyle(e).backgroundColor),
      inputRadius: [...f.querySelectorAll('input:not([type=hidden]), textarea')].map(e => getComputedStyle(e).borderTopLeftRadius)
    };
  })()`);
  /* 2.10 起只有「目标 + 小目标」，按数量的字段整组下线 */
  const expectNames = ['title', 'category', 'deadline', 'dueTime', 'subtasks'];
  assert(JSON.stringify(fields.names) === JSON.stringify(expectNames), '表单字段异常：' + JSON.stringify(fields.names));
  assert(!fields.names.includes('note'), 'note 不该出现在表单里');
  assert(fields.hasSelect === false, '表单里还有原生下拉框');
  const trackPanel = await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    return {
      seg: f.querySelectorAll('.track-seg button').length,
      countPanes: f.querySelectorAll('[data-track-panel="count"]').length,
      trackField: !!f.querySelector('[name="track"]')
    };
  })()`);
  assert(trackPanel.seg === 0 && trackPanel.countPanes === 0 && !trackPanel.trackField,
    '表单里还留着按数量的控件：' + JSON.stringify(trackPanel));
  assert(fields.chips === 6 && fields.chipOn === '学习', '分类胶囊异常：' + fields.chips + ' / ' + fields.chipOn);
  assert(new Set(fields.inputBgs).size === 1, '输入框底色不统一：' + JSON.stringify(fields.inputBgs));
  assert(new Set(fields.inputRadius).size === 1, '输入框圆角不统一：' + JSON.stringify(fields.inputRadius));
  pass('目标表单精简', `字段 ${fields.names.join('/')}，分类 6 个胶囊 + 只走小目标，控件底色圆角一致`);

  /* ---------- 3. 分类胶囊点击写回隐藏字段 ---------- */
  await evaluate(`[...document.querySelectorAll('.cat-opt')].find(b => b.textContent === '财务').click()`);
  await delay(150);
  const catPick = await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    return { val: f.querySelector('input[name="category"]').value, on: f.querySelectorAll('.cat-opt.on').length, onText: f.querySelector('.cat-opt.on').textContent };
  })()`);
  assert(catPick.val === '财务' && catPick.on === 1 && catPick.onText === '财务', '分类选择没写回：' + JSON.stringify(catPick));
  pass('分类胶囊', '点「财务」→ 隐藏字段同步，选中态唯一');

  /* ---------- 4. 时间选择：三个常用时间 + 自定义 ---------- */
  await evaluate(`document.querySelector('[data-action="pick-deadline"]').click()`);
  await delay(250);
  const pickerOpen = await evaluate(`(() => {
    const h = document.getElementById('pickerHost');
    return {
      visible: h && !h.classList.contains('hidden'),
      days: h ? h.querySelectorAll('.cal-day').length : 0,
      quick: h ? Array.from(h.querySelectorAll('.time-quick [data-t]')).map(b => b.textContent.trim()) : [],
      hasCustom: !!(h && h.querySelector('[data-custom]')),
      hasNow: !!(h && h.querySelector('[data-now]')),
      hasNone: !!(h && h.querySelector('[data-timeclear]')),
      hourGrid: h ? h.querySelectorAll('.hour-grid button').length : 0,
      nativeInputs: document.querySelectorAll('input[type=date], input[type=time]').length
    };
  })()`);
  assert(pickerOpen.visible, '选择器没打开');
  assert(pickerOpen.days === 42, `日历格子数异常：${pickerOpen.days}`);
  assert(pickerOpen.quick.join('|') === '09:00|14:00|18:00', '常用时间不是 9/14/18 三个：' + pickerOpen.quick.join('|'));
  assert(pickerOpen.hasCustom && pickerOpen.hasNow && pickerOpen.hasNone, '缺少自定义 / 此刻 / 不提醒');
  assert(pickerOpen.hourGrid === 0, '24 格小时表应已移除');
  assert(pickerOpen.nativeInputs === 0, '页面仍有原生 date/time 输入');
  pass('时间选择', '3 个常用时间 + 自定义 + 此刻 + 不提醒，小时表已移除');

  await evaluate(`document.querySelector('.cal-day.today, .cal-day:not(.mute)').click()`);
  await delay(180);
  await evaluate(`document.querySelector('[data-t="18:00"]').click()`);
  await delay(180);
  await evaluate(`document.querySelector('[data-ok]').click()`);
  await delay(250);
  const quickPick = await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    return { t: f.querySelector('input[name="dueTime"]').value, label: f.querySelector('.fb-val').textContent.trim() };
  })()`);
  assert(quickPick.t === '18:00', '快捷时间没写回：' + JSON.stringify(quickPick));
  assert(quickPick.label.includes('18:00'), '截止文案没更新：' + quickPick.label);

  await evaluate(`document.querySelector('[data-action="pick-deadline"]').click()`);
  await delay(250);
  await evaluate(`document.querySelector('[data-custom]').click()`);
  await delay(250);
  const customUI = await evaluate(`(() => {
    const h = document.getElementById('pickerHost');
    const n = h.querySelectorAll('.time-num');
    return { count: n.length, v: n[0] ? n[0].value + ':' + n[1].value : '' };
  })()`);
  assert(customUI.count === 2, '自定义没出现小时/分钟输入：' + JSON.stringify(customUI));
  await evaluate(`(() => {
    const h = document.getElementById('pickerHour'), m = document.getElementById('pickerMin');
    h.value = '21'; h.dispatchEvent(new Event('input', { bubbles: true }));
    m.value = '35'; m.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(150);
  await evaluate(`document.querySelector('[data-ok]').click()`);
  await delay(250);
  const customPick = await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    return { t: f.querySelector('input[name="dueTime"]').value, closed: document.getElementById('pickerHost').classList.contains('hidden') };
  })()`);
  assert(customPick.t === '21:35', '自定义时间没写回：' + JSON.stringify(customPick));
  assert(customPick.closed, '选完选择器没关闭');
  pass('自定义时间', '手填 21:35 → 写回 21:35');

  await evaluate(`document.querySelector('[data-action="pick-deadline"]').click()`);
  await delay(220);
  await evaluate(`document.querySelector('[data-now]').click()`);
  await delay(150);
  const nowPick = await evaluate(`(() => {
    const h = document.getElementById('pickerHost');
    const on = h.querySelector('.time-quick .on');
    return { hour: String(new Date().getHours()).padStart(2, '0'), label: on ? on.textContent.trim() : '' };
  })()`);
  await evaluate(`document.querySelector('[data-cancel="1"]').click()`);
  await delay(150);
  const keptAfterCancel = await evaluate(`document.querySelector('form[data-form="goal"]').querySelector('input[name="dueTime"]').value`);
  assert(keptAfterCancel === '21:35', '取消后不应改动原时间：' + keptAfterCancel);
  pass('此刻', `当前 ${nowPick.hour} 点 → 切到「${nowPick.label || '自定义'}」，取消不改动`);

  /* ---------- 5. 新建目标：小目标默认展开、按钮统一 ---------- */
  await evaluate(`(() => {
    const f = document.querySelector('form[data-form="goal"]');
    f.elements.title.value = 'v19 折叠测试';
    f.elements.subtasks.value = '第一步\\n第二步';
    f.requestSubmit();
  })()`);
  await delay(450);
  const card = await evaluate(`(() => {
    const g = state.goals.find(x => x.title === 'v19 折叠测试');
    const el = [...document.querySelectorAll('.goal-card')].find(c => c.textContent.includes('v19 折叠测试'));
    const acts = [...el.querySelectorAll('.goal-acts button')].map(b => b.dataset.action);
    const sizes = [...el.querySelectorAll('.goal-acts button')].map(b => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); });
    return {
      hasGoal: !!g,
      folded: el.querySelector('.sub-wrap').hasAttribute('hidden'),
      items: el.querySelectorAll('.sub-item').length,
      heightOpen: Math.round(el.getBoundingClientRect().height),
      acts, sizes,
      foldRight: acts[acts.length - 1] === 'toggle-subfold',
      category: g.category,
      dueTime: g.dueTime,
      emojiLeft: /[✏️🗑️]/.test(el.querySelector('.goal-acts').textContent)
    };
  })()`);
  assert(card.hasGoal, '目标没创建成功');
  assert(card.category === '财务' && card.dueTime === '21:35', '分类或时间没带进新目标：' + JSON.stringify(card));
  assert(!card.folded && card.items === 2, '有小目标时应默认展开：' + JSON.stringify(card));
  assert(card.foldRight, '折叠按钮不在最右：' + JSON.stringify(card.acts));
  assert(new Set(card.sizes).size === 1 && card.sizes[0] === '30x30', '操作按钮尺寸不一致：' + JSON.stringify(card.sizes));
  assert(!card.emojiLeft, '还在用 emoji 图标');
  pass('目标卡片', `默认展开 ${card.items} 条小目标，按钮 ${card.sizes[0]}×3 统一，折叠在最右`);

  /* ---------- 6. 收起后高度与状态记忆 ---------- */
  await evaluate(`[...document.querySelectorAll('.goal-card')].find(c => c.textContent.includes('v19 折叠测试')).querySelector('[data-action="toggle-subfold"]').click()`);
  await delay(350);
  const foldedCard = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.goal-card')].find(c => c.textContent.includes('v19 折叠测试'));
    const g = state.goals.find(x => x.title === 'v19 折叠测试');
    return { hidden: el.querySelector('.sub-wrap').hasAttribute('hidden'), h: Math.round(el.getBoundingClientRect().height), saved: state.settings.subOpen[g.id] === false };
  })()`);
  assert(foldedCard.hidden && foldedCard.saved, '收起失败：' + JSON.stringify(foldedCard));
  assert(foldedCard.h < 160, `卡片收起后仍太高：${foldedCard.h}px`);

  await evaluate(`[...document.querySelectorAll('.goal-card')].find(c => c.textContent.includes('v19 折叠测试')).querySelector('[data-action="toggle-subfold"]').click()`);
  await delay(300);
  const reopen = await evaluate(`(() => {
    const g = state.goals.find(x => x.title === 'v19 折叠测试');
    const el = [...document.querySelectorAll('.goal-card')].find(c => c.textContent.includes('v19 折叠测试'));
    return { shown: !el.querySelector('.sub-wrap').hasAttribute('hidden'), saved: state.settings.subOpen[g.id] === true };
  })()`);
  assert(reopen.shown && reopen.saved, '展开异常：' + JSON.stringify(reopen));
  pass('小目标折叠', `收起后 ${foldedCard.h}px，展开/收起状态写入 settings.subOpen`);

  /* ---------- 7. 进度改由小目标驱动 ---------- */
  await evaluate(`[...document.querySelectorAll('.goal-card')].find(c => c.textContent.includes('v19 折叠测试')).querySelector('[data-action="toggle-subfold"]').click()`);
  await delay(300);
  await evaluate(`[...document.querySelectorAll('.goal-card')].find(c => c.textContent.includes('v19 折叠测试')).querySelector('[data-action="toggle-sub"]').click()`);
  await delay(300);
  const pctAfter = await evaluate(`goalPct(state.goals.find(x => x.title === 'v19 折叠测试'))`);
  assert(pctAfter === 50, `勾掉 1/2 小目标后进度应为 50，实际 ${pctAfter}`);
  pass('进度由小目标驱动', '1/2 小目标 → 50%');

  /* ---------- 8. 图标统一：习惯 / 目标 / 日记 / 底栏全部线性 SVG ---------- */
  await evaluate(`state = seedState(); saveState(); render();`);
  await delay(250);
  const icons = await evaluate(`(() => {
    const q = (sel) => document.querySelectorAll(sel).length;
    switchView('habits');
    const habits = { items: q('#view-habits .habit-item'), badge: q('#view-habits .ico-badge svg'), del: q('#view-habits .habit-item > .icon-btn svg') };
    switchView('goals');
    /* v2.2 起学习卡并入普通目标卡，这里只看目标卡本身的图标 */
    const goals = {
      cards: q('#view-goals .goal-card'),
      chip: q('#view-goals .goal-card .chip'),
      acts: q('#view-goals .goal-card .icon-btn svg'),
      subEdit: q('#view-goals .goal-card [data-action="edit-sub"]'),
      update: q('#view-goals .goal-card [data-action="edit-progress"]')
    };
    switchView('journal');
    const journal = { entries: q('#view-journal .journal-entry'), acts: q('#view-journal .journal-entry .icon-btn svg') };
    switchView('dashboard');
    const nav = q('#nav .ico svg');
    return { habits, goals, journal, nav };
  })()`);
  assert(icons.habits.badge === icons.habits.items && icons.habits.items > 0, '习惯图标没换成线性 SVG：' + JSON.stringify(icons.habits));
  assert(icons.habits.del === icons.habits.items, '习惯删除按钮不是线性图标：' + JSON.stringify(icons.habits));
  assert(icons.goals.chip === icons.goals.cards, '目标分类标签数量不对：' + JSON.stringify(icons.goals));
  assert(icons.goals.acts === icons.goals.cards * 2, '目标卡片按钮不全是线性的：' + JSON.stringify(icons.goals));
  assert(icons.goals.update === 0, '按数量已下线，不该再有「更新进度」入口');
  assert(icons.goals.subEdit > 0, '小目标文字应能点开编辑');
  assert(icons.journal.acts === icons.journal.entries * 2, '日记按钮不全是线性的：' + JSON.stringify(icons.journal));
  assert(icons.nav === 5, '底栏图标不是 5 个 SVG：' + icons.nav);
  pass('图标统一', `习惯 ${icons.habits.badge} 个徽标 / 目标 ${icons.goals.cards} 张卡 / 底栏 5 个，全部线性 SVG`);

  /* ---------- 9. 五套新配色接入主题系统 ---------- */
  const themes = await evaluate(`(() => {
    const before = document.documentElement.dataset.theme;
    const list = THEMES.map(t => t.id);
    const out = [];
    for (const id of ['oat', 'mist', 'clay', 'cedar', 'paper', 'ink']) {
      const t = applyTheme(id);
      const cs = getComputedStyle(document.documentElement);
      out.push({
        id,
        applied: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
        accent: cs.getPropertyValue('--accent').trim().toUpperCase(),
        bg: cs.getPropertyValue('--bg').trim().toUpperCase(),
        expectAccent: t.accent.toUpperCase(),
        expectBg: t.bg.toUpperCase(),
        onAccent: cs.getPropertyValue('--on-accent').trim()
      });
    }
    applyTheme(before);
    return { list, out, groups: THEMES.length };
  })()`);
  assert(themes.groups === 6, `配色应为 6 套，实际 ${themes.groups}`);
  assert(['oat', 'mist', 'clay', 'cedar', 'paper', 'ink'].every(id => themes.list.includes(id)), '缺少新版配色：' + themes.list.join(','));
  for (const t of themes.out) {
    assert(t.applied === t.id, `${t.id} 没生效`);
    assert(t.accent === t.expectAccent, `${t.id} 强调色不符：${t.accent} ≠ ${t.expectAccent}`);
    assert(t.bg === t.expectBg, `${t.id} 底色不符：${t.bg} ≠ ${t.expectBg}`);
    assert(t.onAccent, `${t.id} 缺少 on-accent`);
  }
  assert(themes.out.find(t => t.id === 'ink').mode === 'dark', '墨石·黑灰应为 dark 模式');
  assert(themes.out.filter(t => t.mode === 'dark').length === 1, '新版里只有墨石·黑灰是暗色');
  pass('配色接入', '6 套主题，色值与设计稿一致，墨石·黑灰走 dark 模式，旧主题已下线');

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('✗ ' + error.message);
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
