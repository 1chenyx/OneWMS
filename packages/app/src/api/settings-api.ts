import { request } from './request';

/** GET /api/sync/hello——节点名片 */
export interface NodeHello {
  nodeId: string;
  workspaceId: string;
  profileVersion: number;
  watermarks: Record<string, { seq: number }>;
  eventCount: number;
}

/** POST /api/sync/run 的单节点回合结果 */
export interface SyncRoundResult {
  peer: string;
  status: string;
  pulled: number;
  accepted: number;
  skipped: number;
  replayed: boolean;
  message?: string;
}

/** 已配对同步节点（服务端 data/peers.json 持久化） */
export interface SyncPeerRecord {
  url: string;
  /** 首次握手拿到的对端节点 ID（握手失败过则无） */
  nodeId?: string;
  /** 配对时刻（ISO） */
  addedAt: string;
}

/** GET /api/sync/peers */
export interface SyncPeersResult {
  /** false = 宿主无落盘位（内存库），配对只在本次运行内有效 */
  persisted: boolean;
  path: string | null;
  peers: SyncPeerRecord[];
}

/** POST /api/sync/peers 的结果（握手 + 落盘 + 立刻同步一轮） */
export interface AddSyncPeerResult {
  peer: SyncPeerRecord | undefined;
  round: SyncRoundResult;
  peers: SyncPeerRecord[];
}

/** DELETE /api/sync/peers 的结果 */
export interface RemoveSyncPeerResult {
  removed: boolean;
  peers: SyncPeerRecord[];
}

/** GET /api/sync/lan-address——「对端能访问的我」，供扫码/誊录 */
export interface LanAddressResult {
  nodeId: string;
  workspaceId: string;
  /** 首个非内环 IPv4；机器没有局域网（如只连了 VPN）→ null */
  ip: string | null;
  port: number | null;
  url: string | null;
}

/** POST /api/migration/import 的结果 */
export interface MigrationImportResult {
  accepted: number;
  skipped: number;
  replayed: boolean;
  missingManifests: { id: string; version: string }[];
}

/** 备份清单项（时间/事件数/大小取自文件名与文件体积——列表不解析大文件） */
export interface BackupEntry {
  name: string;
  /** ISO 时刻（秒精度） */
  createdAt: string;
  eventCount: number;
  sizeBytes: number;
}

/** GET /api/backups */
export interface BackupListResult {
  /** false = 宿主没有可写数据目录（如内存库），备份整体关闭 */
  enabled: boolean;
  /** 自动备份间隔（毫秒；0 = 只手动） */
  intervalMs: number;
  /** 滚动保留份数 */
  keep: number;
  /** 最近一次备份时刻；从未备份 → null */
  lastBackupAt: string | null;
  /** 新到旧 */
  backups: BackupEntry[];
  /** 禁用原因（enabled=false 时页面照原样显示） */
  reason?: string;
}

export interface BackupCreateResult extends BackupListResult {
  name: string;
}

/** POST /api/backups/:name/restore 的结果 */
export interface RestoreBackupResult {
  accepted: number;
  skipped: number;
  replayed: boolean;
  /** 备份里带 AI 配置且已恢复（没有则保持现状不动） */
  aiConfigRestored: boolean;
}

export const settingsApi = {
  nodeHello: () => request<NodeHello>('/api/sync/hello'),
  /** 跑一轮拉取：peers 由服务端合并（已配对清单 ∪ 环境变量），页面不必重复填地址 */
  syncRun: () =>
    request<{ results: SyncRoundResult[] }>('/api/sync/run', { method: 'POST', body: '{}' }),
  syncPeersList: () => request<SyncPeersResult>('/api/sync/peers'),
  /** 添加节点：服务端先握手验明工作区一致，再落盘并立刻同步一轮 */
  syncPeerAdd: (url: string) =>
    request<AddSyncPeerResult>('/api/sync/peers', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  syncPeerRemove: (url: string) =>
    request<RemoveSyncPeerResult>(`/api/sync/peers?url=${encodeURIComponent(url)}`, {
      method: 'DELETE',
    }),
  lanAddress: () => request<LanAddressResult>('/api/sync/lan-address'),
  migrationExport: () => request<Record<string, unknown>>('/api/migration/export'),
  migrationImport: (bundle: unknown) =>
    request<MigrationImportResult>('/api/migration/import', {
      method: 'POST',
      body: JSON.stringify({ bundle }),
    }),
  backupList: () => request<BackupListResult>('/api/backups'),
  /** 立即备份一份（与定时轮同一动作，含滚动清理） */
  backupCreate: () => request<BackupCreateResult>('/api/backups', { method: 'POST' }),
  /** 恢复：幂等（eventId 查重）——点错了再点一次不会搞坏数据 */
  backupRestore: (name: string) =>
    request<RestoreBackupResult>(`/api/backups/${encodeURIComponent(name)}/restore`, {
      method: 'POST',
    }),
  backupRemove: (name: string) =>
    request<BackupListResult>(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};
