import type Database from 'better-sqlite3';
import type { EventEnvelope } from '@one/core';
import { WMS_EVENT_TYPES, type ReportDeletedPayload, type ReportSavedPayload } from '../events/catalog.js';
import { ReportNotFoundError } from '../errors.js';
import { clampReportPage, runReportSection, runSavedSection, type ReportRunPage } from '../reports/run.js';
import type { ReportDefinition, ReportParameter, ReportSection } from '../reports/types.js';

/**
 * 报表定义投影。真相在 wms.report.saved / deleted。
 * 重放时按事件顺序整份覆盖，删除对已经不在的行是空操作。
 */

export interface StoredReport {
  reportId: string;
  title: string;
  note: string | null;
  parameters: ReportDefinition['parameters'];
  sections: ReportDefinition['sections'];
  updatedAt: string;
}

interface ReportRow {
  id: string;
  title: string;
  note: string | null;
  definition: string;
  updated_at: string;
}

function toStored(row: ReportRow): StoredReport {
  const definition = JSON.parse(row.definition) as ReportDefinition;
  return {
    reportId: row.id,
    title: row.title,
    note: row.note,
    parameters: definition.parameters,
    sections: definition.sections,
    updatedAt: row.updated_at,
  };
}

export class ReportView {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  applyEvent(env: EventEnvelope): void {
    switch (env.type) {
      case WMS_EVENT_TYPES.reportSaved: {
        const payload = env.payload as ReportSavedPayload;
        const definition: ReportDefinition = {
          title: payload.title,
          ...(payload.note ? { note: payload.note } : {}),
          parameters: [...payload.parameters],
          sections: [...payload.sections],
        };
        this.db
          .prepare(
            `INSERT INTO wms_report (id, workspace_id, title, note, definition, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               title = excluded.title,
               note = excluded.note,
               definition = excluded.definition,
               updated_at = excluded.updated_at`,
          )
          .run(
            payload.reportId,
            this.workspaceId,
            payload.title,
            payload.note ?? null,
            JSON.stringify(definition),
            env.createdAt,
          );
        break;
      }
      case WMS_EVENT_TYPES.reportDeleted: {
        const payload = env.payload as ReportDeletedPayload;
        this.db
          .prepare(`DELETE FROM wms_report WHERE workspace_id = ? AND id = ?`)
          .run(this.workspaceId, payload.reportId);
        break;
      }
      default:
        break;
    }
  }

  list(): StoredReport[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, note, definition, updated_at
         FROM wms_report WHERE workspace_id = ? ORDER BY updated_at DESC, title`,
      )
      .all(this.workspaceId) as ReportRow[];
    return rows.map(toStored);
  }

  get(reportId: string): StoredReport | null {
    const row = this.db
      .prepare(
        `SELECT id, title, note, definition, updated_at
         FROM wms_report WHERE workspace_id = ? AND id = ?`,
      )
      .get(this.workspaceId, reportId) as ReportRow | undefined;
    return row ? toStored(row) : null;
  }

  require(reportId: string): StoredReport {
    const found = this.get(reportId);
    if (!found) throw new ReportNotFoundError(reportId);
    return found;
  }

  run(
    reportId: string,
    sectionId: string,
    supplied: Record<string, unknown>,
    limit: unknown,
    offset: unknown,
    max: number,
  ): ReportRunPage {
    const report = this.require(reportId);
    const page = clampReportPage(limit, offset, max);
    return runSavedSection(
      this.db,
      this.workspaceId,
      {
        title: report.title,
        ...(report.note ? { note: report.note } : {}),
        parameters: report.parameters,
        sections: report.sections,
      },
      sectionId,
      supplied,
      page,
    );
  }

  preview(
    section: ReportSection,
    parameters: ReportParameter[],
    supplied: Record<string, unknown>,
    limit: unknown,
    offset: unknown,
    max: number,
  ): ReportRunPage {
    const page = clampReportPage(limit, offset, max);
    return runReportSection(this.db, this.workspaceId, section, parameters, supplied, page);
  }
}
