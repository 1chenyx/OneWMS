/**
 * 权限对象与内置角色种子（module.rbac，见 docs/ROADMAP.md §3.4）。
 *
 * 四类权限对象（ROADMAP 定的口径）：
 *  - 页面          `page:{pageId}`
 *  - 工具读 / 写    `tool.read:{toolId}` / `tool.write:{toolId}`
 *  - 慢通道        `config.propose` / `config.confirm`
 *  - 报表导出      `report.export:{reportId}`
 *
 * 角色持有的是一串**授权模式**，模式里可以用 `*`（贪婪通配，可跨段）。
 * `*` 单独一条 = 全部权限。判定只做字符串匹配，不查表：新增页面/工具不需要改这里。
 */

export const PERMISSION_KINDS = [
  'page',
  'tool.read',
  'tool.write',
  'config.propose',
  'config.confirm',
  'report.export',
] as const;

export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/** 授权模式语法上限：太长没意义，也挡住把整篇文章塞进 grant 的输入 */
const MAX_GRANT = 120;
const GRANT_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*(?::[A-Za-z0-9_.:*-]+)?$/;

export function isValidGrant(grant: string): boolean {
  return grant.length <= MAX_GRANT && (grant === '*' || GRANT_PATTERN.test(grant));
}

export function sanitizeGrants(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') return undefined;
    const grant = item.trim();
    if (!isValidGrant(grant)) return undefined;
    seen.add(grant);
  }
  return [...seen];
}

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  const re = new RegExp(`^${body}$`);
  cache.set(pattern, re);
  return re;
}

/** 单条授权模式是否覆盖这个权限对象 */
export function grantMatches(grant: string, permission: string): boolean {
  return grant === permission || grant === '*' || toRegExp(grant).test(permission);
}

/** 角色是否持有某权限（任一模式命中即通过） */
export function hasPermission(grants: readonly string[], permission: string): boolean {
  return grants.some((grant) => grantMatches(grant, permission));
}

export interface RoleSeed {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly grants: readonly string[];
}

/**
 * 内置四个角色。builtin 角色可以改授权（现场总有例外），但不能删——
 * 删了就没有回落面，新建的用户会挂在不存在的角色上。
 */
export const BUILTIN_ROLES: readonly RoleSeed[] = [
  {
    id: 'role.manager',
    name: '仓库经理',
    description: '全部操作，含配置慢通道的提案与确认',
    grants: ['*'],
  },
  {
    id: 'role.keeper',
    name: '仓管员',
    description: '单据与库存全操作，不含配置确认',
    grants: ['page:*', 'tool.read:*', 'tool.write:*', 'config.propose', 'report.export:*'],
  },
  {
    id: 'role.worker',
    name: '库工',
    description: '场景作业与查询，只做收货/上架/拣货/盘点/移库这几类写操作',
    grants: [
      'page:dashboard',
      'page:workbench',
      'page:scenario',
      'tool.read:*',
      'tool.write:wms.picking.*',
      'tool.write:wms.order.putaway',
      'tool.write:wms.inventory.move',
      'tool.write:wms.stocktake.count',
      'tool.write:wms.stocktake.create',
    ],
  },
  {
    id: 'role.auditor',
    name: '审计',
    description: '只读，含操作日志查询与报表导出',
    grants: ['page:*', 'tool.read:*', 'report.export:*'],
  },
];

export const BUILTIN_ROLE_IDS = new Set(BUILTIN_ROLES.map((role) => role.id));
