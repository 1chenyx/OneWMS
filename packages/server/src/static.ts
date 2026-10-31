import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';

/** 前端构建产物目录（packages/app/dist，由本文件位置推算） */
export const APP_DIST = fileURLToPath(new URL('../../app/dist', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * SPA 静态托管：app/dist 存在则挂载（同源免 CORS）+ history 路由回退 index.html。
 * dist 不存在时静默跳过——纯 API 模式可独立运行（dev 阶段前端走 Vite 5173）。
 * 自实现而非 @hono/node-server/serve-static：其 root 相对 cwd，行为不可控。
 */
export function mountStatic(app: Hono, distDir: string = APP_DIST): void {
  if (!existsSync(join(distDir, 'index.html'))) return;
  const root = resolve(distDir);
  app.get('*', async (c: Context) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const rel = c.req.path === '/' ? 'index.html' : c.req.path.slice(1);
    const file = resolve(join(root, rel));
    if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
      const { readFile } = await import('node:fs/promises');
      return c.body(await readFile(file), 200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      });
    }
    // history 路由回退（SPA 刷新任意路径都能回到应用）
    const { readFile } = await import('node:fs/promises');
    return c.body(await readFile(join(root, 'index.html')), 200, {
      'Content-Type': MIME['.html'],
    });
  });
}
