import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { handleApi } from './api.mjs';

const port = Number(process.env.BUDDY_PORT ?? 8714);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BUDDY_PORT 必须是有效端口');

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

async function handleRequest(request) {
  const response = await handleApi(request, process.env);
  if (response) return response;
  const asset = assets.get(new URL(request.url).pathname);
  if (!asset || request.method !== 'GET') return new Response('Not found', { status: 404 });
  const [filename, type] = asset;
  const file = await readFile(new URL(`../public/${filename}`, import.meta.url));
  return new Response(file, { headers: { 'content-type': type } });
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const cancel = new AbortController();
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) cancel.abort();
    });
    const method = incoming.method;
    const options = { method, signal: cancel.signal, headers: incoming.headers };
    if (method !== 'GET' && method !== 'HEAD') {
      options.body = Readable.toWeb(incoming);
      options.duplex = 'half';
    }
    const request = new Request(new URL(incoming.url, `http://127.0.0.1:${port}`), options);
    const response = await handleRequest(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch (error) {
    console.error(error.message);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end('服务处理失败');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`投资研究工作台 http://127.0.0.1:${port}/`));

