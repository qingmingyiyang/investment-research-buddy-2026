import html from '../public/index.html';
import css from '../public/style.css';
import javascript from '../public/app.js';
import { handleApi } from '../server/api.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, env);
    if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/style.css') return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
    if (url.pathname === '/app.js') return new Response(javascript, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    return new Response('Not found', { status: 404 });
  }
};

