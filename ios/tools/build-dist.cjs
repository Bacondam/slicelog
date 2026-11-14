/** 打包发布目录：node tools/build-dist.cjs  →  dist/ */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });

const files = ['index.html', 'sw.js', 'manifest.webmanifest'];
files.forEach(f => fs.copyFileSync(path.join(root, f), path.join(dist, f)));

fs.readdirSync(path.join(root, 'icons'))
  .filter(f => f.endsWith('.png'))
  .forEach(f => fs.copyFileSync(path.join(root, 'icons', f), path.join(dist, 'icons', f)));

const size = files.reduce((a, f) => a + fs.statSync(path.join(dist, f)).size, 0);
console.log('dist 已生成：' + files.join(', ') + ` + icons(${fs.readdirSync(path.join(dist, 'icons')).length} 个)`);
console.log('index.html ' + (fs.statSync(path.join(dist, 'index.html')).size / 1024).toFixed(0) + ' KB');
