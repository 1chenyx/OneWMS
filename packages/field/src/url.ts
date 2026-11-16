import { FieldApiError } from './errors.js';

/** 浏览器预览连本机 3000 时走 Vite 代理，避免给服务器加 CORS。 */
export function usesDevProxy(baseUrl: string, dev: boolean): boolean {
  if (!dev) return false;
  try {
    const url = new URL(baseUrl);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return local && url.port === '3000';
  } catch {
    return false;
  }
}

export function requestUrl(baseUrl: string, path: string, dev = import.meta.env.DEV): string {
  if (usesDevProxy(baseUrl, dev)) return path;
  return `${baseUrl}${path}`;
}

/**
 * 开发页在 5174 上打开非本机地址时，请求改走同源 /__field，由 Vite 转发。
 * 测试和打包后的页面仍用绝对地址。
 */
export function fieldRequestTarget(
  baseUrl: string,
  path: string,
  dev: boolean,
  pagePort: string,
): { url: string; relay: boolean } {
  if (usesDevProxy(baseUrl, dev)) return { url: path, relay: false };
  if (dev && pagePort === '5174') return { url: `/__field${path}`, relay: true };
  return { url: `${baseUrl}${path}`, relay: false };
}

/** 无尾部斜杠。用户粘了 /api 时剥掉，后面的路径自己带 /api。 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new FieldApiError('FIELD_BAD_URL', '先填写服务器地址', 0);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new FieldApiError('FIELD_BAD_URL', '地址不对', 0);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FieldApiError('FIELD_BAD_URL', '地址不对', 0);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new FieldApiError('FIELD_BAD_URL', '地址不对', 0);
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api')) path = path.slice(0, -4);
  if (path === '/') path = '';
  return `${url.origin}${path}`;
}
