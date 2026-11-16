import { clientConnectionMode, readPlatformToken } from '../lib/connection';

/** JSON 请求唯一封装；非 2xx 统一抛 ApiError，UI 按 code 分支提示。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 平台模式下带上登录令牌。局域网模式不带，本机接口不认这个头。 */
export function connectionHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  if (clientConnectionMode() === 'platform') {
    const token = readPlatformToken();
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  }
  return headers;
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: connectionHeaders(init?.headers),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(body.code ?? 'UNKNOWN', body.message ?? `请求失败（${res.status}）`, res.status);
  }
  return (await res.json()) as T;
}
