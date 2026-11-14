/** v2.6 回归：品牌徽章（内嵌位图）/ 中英文左缘对齐 / 启动封面停留 1.5 秒 /
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
      markTag: mark ? mark.tagName : '',
      markFile: mark ? (mark.getAttribute('src') || '').slice(0, 30) : '',
      markLoaded: mark ? (mark.naturalWidth || 0) : 0,
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
  assert(first.markTag === 'IMG' && first.markFile.startsWith('data:image/png;base64,'), `封面应内嵌徽章位图，实际 ${first.markTag} ${first.markFile}`);
  assert(first.markLoaded >= 600, '封面徽章位图没加载出来');
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

  /* ---------- 4. 品牌区：两处 logo 都用抠好的徽章位图 ---------- */
  const brand = await evaluate(`(() => {
    const logos = [...document.querySelectorAll('.logo')];
    const imgs = logos.map(l => l.querySelector('img'));
    const h1 = document.querySelector('.brand h1');
    const sub = document.querySelector('.brand .sub');
    return {
      n: logos.length,
      sameSrc: imgs.every(i => i && (i.getAttribute('src') || '').startsWith('data:image/png;base64,')) &&
        imgs[0].getAttribute('src') === imgs[1].getAttribute('src'),
      loaded: imgs.every(i => i && i.naturalWidth > 0),
      sizes: logos.map(l => Math.round(l.getBoundingClientRect().width)).filter(w => w > 0),
      letter: document.querySelector('.logo').textContent.trim(),
      sub: sub.textContent.trim(),
      title: h1.textContent.trim(),
      h1Left: h1.getBoundingClientRect().left,
      subLeft: sub.getBoundingClientRect().left,
      indent: getComputedStyle(sub).marginLeft
    };
  })()`);
  assert(brand.n === 2, `品牌 logo 应有 2 处（顶栏 + 侧栏），实际 ${brand.n}`);
  assert(brand.sameSrc, '顶栏 / 侧栏 logo 应统一内嵌同一张徽章位图');
  assert(brand.loaded, 'logo 位图没加载出来（naturalWidth 为 0）');
  assert(brand.letter === '', `logo 里不该再有字母，实际「${brand.letter}」`);
  assert(brand.title === '人生切片' && brand.sub === 'Slicelog', `品牌文字不对：${JSON.stringify(brand.title)} / ${JSON.stringify(brand.sub)}`);
  pass('顶部品牌', `位图徽章 ${brand.sizes.join('/')}px，文字「${brand.title} · ${brand.sub}」`);

  /* 中文标题保持不动，英文右移 2px，对齐两行的视觉左缘 */
  const gap = brand.h1Left - brand.subLeft;
  assert(brand.indent === '2px', `英文副标题缺少右移补偿，实际 margin-left:${brand.indent}`);
  assert(Math.abs(gap + 2) <= 1, `中英文左缘没对齐：盒子左缘差 ${gap.toFixed(1)}px`);
  pass('中英文对齐', `中文不动，英文右移 2px，两行盒子左缘差 ${gap.toFixed(1)}px`);

  /* 页面里不再留手绘的 SVG 徽章，避免出现两套 logo */
  const sprite = await evaluate(`(() => ({
    symbol: !!document.querySelector('symbol#slicelog-mark, symbol#slicelog-mark-lite'),
    use: document.querySelectorAll('use').length
  }))()`);
  assert(!sprite.symbol && sprite.use === 0, '页面上还留着 SVG 徽章 symbol');
  pass('素材来源', '封面与两处 logo 共用一张抠图，页面里没有第二套矢量徽章');

  /* 深色主题下位图照常显示 */
  await evaluate(`applyTheme('pine'); render()`);
  await delay(150);
  const dark = await evaluate(`(() => ({
    loaded: [...document.querySelectorAll('.logo img')].every(i => i.naturalWidth > 0),
    text: getComputedStyle(document.querySelector('.brand h1')).color
  }))()`);
  assert(dark.loaded, '深色主题下 logo 位图丢了');
  pass('深色主题', `透明底 PNG 不受主题影响，标题色 ${dark.text}`);
  await evaluate(`applyTheme('oat'); render()`);

  /* ---------- 5. Android 资源：图标与启动画面都用同一张抠图 ---------- */
  const colors = readRes('values/colors.xml');
  const v31 = readRes('values-v31/styles.xml');
  const adaptive = readRes('mipmap-anydpi-v26/ic_launcher.xml');
  const adaptiveRound = readRes('mipmap-anydpi-v26/ic_launcher_round.xml');
  const legacy = readRes('mipmap-anydpi/ic_launcher.xml');
  const resFile = rel => path.join(root, 'app', 'src', 'main', 'res', rel);
  const iconPng = fs.statSync(resFile('drawable-xxxhdpi/ic_launcher_mark.png'));
  const transparentSplash = readRes('drawable/ic_splash_transparent.xml');

  assert(/name="ic_launcher_background">#183426/.test(colors), `adaptive icon 背景色应与图片圆边同色 #183426，实际 ${colors.match(/ic_launcher_background">([^<]+)/)}`);
  assert(/name="brand_cream">#F5F2E8/.test(colors), '缺少封面米白 brand_cream');
  assert(/ic_launcher_mark/.test(adaptive) && /ic_launcher_background/.test(adaptive), '自适应图标引用异常');
  assert(/ic_launcher_mark/.test(adaptiveRound), '圆形自适应图标引用异常');
  assert(/<bitmap/.test(legacy) && /ic_launcher_mark/.test(legacy), '旧版（<26）图标应改为深绿底 + 居中位图');
  assert(/windowSplashScreenBackground/.test(v31) && /brand_cream/.test(v31), 'Android 12 启动画面没配与网页一致的底色');
  assert(/windowSplashScreenAnimatedIcon/.test(v31) && /ic_splash_transparent/.test(v31), 'Android 12 系统启动图标应隐藏，避免与网页封面重复');
  assert(/windowSplashScreenAnimationDuration">0</.test(v31), '系统启动画面的退出动画应设为 0');
  assert(/@android:color\/transparent/.test(transparentSplash), '系统启动图标不是全透明');
  assert(iconPng.size > 20000, `桌面图标位图太小/缺失：${iconPng.size} B`);
  pass('Android 启动', `桌面图标 ${Math.round(iconPng.size / 1024)}KB；系统 SplashScreen 已隐藏，只显示网页封面`);

  /* ---------- 6. 页面里没有遗留的旧矢量徽章或字母 logo ---------- */
  const leftovers = await evaluate(`(() => {
    const html = document.documentElement.outerHTML;
    return {
      oldHref: html.includes('#slicelog-mark'),
      countS: (html.match(/>S<\\/div>/g) || []).length
    };
  })()`);
  assert(!leftovers.oldHref, '页面里还引用着旧的 #slicelog-mark 矢量徽章');
  assert(leftovers.countS === 0, '还残留纯字母 S 的 logo');
  pass('无遗留', '封面、顶栏、侧栏、桌面图标全部走同一张抠图');

  console.log(`\n全部通过：${results.length} 项`);
  ws.close();
}

main().catch(error => {
  console.error('\n✗ ' + (error.message || error));
  process.exitCode = 1;
}).finally(() => setTimeout(() => browser.kill(), 300));
