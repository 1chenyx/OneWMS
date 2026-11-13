/**
 * 外部对接的配置形状。纯数据，运行时由校验器收窄。
 * 密钥只留引用名，值在本机密钥库，不进这份 JSON。
 */

export const INTEGRATION_DEFAULTS = {
  pollIntervalSec: 60,
  maxAttempts: 8,
  timeoutMs: 15_000,
} as const;

export type ConnectorDirection = 'inbound' | 'outbound' | 'both';
export type RouteDirection = 'in' | 'out';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';
export type AuthAdapter = 'none' | 'bearer' | 'apiKey' | 'basic' | 'hmac-sha256' | 'oauth2-client';
export type HmacPart = 'method' | 'path' | 'timestamp' | 'body';
export type CodeEntity = 'sku' | 'partner' | 'warehouse';
export type DateForm = 'iso8601' | 'date' | 'unixMs' | 'unixSec' | 'yyyyMMdd' | 'yyyy-MM-dd HH:mm:ss';
export type CursorFrom = 'iso8601' | 'unixMs' | 'watermark';

export type CanonicalKind =
  | 'order.create'
  | 'order.transition'
  | 'sku.create'
  | 'sku.update'
  | 'partner.create'
  | 'partner.update'
  | 'order.snapshot'
  | 'sku.snapshot'
  | 'partner.snapshot'
  | 'inventory.movement';

export type InboundCanonical =
  | 'order.create'
  | 'order.transition'
  | 'sku.create'
  | 'sku.update'
  | 'partner.create'
  | 'partner.update';

export type OutboundCanonical = 'order.snapshot' | 'sku.snapshot' | 'partner.snapshot' | 'inventory.movement';

export type OutboundEvent =
  | 'wms.order.created'
  | 'wms.order.state_changed'
  | 'wms.sku.created'
  | 'wms.sku.updated'
  | 'wms.partner.created'
  | 'wms.partner.updated'
  | 'wms.inventory.adjusted';

export type ValueSource =
  | { op: 'path'; path: string }
  | { op: 'const'; value: string | number | boolean | null }
  | { op: 'number'; path: string }
  | { op: 'enum'; path: string; map: Record<string, string>; fallback: 'reject' }
  | { op: 'date'; path: string; from: DateForm; to: DateForm }
  | { op: 'code'; entity: CodeEntity; path: string }
  | { op: 'template'; template: string };

export interface FieldMap {
  to: string;
  from: ValueSource;
}

export interface LineMap {
  to: string;
  from: string;
  item: FieldMap[];
}

export interface Mapping {
  fields: FieldMap[];
  lines?: LineMap;
}

export interface InboundTrigger {
  mode: 'webhook' | 'poll';
  cursor?: { queryParam: string; from: CursorFrom };
  /** 响应里的列表路径。单笔报文用空串。 */
  itemsPath: string;
}

export interface OutboundTrigger {
  event: OutboundEvent;
  when?: { path: string; eq: string };
  /** true = 只有这个连接器曾经入站过的单据才推回 */
  requireLink: boolean;
}

export interface Route {
  id: string;
  enabled: boolean;
  direction: RouteDirection;
  endpointId?: string;
  inbound?: InboundTrigger;
  outbound?: OutboundTrigger;
  canonical: CanonicalKind;
  idempotency: { externalIdPath: string };
  mapping: Mapping;
}

export interface Endpoint {
  id: string;
  method: HttpMethod;
  path: string;
  shape: 'document';
}

export interface ConnectorAuth {
  adapter: AuthAdapter;
  /** 引用名，不是密钥。键名 integration.{connectorId}.{name} */
  secretRefs?: Record<string, string>;
  placement?: { header: string; prefix?: string };
  hmac?: { header: string; timestampHeader?: string; signedParts: HmacPart[] };
  oauth?: { tokenPath: string };
}

export interface Connector {
  id: string;
  name: string;
  enabled: boolean;
  direction: ConnectorDirection;
  transport: { kind: 'http'; baseUrl: string };
  auth: ConnectorAuth;
  endpoints: Endpoint[];
  routes: Route[];
}

export interface IntegrationWriters {
  order: string | null;
  sku: string | null;
  partner: string | null;
}

export interface IntegrationSettings {
  pollIntervalSec: number;
  maxAttempts: number;
  timeoutMs: number;
  writers: IntegrationWriters;
  connectors: Record<string, Connector>;
}

export interface IntegrationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidateConnectorResult =
  | { ok: true; connector: Connector }
  | { ok: false; issues: IntegrationIssue[] };

export type ValidateSettingsResult =
  | { ok: true; settings: IntegrationSettings }
  | { ok: false; issues: IntegrationIssue[] };

export interface CodeLookup {
  /** in = 对方编码 → 内部编码；out = 内部编码 → 对方编码 */
  resolve(entity: CodeEntity, code: string, direction: 'in' | 'out'): string | undefined;
}

export type MapResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string; path?: string };
