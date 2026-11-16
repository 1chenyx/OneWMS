/** 平台登录令牌。和连接记录分开，不写密码。 */

const TOKEN_KEY = 'onewms.field.platformToken.v1';

export type FieldLink = 'lan' | 'platform';

export interface PlatformMembership {
  workspaceId: string;
  name: string;
  role: string;
}

export interface PlatformLoginResult {
  token: string;
  email: string;
  workspaceId: string | null;
  memberships: PlatformMembership[];
}

let link: FieldLink = 'lan';

export function fieldLink(): FieldLink {
  return link;
}

/** 回到局域网时丢掉平台令牌，避免再带到本机接口。 */
export function noteFieldLink(next: FieldLink): void {
  link = next;
  if (next === 'lan') writeFieldToken(null);
}

export function readFieldToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeFieldToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 写不进时这次登录到不了快照，下一轮会再要登录。
  }
}

/** 平台健康检查是 { ok, db }，没有仓库节点号。 */
export function isPlatformHealth(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as { ok?: unknown; db?: unknown; nodeId?: unknown; workspaceId?: unknown };
  return record.ok === true && record.db === true && typeof record.nodeId !== 'string' && typeof record.workspaceId !== 'string';
}

export function platformNodeId(base: string): string {
  try {
    const url = new URL(base);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.host}${path}`;
  } catch {
    return base;
  }
}

export function platformNodeFromConnection(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return platformNodeId(fallback);
  const record = body as { mode?: unknown; platformBaseUrl?: unknown };
  if (record.mode === 'platform' && typeof record.platformBaseUrl === 'string' && record.platformBaseUrl) {
    return platformNodeId(record.platformBaseUrl);
  }
  return platformNodeId(fallback);
}

export function readPlatformLogin(body: unknown): PlatformLoginResult | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as {
    token?: unknown;
    user?: { email?: unknown };
    workspace?: { id?: unknown } | null;
    memberships?: unknown;
  };
  if (typeof record.token !== 'string' || !record.token) return null;
  const email = record.user && typeof record.user.email === 'string' ? record.user.email : '';
  const workspaceId = record.workspace && typeof record.workspace.id === 'string' ? record.workspace.id : null;
  const memberships: PlatformMembership[] = [];
  if (Array.isArray(record.memberships)) {
    for (const item of record.memberships) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { workspaceId?: unknown; name?: unknown; role?: unknown };
      if (typeof row.workspaceId !== 'string') continue;
      memberships.push({
        workspaceId: row.workspaceId,
        name: typeof row.name === 'string' ? row.name : row.workspaceId,
        role: typeof row.role === 'string' ? row.role : '',
      });
    }
  }
  return { token: record.token, email, workspaceId, memberships };
}

export function readMeWorkspaceId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const workspace = (body as { workspace?: { id?: unknown } | null }).workspace;
  return workspace && typeof workspace.id === 'string' ? workspace.id : null;
}
