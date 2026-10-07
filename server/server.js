'use strict';
/** HTTP 服务器: /api/* 走 JSON 接口, 其余按静态文件服务 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DB } = require('./db');
const { seed } = require('./seed');
const api = require('./api');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
};

function createServer(opts = {}) {
  const dbFile = Object.prototype.hasOwnProperty.call(opts, 'dbFile')
    ? opts.dbFile
    : path.join(ROOT, 'data', 'db.json');
  const db = new DB(dbFile);
  if (db.collection('statements').all().length === 0) {
    seed(db);
    db.save();
  }
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); return res.end(); }
    if (url.pathname.startsWith('/api/')) return api.handle(db, req, res, url);
    serveStatic(res, url.pathname);
  });
  return { server, db };
}

function serveStatic(res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); }
  catch { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer();
  server.listen(port, () => {
    console.log(`西安文化站点已启动: http://localhost:${port}`);
    console.log(`  礼仪提示: /guide.html  工作台: /workbench.html  打印卡: /print.html  分享页: /share.html`);
  });
}

module.exports = { createServer };
