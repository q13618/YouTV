#!/usr/bin/env node
// YouTV 监控台服务：静态文件 + HLS 代理（解决浏览器跨域 CORS 限制）。
// 零依赖，Node 18+ 即可运行：node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
// 可选：只允许代理这些域名（逗号分隔，支持 *.example.com）
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// 默认禁止代理内网地址，防止被当作 SSRF 跳板；内网流媒体可设 ALLOW_PRIVATE=1
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 15000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u': 'audio/x-mpegurl; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

function hostAllowed(host) {
  if (!ALLOWED_HOSTS.length) return true;
  host = host.toLowerCase();
  return ALLOWED_HOSTS.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) || host === p.slice(2) : host === p));
}

async function assertSafeTarget(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw Object.assign(new Error('只支持 http/https'), { status: 400 });
  if (!hostAllowed(u.hostname)) throw Object.assign(new Error('域名不在 ALLOWED_HOSTS 白名单中'), { status: 403 });
  if (ALLOW_PRIVATE) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw Object.assign(new Error('禁止代理内网地址'), { status: 403 });
}

// 手动跟随重定向，每一跳都做安全检查
async function fetchUpstream(target, req, res) {
  let url = new URL(target);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  // 客户端提前断开（如切换频道）时中止上游请求
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  try {
    for (let hop = 0; hop < 5; hop++) {
      await assertSafeTarget(url);
      const headers = { 'user-agent': req.headers['user-agent'] || 'YouTV-Monitor' };
      if (req.headers.range) headers.range = req.headers.range;
      const res = await fetch(url, { redirect: 'manual', headers, signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url);
        continue;
      }
      return { res, finalUrl: url.href, done: () => clearTimeout(timer) };
    }
    throw Object.assign(new Error('重定向次数过多'), { status: 502 });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

const proxied = (u) => '/proxy?url=' + encodeURIComponent(u);

// 把播放列表中的分片、子播放列表、密钥地址都改写成经过代理的地址
function rewritePlaylist(text, base) {
  const abs = (ref) => { try { return new URL(ref, base).href; } catch { return ref; } };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxied(abs(uri))}"`);
    return proxied(abs(t));
  }).join('\n');
}

function looksLikePlaylist(url, contentType) {
  return /mpegurl/i.test(contentType || '') || /\.m3u8?(\?|$)/i.test(url);
}

async function handleProxy(req, res, query) {
  const target = query.get('url');
  const raw = query.get('raw') === '1';
  if (!target) return sendError(res, 400, '缺少 url 参数');
  let upstream;
  try {
    upstream = await fetchUpstream(target, req, res);
  } catch (e) {
    return sendError(res, e.status || 502, upstreamErrorText(e));
  }
  const { res: up, finalUrl, done } = upstream;
  const ct = up.headers.get('content-type') || '';
  const baseHeaders = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-final-url',
    'cache-control': 'no-store',
    'x-final-url': finalUrl,
  };
  try {
    if (looksLikePlaylist(finalUrl, ct)) {
      const text = await up.text();
      const body = !raw && text.trimStart().startsWith('#EXTM3U') ? rewritePlaylist(text, finalUrl) : text;
      res.writeHead(up.status, { ...baseHeaders, 'content-type': ct || 'application/vnd.apple.mpegurl' });
      res.end(body);
      return;
    }
    const headers = { ...baseHeaders };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(up.status, headers);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) sendError(res, 502, e.message);
    else res.destroy();
  } finally {
    done();
  }
}

function upstreamErrorText(e) {
  if (e.status) return e.message;
  if (e.name === 'AbortError') return '上游超时';
  const code = e.code || e.cause?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败';
  if (code === 'ECONNREFUSED') return '连接被拒绝';
  if (code === 'ECONNRESET') return '连接被重置';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时';
  if (code && /CERT|SSL|TLS/i.test(code)) return 'HTTPS 证书错误';
  return e.message || '上游请求失败';
}

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(message);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return sendError(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendError(res, 404, 'Not Found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range' });
    return res.end();
  }
  if (pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, proxy: true }));
  }
  if (pathname === '/proxy') return void handleProxy(req, res, searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method Not Allowed');
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`YouTV 监控台已启动: http://localhost:${PORT}`);
  if (ALLOWED_HOSTS.length) console.log('代理白名单:', ALLOWED_HOSTS.join(', '));
});
