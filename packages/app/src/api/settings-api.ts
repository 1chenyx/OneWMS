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

/** POST /api/migration/import 的结果 */
export interface MigrationImportResult {
  accepted: number;
  skipped: number;
  replayed: boolean;
  missingManifests: { id: string; version: string }[];
}

export const settingsApi = {
  nodeHello: () => request<NodeHello>('/api/sync/hello'),
  syncRun: (peers: string[]) =>
    request<{ results: SyncRoundResult[] }>('/api/sync/run', {
      method: 'POST',
      body: JSON.stringify({ peers }),
    }),
  migrationExport: () => request<Record<string, unknown>>('/api/migration/export'),
  migrationImport: (bundle: unknown) =>
    request<MigrationImportResult>('/api/migration/import', {
      method: 'POST',
      body: JSON.stringify({ bundle }),
    }),
};
