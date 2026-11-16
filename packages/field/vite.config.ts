import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * 开发预览把 /api 代理到本机仓库服务，页面同源，服务器不加 CORS。
 * 填了平台根地址时走 /__field，由这里转发，浏览器仍不直接跨域。
 * 本包不引用 @one/core、@one/wms、@one/app。
 */
const FORWARD = ['authorization', 'content-type', 'accept', 'x-workspace-id', 'x-field-client'];

function fieldRelay(): Plugin {
  return {
    name: 'field-upstream-relay',
    configureServer(server) {
      server.middlewares.use('/__field', (req, res) => {
        void relayUpstream(req, res);
      });
    },
  };
}

async function relayUpstream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const header = req.headers['x-field-base'];
  const baseUrl = Array.isArray(header) ? header[0] : header;
  let target: string;
  try {
    if (!baseUrl) throw new Error('missing');
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('scheme');
    const raw = req.url ?? '/';
    const path = raw.startsWith('/__field') ? raw.slice('/__field'.length) || '/' : raw;
    target = `${base.origin}${base.pathname.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  } catch {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'FIELD_BAD_URL', message: '地址不对' }));
    return;
  }
  const headers = new Headers();
  for (const name of FORWARD) {
    const value = req.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      redirect: 'manual',
      ...(hasBody ? { duplex: 'half' as const } : {}),
    });
    res.statusCode = upstream.status;
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('content-type', type);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'PLATFORM_UNREACHABLE', message: `连不上平台：${detail}` }));
  }
}

export default defineConfig({
  plugins: [react(), fieldRelay()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
