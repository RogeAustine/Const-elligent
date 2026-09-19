#!/usr/bin/env node
/**
 * 见仁建智 · 静态文件服务（零依赖）
 * ---------------------------------------------------------------------------
 * index.html 双击即可打开，但有两件事只有 http 才能做：
 *   1) 用手机/平板在同一个局域网里给评委看（file:// 无法被其他设备访问）；
 *   2) 避免个别浏览器对 file:// 下 fetch 的限制。
 *
 * 启动：node tools/serve.js --port 8080
 * 然后浏览器打开 http://127.0.0.1:8080/
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.indexOf('--') === 0) {
    const k = a.slice(2);
    const v = arr[i + 1];
    args[k] = (v && v.indexOf('--') !== 0) ? v : true;
  }
});

const PORT = parseInt(args.port || process.env.PORT || '8080', 10);
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';

  // 目录穿越防护：解析后必须仍在 ROOT 之内
  const target = path.resolve(ROOT, '.' + rel);
  if (target.indexOf(ROOT) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('禁止访问');
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未找到：' + rel);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('见仁建智 · 静态演示服务已启动');
  console.log('  本机访问 : http://127.0.0.1:' + PORT + '/');
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(name => {
    (nets[name] || []).forEach(n => {
      if (n.family === 'IPv4' && !n.internal) {
        console.log('  局域网   : http://' + n.address + ':' + PORT + '/   （同一 WiFi 下的手机/平板可打开）');
      }
    });
  });
  console.log('\n按 Ctrl+C 停止。');
});
