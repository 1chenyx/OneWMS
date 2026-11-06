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

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ApiError(body.code ?? 'UNKNOWN', body.message ?? `请求失败（${res.status}）`, res.status);
  }
  return (await res.json()) as T;
}
