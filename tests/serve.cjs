/**
 * Growth OS 本地预览服务
 * /                        → 手机壳预览页
 * /app?sat=32&sab=24       → 安卓应用真实页面（注入模拟安全区的桥接）
 * 同一源，便于预览页控制 iframe 内的主题，也让 localStorage 正常工作。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const shellPath = path.join(__dirname, 'device-preview.html');
const appPath = path.join(root, 'app', 'src', 'main', 'assets', 'index.html');
const port = parseInt(process.env.PREVIEW_PORT || '8770', 10);

function bridge(insets) {
  return '<scr' + 'ipt>(function(){' +
    'var I=' + JSON.stringify(insets) + ';' +
    'window.AndroidBridge={' +
    'getSafeInsets:function(){return I;},' +
    'getScreenInfo:function(){return "preview";},' +
    'exportBackup:function(j,n){parent.postMessage({t:"backup",name:n},"*");},' +
    'shareBackup:function(j,n){window.__previewShare=j;parent.postMessage({t:"share",name:n},"*");},' +
    'autoBackup:function(j){window.__previewAuto=j;},' +
    'readAutoBackup:function(){return window.__previewAuto||"";},' +
    'setGoalReminders:function(j){window.__previewAlarms=j;},' +
    'notifyGoal:function(t,m){parent.postMessage({t:"notify",title:t,msg:m},"*");},' +
    'setSystemBars:function(c,d){parent.postMessage({t:"bars",color:c,dark:d},"*");},' +
    'openAppSettings:function(){parent.postMessage({t:"settings"},"*");}' +
    '};})();</scr' + 'ipt>';
}

function buildApp(url) {
  const html = fs.readFileSync(appPath, 'utf8');
  const sat = parseFloat(url.searchParams.get('sat')) || 0;
  const sab = parseFloat(url.searchParams.get('sab')) || 0;
  const sar = parseFloat(url.searchParams.get('sar')) || 0;
  const sal = parseFloat(url.searchParams.get('sal')) || 0;
  const insets = [sat, sar, sab, sal].join(',');
  return html.replace('<head>', '<head>' + bridge(insets));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(shellPath));
      return;
    }
    if (url.pathname === '/app' || url.pathname === '/app/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buildApp(url));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('error: ' + e.message);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('Growth OS preview: http://127.0.0.1:' + port + '/');
});
