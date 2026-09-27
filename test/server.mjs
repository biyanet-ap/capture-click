// 픽스처용 2-origin 정적 서버
//   origin A: http://127.0.0.1:4101  (캡처 대상 페이지)
//   origin B: http://127.0.0.1:4102  (CDN 역할. /cors/* 만 Access-Control-Allow-Origin:* 응답)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TYPES = {
  '.html': 'text/html', // charset 미지정 → 문서의 <meta charset> 이 인코딩을 결정
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
};

function createServer(root, { cors }) {
  return http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.normalize(path.join(root, urlPath === '/' ? '/index.html' : urlPath));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
      if (cors(urlPath)) headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

export async function startServers() {
  const a = createServer(path.join(dir, 'origin-a'), { cors: () => false });
  const b = createServer(path.join(dir, 'origin-b'), { cors: (p) => p.startsWith('/cors/') });
  await Promise.all([
    new Promise((r) => a.listen(4101, '127.0.0.1', r)),
    new Promise((r) => b.listen(4102, '127.0.0.1', r)),
  ]);
  return () => Promise.all([a, b].map((s) => new Promise((r) => s.close(r))));
}
