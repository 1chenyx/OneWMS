/**
 * 本机密钥库。配置里只有引用名，值写在 integration_secret。
 * 不进 oplog，投影重放不会清掉。列表只给名字。
 */

import type Database from 'better-sqlite3';
import { CONNECTOR_ID_PATTERN, SECRET_REF_PATTERN } from './ids.js';
import { IntegrationStoreError } from './store-error.js';

const SECRET_MAX = 4096;

export class IntegrationSecretStore {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  put(connectorId: string, name: string, value: string): void {
    assertConnector(connectorId);
    assertName(name);
    if (typeof value !== 'string' || value.trim() === '') {
      throw new IntegrationStoreError('INTEGRATION_SECRET', '密钥不能为空');
    }
    if (value.length > SECRET_MAX) {
      throw new IntegrationStoreError('INTEGRATION_SECRET', '密钥过长');
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO integration_secret (workspace_id, connector_id, name, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, connector_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(this.workspaceId, connectorId, name, value, now);
  }

  get(connectorId: string, name: string): string | undefined {
    assertConnector(connectorId);
    assertName(name);
    const row = this.db
      .prepare(
        `SELECT value FROM integration_secret WHERE workspace_id = ? AND connector_id = ? AND name = ?`,
      )
      .get(this.workspaceId, connectorId, name) as { value: string } | undefined;
    return row?.value;
  }

  delete(connectorId: string, name: string): boolean {
    assertConnector(connectorId);
    assertName(name);
    const result = this.db
      .prepare(`DELETE FROM integration_secret WHERE workspace_id = ? AND connector_id = ? AND name = ?`)
      .run(this.workspaceId, connectorId, name);
    return result.changes > 0;
  }

  /** 这个连接器有哪些引用名。不含密钥。 */
  names(connectorId: string): string[] {
    assertConnector(connectorId);
    const rows = this.db
      .prepare(
        `SELECT name FROM integration_secret WHERE workspace_id = ? AND connector_id = ? ORDER BY name`,
      )
      .all(this.workspaceId, connectorId) as { name: string }[];
    return rows.map((row) => row.name);
  }
}

function assertConnector(connectorId: string): void {
  if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
    throw new IntegrationStoreError('INTEGRATION_SECRET', '连接器 id 不合法');
  }
}

function assertName(name: string): void {
  if (!SECRET_REF_PATTERN.test(name)) {
    throw new IntegrationStoreError('INTEGRATION_SECRET', '密钥引用名不合法');
  }
}
