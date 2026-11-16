import { fieldRequest } from './api.js';
import { FieldApiError } from './errors.js';

export interface FieldCommand {
  /** 本机 uuid。这一步只放在请求体旁边的日志位，不送给服务器当幂等键。 */
  clientId: string;
  method: 'POST';
  /** 相对 baseUrl，例如 /api/health。业务路径在后续步骤才放行。 */
  path: string;
  body: unknown;
}

export interface FieldCommandPort {
  submit(command: FieldCommand): Promise<unknown>;
}

/**
 * 手机只打具名路由。收货是修订和转移到 received，上架是 putaway。
 * 不放开工具总线、建单，也不接受查询串。
 */
const ORDER_WRITE = /^\/api\/orders\/[^/]+\/(?:revise|transition|putaway)$/;

export function isFieldWritePath(path: string): boolean {
  return path === '/api/health' || ORDER_WRITE.test(path);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class OnlineCommandPort implements FieldCommandPort {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async submit(command: FieldCommand): Promise<unknown> {
    if (command.method !== 'POST' || !isFieldWritePath(command.path)) {
      throw new FieldApiError('FIELD_PATH_FORBIDDEN', '这一步还不能从手机提交', 0);
    }
    let res: Response;
    try {
      res = await fieldRequest(
        this.baseUrl,
        command.path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-field-client': command.clientId },
          body: JSON.stringify(command.body ?? {}),
        },
        this.fetchImpl,
      );
    } catch (err) {
      if (err instanceof FieldApiError && err.code === 'FIELD_OFFLINE') {
        throw new FieldApiError('FIELD_OFFLINE', '没发出去，看完再试', 0);
      }
      throw err;
    }
    const body = await readBody(res);
    if (!res.ok) {
      const record = body && typeof body === 'object' ? (body as { code?: unknown; message?: unknown }) : {};
      const code = typeof record.code === 'string' ? record.code : 'FIELD_HTTP';
      const message = typeof record.message === 'string' ? record.message : '没发出去，看完再试';
      throw new FieldApiError(code, message, res.status);
    }
    return body;
  }
}
