/** 主题落地截图：逐款切换后截日记页，再拼成一张总览 */
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const port = 9343, profile = path.join(__dirname, '..', '.edge-theme-profile');
const W = 390, H = 844, DPR = 2;
const IDS = ['oat', 'mist', 'clay', 'cedar', 'paper', 'ink'];
const browser = spawn('C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,
   `--user-data-dir=${profile}`,'--hide-scrollbars','about:blank'], { stdio:'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 0; const pending = new Map(), events = new Map(), errors = [];
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const waitEvent = n => new Promise(r => { const l = events.get(n) || []; l.push(r); events.set(n, l); });

(async () => {
  let pages;
  for (let i = 0; i < 100; i++) { try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (pages.length) break; } catch (_) {} await delay(100); }
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const it = pending.get(m.id); pending.delete(m.id); m.error ? it.rej(new Error(JSON.stringify(m.error))) : it.res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
    else if (m.method && events.has(m.method)) { const l = events.get(m.method); events.delete(m.method); l.forEach(r => r(m.params)); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: 'http://127.0.0.1:8770/app?sat=32&sab=24' });
  await loaded; await delay(2600);

  const files = [];
  for (const id of IDS) {
    await send('Runtime.evaluate', { expression:
      `(function(){var d=document.querySelector('[data-action="dismiss-demo"]');if(d)d.click();` +
      `state.settings.cardFold=state.settings.cardFold||{};state.settings.cardFold['journal:countdown']=true;` +
      `applyTheme('${id}');saveState();switchView('journal');render();scrollTo(0,0);})()`, awaitPromise: false });
    await delay(500);
    /* 有些版本切换后又会 render 一次，再钉一遍视图，等稳定 */
    await send('Runtime.evaluate', { expression:
      `switchView('journal');scrollTo(0,0);`, awaitPromise: false });
    await delay(700);
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const f = path.join(__dirname, 'theme-shots', id + '.png');
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    files.push({ id, f });
    console.log('shot', id);
  }
  if (errors.length) console.log('JS 报错:', errors.slice(0, 4).join(' | ')); else console.log('无 JS 报错');

  // 拼总览
  const NAMES = { oat: '燕麦 · 苔绿', mist: '雾霭 · 靛蓝', clay: '陶土 · 砖红', cedar: '雪松 · 青碧', paper: '纸白 · 墨', ink: '墨石 · 黑灰' };
  const cells = files.map(x => `<figure><img src="data:image/png;base64,${fs.readFileSync(x.f).toString('base64')}"><figcaption>${NAMES[x.id]}</figcaption></figure>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:26px 28px 30px;background:#E9E8E3;font-family:"Segoe UI","PingFang SC",system-ui,sans-serif;}
    h1{font-size:17px;margin:0 0 4px;color:#24231F;} p{margin:0 0 18px;font-size:11.5px;color:#7C776E;}
    .grid{display:grid;grid-template-columns:repeat(3,262px);gap:16px;}
    figure{margin:0;}
    img{width:262px;display:block;border-radius:14px;box-shadow:0 4px 14px rgba(0,0,0,.13);border:1px solid rgba(0,0,0,.08);}
    figcaption{font-size:11.5px;color:#3A3833;text-align:center;padding-top:7px;letter-spacing:.3px;}
  </style></head><body>
    <h1>Slicelog 六款主题 · 真实页面</h1>
    <p>同一屏内容（日记页 · 倒数日展开），只换主题</p>
    <div class="grid">${cells}</div></body></html>`;
  fs.writeFileSync(path.join(__dirname, 'theme-montage.html'), html, 'utf8');
  console.log('montage html ok');
  ws.close();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; }).finally(() => setTimeout(() => browser.kill(), 300));
