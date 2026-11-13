import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import {
  WMS_EVENT_TYPES,
  type IntegrationCodeBoundPayload,
  type IntegrationCodeUnboundPayload,
} from '../events/catalog.js';
import type { CodeEntity, CodeLookup } from '../integration/types.js';

/**
 * 外部编码对照。按连接器分开。
 * 入站用对方编码找内部编码，出站反过来。缺一条就拒绝整笔报文，不自动建档。
 */

export interface IntegrationCodeRecord {
  readonly id: string;
  readonly connectorId: string;
  readonly entity: CodeEntity;
  readonly externalCode: string;
  readonly internalCode: string;
  readonly updatedAt: string;
}

interface CodeRow {
  id: string;
  connector_id: string;
  entity: CodeEntity;
  external_code: string;
  internal_code: string;
  updated_at: string;
}

function rowToRecord(row: CodeRow): IntegrationCodeRecord {
  return {
    id: row.id,
    connectorId: row.connector_id,
    entity: row.entity,
    externalCode: row.external_code,
    internalCode: row.internal_code,
    updatedAt: row.updated_at,
  };
}

export class IntegrationCodeView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  applyEvent(env: EventEnvelope): void {
    if (env.type === WMS_EVENT_TYPES.integrationCodeBound) {
      const p = env.payload as IntegrationCodeBoundPayload;
      this.db
        .prepare(
          `INSERT INTO wms_integration_code (
             id, workspace_id, connector_id, entity, external_code, internal_code, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, connector_id, entity, external_code) DO UPDATE SET
             internal_code = excluded.internal_code,
             updated_at = excluded.updated_at`,
        )
        .run(p.codeId, this.workspaceId, p.connectorId, p.entity, p.externalCode, p.internalCode, env.createdAt);
      return;
    }
    if (env.type === WMS_EVENT_TYPES.integrationCodeUnbound) {
      const p = env.payload as IntegrationCodeUnboundPayload;
      this.db
        .prepare(
          `DELETE FROM wms_integration_code
           WHERE workspace_id = ? AND connector_id = ? AND entity = ? AND external_code = ?`,
        )
        .run(this.workspaceId, p.connectorId, p.entity, p.externalCode);
    }
  }

  /** 给映射器用。连接器已经定了，查找只带实体和编码。 */
  lookup(connectorId: string): CodeLookup {
    return {
      resolve: (entity, code, direction) => this.resolve(connectorId, entity, code, direction),
    };
  }

  resolve(connectorId: string, entity: CodeEntity, code: string, direction: 'in' | 'out'): string | undefined {
    if (direction === 'in') {
      const row = this.db
        .prepare<unknown[], { internal_code: string }>(
          `SELECT internal_code FROM wms_integration_code
           WHERE workspace_id = ? AND connector_id = ? AND entity = ? AND external_code = ?`,
        )
        .get(this.workspaceId, connectorId, entity, code) as { internal_code: string } | undefined;
      return row?.internal_code;
    }
    const row = this.db
      .prepare<unknown[], { external_code: string }>(
        `SELECT external_code FROM wms_integration_code
         WHERE workspace_id = ? AND connector_id = ? AND entity = ? AND internal_code = ?`,
      )
      .get(this.workspaceId, connectorId, entity, code) as { external_code: string } | undefined;
    return row?.external_code;
  }

  byExternal(connectorId: string, entity: CodeEntity, externalCode: string): IntegrationCodeRecord | undefined {
    const row = this.db
      .prepare<unknown[], CodeRow>(
        `SELECT id, connector_id, entity, external_code, internal_code, updated_at
         FROM wms_integration_code
         WHERE workspace_id = ? AND connector_id = ? AND entity = ? AND external_code = ?`,
      )
      .get(this.workspaceId, connectorId, entity, externalCode) as CodeRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  byInternal(connectorId: string, entity: CodeEntity, internalCode: string): IntegrationCodeRecord | undefined {
    const row = this.db
      .prepare<unknown[], CodeRow>(
        `SELECT id, connector_id, entity, external_code, internal_code, updated_at
         FROM wms_integration_code
         WHERE workspace_id = ? AND connector_id = ? AND entity = ? AND internal_code = ?`,
      )
      .get(this.workspaceId, connectorId, entity, internalCode) as CodeRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(connectorId: string, entity?: CodeEntity): IntegrationCodeRecord[] {
    const rows = (
      entity
        ? this.db
            .prepare<unknown[], CodeRow>(
              `SELECT id, connector_id, entity, external_code, internal_code, updated_at
               FROM wms_integration_code
               WHERE workspace_id = ? AND connector_id = ? AND entity = ?
               ORDER BY entity, external_code`,
            )
            .all(this.workspaceId, connectorId, entity)
        : this.db
            .prepare<unknown[], CodeRow>(
              `SELECT id, connector_id, entity, external_code, internal_code, updated_at
               FROM wms_integration_code
               WHERE workspace_id = ? AND connector_id = ?
               ORDER BY entity, external_code`,
            )
            .all(this.workspaceId, connectorId)
    ) as CodeRow[];
    return rows.map(rowToRecord);
  }
}
