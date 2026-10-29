/**
 * 弈境五子棋 · 本地与局域网开发服务器 (Zero-dependency HTTP Server)
 * 
 * 功能：
 *   1. 静态资源托管（根目录 index.html, js, css 等）；
 *   2. 本地内存版跨设备配置同步接口 (/api/sync/:code)，支持局域网多设备/手机拉取配置；
 *   3. 零外部依赖，使用 Node.js 标准库即可直接运行。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// 本地内存配置存储，用于局域网测试同步
const localSyncStore = new Map();

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(data);
  });
}

async function handleSyncRoute(req, res, code, method) {
  const normCode = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normCode) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: '无效同步码' }));
    return;
  }

  if (method === 'GET') {
    const item = localSyncStore.get(normCode);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: '未找到该同步码的配置' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, data: item, code: normCode }));
    return;
  }

  if (method === 'PUT') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body);
      localSyncStore.set(normCode, data);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({
        ok: true,
        code: normCode,
        updatedAt: data.updatedAt || Date.now(),
        expiresAt: Date.now() + 30 * 24 * 3600 * 1000
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: false, error: '配置数据非合法 JSON' }));
    }
    return;
  }

  if (method === 'DELETE') {
    localSyncStore.delete(normCode);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, code: normCode }));
    return;
  }

  res.writeHead(405).end('Method Not Allowed');
}

const server = http.createServer(async (req, res) => {
  // 跨域支持，便于局域网设备间配置同步与联机访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // 同步 API 路由
  if (url.pathname.startsWith('/api/sync/')) {
    const code = decodeURIComponent(url.pathname.slice('/api/sync/'.length));
    return handleSyncRoute(req, res, code, req.method);
  }

  // 健康检测
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
    return;
  }

  // 默认静态资源托管
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const lanIp = getLanIp();
  console.log('');
  console.log('  ☯ 弈境五子棋 · 本地服务已启动');
  console.log(`  ➤ 本机访问: http://127.0.0.1:${PORT}`);
  console.log(`  ➤ 手机/局域网访问: http://${lanIp}:${PORT}`);
  console.log('');
  console.log('  关闭本窗口即可退出服务。');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。如需换端口：set PORT=5199 && node server.mjs`);
  } else {
    console.error('启动失败：', err);
  }
  process.exit(1);
});
