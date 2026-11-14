/** v2.3 回归：品牌图标（矢量徽章 / 小尺寸标记）/ 启动封面停留 1.5 秒 /
    Android 图标与启动画面资源 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9366;
const profile = path.join(root, '.edge-v23-profile');
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
const pageURL = query => pathToFileURL(path.join(root, 'app', 'src', 'main', 'assets', 'index.html')).href + (query || '');
const readRes = rel => fs.readFileSync(path.join(root, 'app', 'src', 'main', 'res', rel), 'utf8');

async function goto(query) {
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pageURL(query) });
  await loaded;
  await evaluate('document.fonts.ready');
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

  /* ---------- 1. 启动封面：默认出现，铺满、米白、压在最上层 ---------- */
  await goto('');
  const first = await evaluate(`(() => {
    const el = document.getElementById('splash');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const mark = el.querySelector('.splash-mark');
    return {
      fixed: cs.position, inset: [cs.top, cs.right, cs.bottom, cs.left].join(','),
      bg: cs.backgroundColor, z: cs.zIndex,
      delay: cs.animationDelay, dur: cs.animationDuration, fill: cs.animationFillMode,
      name: el.querySelector('.splash-name').textContent.trim(),
      latin: el.querySelector('.splash-latin').textContent.trim(),
      markBox: mark ? [Math.round(mark.getBoundingClientRect().width), Math.round(mark.getBoundingClientRect().height)] : null,
      useHref: mark && mark.querySelector('use') ? mark.querySelector('use').getAttribute('href') : '',
      booting: document.documentElement.classList.contains('booting'),
      docOverflow: getComputedStyle(document.documentElement).overflow
    };
  })()`);
  assert(first, '启动封面没有渲染');
  assert(first.fixed === 'fixed' && first.inset === '0px,0px,0px,0px', `封面应铺满全屏：${first.fixed} ${first.inset}`);
  assert(first.bg === 'rgb(245, 242, 232)', `封面底色应为米白 #F5F2E8，实际 ${first.bg}`);
  assert(Number(first.z) >= 9000, `封面层级不够：${first.z}`);
  assert(first.name === '人生切片' && first.latin === 'Slicelog', `封面文字不对：${first.name} / ${first.latin}`);
  assert(first.markBox && first.markBox[0] >= 200, `封面徽章太小：${first.markBox}`);
  assert(first.useHref === '#slicelog-mark', `封面应引用完整徽章，实际 ${first.useHref}`);
  assert(first.delay === '1.5s', `封面停留时长应为 1.5s，实际 ${first.delay}`);
  assert(first.dur === '0.44s', `封面淡出时长异常：${first.dur}`);
  assert(first.fill === 'forwards', '封面动画没有保持结束态，JS 失效时会一直挡着');
  assert(first.booting && first.docOverflow === 'hidden', '封面期间应锁住背景滚动');
  pass('启动封面', `米白底 + ${first.markBox[0]}px 徽章，停留 ${first.delay} 后 ${first.dur} 淡出`);
  await delay(260);
  await shot('v23-splash.png');

  /* ---------- 2. 封面到点自动退场并摘掉节点 ---------- */
  await delay(2100);
  const after = await evaluate(`(() => ({
    gone: !document.getElementById('splash'),
    booting: document.documentElement.classList.contains('booting'),
    overflow: getComputedStyle(document.documentElement).overflow
  }))()`);
  assert(after.gone, '封面超过 2 秒还在 DOM 里');
  assert(!after.booting && after.overflow !== 'hidden', '封面退场后没有恢复滚动');
  pass('封面退场', '约 1.9s 后移除节点并恢复滚动');

  /* ---------- 3. ?nosplash 直接跳过 ---------- */
  await goto('?nosplash=1');
  const skipped = await evaluate(`(() => ({
    gone: !document.getElementById('splash'),
    cls: document.documentElement.className,
    booting: document.documentElement.classList.contains('booting')
  }))()`);
  assert(skipped.gone, '?nosplash=1 时封面应立即移除');
  assert(!skipped.booting, '?nosplash=1 不该锁滚动');
  pass('跳过封面', '?nosplash=1 · 立刻可交互');

  /* ---------- 4. 顶部品牌区：两处 logo 都是矢量小标记 ---------- */
  const brand = await evaluate(`(() => {
    const logos = [...document.querySelectorAll('.logo')];
    return {
      n: logos.length,
      mini: logos.every(l => l.querySelector('svg use') && l.querySelector('svg use').getAttribute('href') === '#slicelog-mark-lite'),
      round: logos.every(l => getComputedStyle(l.querySelector('svg')).borderRadius === '50%'),
      sizes: logos.map(l => Math.round(l.getBoundingClientRect().width)).filter(w => w > 0),
      letter: document.querySelector('.logo').textContent.trim(),
      sub: document.querySelector('.brand .sub').textContent.trim(),
      title: document.querySelector('.brand h1').textContent.trim()
    };
  })()`);
  assert(brand.n === 2, `品牌 logo 应有 2 处（顶栏 + 侧栏），实际 ${brand.n}`);
  assert(brand.mini, '顶部 logo 应引用完整构图的小尺寸标记 #slicelog-mark-lite');
  assert(brand.round, 'logo 容器没有圆形裁切');
  assert(brand.letter === '', `logo 里不该再有字母，实际「${brand.letter}」`);
  assert(brand.title === '人生切片' && brand.sub === 'Slicelog', `品牌文字不对：${JSON.stringify(brand.title)} / ${JSON.stringify(brand.sub)}`);
  pass('顶部品牌', `矢量标记 ${brand.sizes.join('/')}px，文字「${brand.title} · ${brand.sub}」`);

  /* 小尺寸标记保留完整构图：圆章 + 切片 + 人 + 月牙 + 树苗，不是一根弧线 */
  const lite = await evaluate(`(() => {
    const sym = document.querySelector('#slicelog-mark-lite');
    if (!sym) return null;
    return {
      paths: sym.querySelectorAll('path').length,
      circles: sym.querySelectorAll('circle').length,
      cream: [...sym.querySelectorAll('path')].filter(p => p.getAttribute('stroke') === '#F3F0E3' && p.getAttribute('fill') === 'none').length
    };
  })()`);
  assert(lite, '缺少 #slicelog-mark-lite 标记');
  assert(lite.paths >= 12, `小尺寸标记元素过少（${lite.paths} 条 path），可能是被简化回单弧线了`);
  assert(lite.circles >= 3 && lite.cream >= 4, `小尺寸标记缺少人物构成：circle ${lite.circles} / 笔画路径 ${lite.cream}`);
  pass('小尺寸标记', `${lite.paths} 条路径 + ${lite.circles} 个圆，完整构图`);

  /* 深色主题下标记不透明、文字仍可读 */
  await evaluate(`applyTheme('pine'); render()`);
  await delay(150);
  const dark = await evaluate(`(() => {
    /* 图形在 symbol 里，use 的影子树查不到，直接看 symbol 的源 */
    const circle = document.querySelector('#slicelog-mark-lite circle');
    return { fill: circle ? circle.getAttribute('fill') : '', text: getComputedStyle(document.querySelector('.brand h1')).color };
  })()`);
  assert(dark.fill === '#3F5B49', `深色主题下徽章底色被改了：${dark.fill}`);
  pass('深色主题', `徽章固定深绿 ${dark.fill}，标题色 ${dark.text}`);
  await evaluate(`applyTheme('oat'); render()`);

  /* ---------- 5. Android 资源：图标、颜色、启动画面 ---------- */
  const fg = readRes('drawable/ic_launcher_foreground.xml');
  const splashMark = readRes('drawable/ic_splash_mark.xml');
  const legacy = readRes('mipmap-anydpi/ic_launcher.xml');
  const colors = readRes('values/colors.xml');
  const v31 = readRes('values-v31/styles.xml');
  const adaptive = readRes('mipmap-anydpi-v26/ic_launcher.xml');

  assert(/#3F5B49/.test(colors), '图标背景色没有改成品牌深绿');
  assert(/name="ic_launcher_background">#3F5B49/.test(colors), 'adaptive icon 背景色不是 #3F5B49');
  assert(/name="brand_cream">#F5F2E8/.test(colors), '缺少封面米白 brand_cream');
  assert(/#3F5B49/.test(fg) && /#F3F0E3/.test(fg), '图标前景缺少品牌配色');
  assert(!/#2E7D5B/.test(fg + legacy + splashMark), '旧绿色 #2E7D5B 还有残留');
  assert(/android:scaleX="0\.7[0-9]"/.test(fg), '图标前景没有缩进安全区');
  assert(/M0,0h108v108h-108z/.test(legacy), '旧版图标缺少满底背景');
  assert(/windowSplashScreenBackground/.test(v31) && /brand_cream/.test(v31), 'Android 12 启动画面没配底色');
  assert(/windowSplashScreenAnimatedIcon/.test(v31) && /ic_splash_mark/.test(v31), 'Android 12 启动画面没配图标');
  assert(/ic_launcher_foreground/.test(adaptive) && /ic_launcher_background/.test(adaptive), '自适应图标引用异常');
  pass('Android 图标', '自适应前景 + 满底旧版 + Android 12 启动画面均指向同一套路径');

  /* ---------- 6. 页面里没有遗留的位图图标或旧字母 logo ---------- */
  const leftovers = await evaluate(`(() => {
    const html = document.documentElement.outerHTML;
    return {
      png: /mipmap-.*\\.png|logo\\.png/.test(html),
      countS: (html.match(/>S<\\/div>/g) || []).length
    };
  })()`);
  assert(!leftovers.png, '页面里还引用着位图图标');
  assert(leftovers.countS === 0, '还残留纯字母 S 的 logo');
  pass('无遗留', '没有位图图标，也没有字母 S 占位');

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('\n✗ ' + (error.message || error));
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
