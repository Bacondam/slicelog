// 局域网 APK 分发：手机浏览器直接下载安装包
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/APP/GrowthOS';
const PORT = 8775;
const MIME = {
  '.apk': 'application/vnd.android.package-archive',
  '.png': 'image/png',
  '.rar': 'application/octet-stream',
  '.zip': 'application/zip',
};

http.createServer((req, res) => {
  let raw = decodeURIComponent(req.url.split('?')[0]);
  if (raw === '/' || raw === '') {
    const files = fs.readdirSync(ROOT).filter(f => /\.(apk|png|rar|zip)$/i.test(f));
    const list = files.map(f => {
      const st = fs.statSync(path.join(ROOT, f));
      return `<li><a href="/${encodeURIComponent(f)}">${f}</a> <span>${(st.size / 1024).toFixed(0)} KB</span></li>`;
    }).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.6 -apple-system,sans-serif;padding:20px;background:#f4f7f5;color:#1f2d27}
h1{font-size:18px}ul{list-style:none;padding:0}li{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:10px;
display:flex;justify-content:space-between;gap:12px}a{color:#1a7f5a;text-decoration:none;font-weight:600;word-break:break-all}
span{color:#7b8c84;font-size:13px;flex:0 0 auto}</style>
<h1>成长日志 · 安卓安装包</h1><ul>${list}</ul>`);
    return;
  }
  const file = path.join(ROOT, raw.replace(/^\//, ''));
  if (!path.resolve(file).startsWith(path.resolve(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('404'); return;
  }
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log(`apk-download http://192.168.2.11:${PORT}/`));
