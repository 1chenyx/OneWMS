import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { ReportDisabledError } from '../errors.js';
import { reportCatalog, REPORT_TOOL_PAGE_MAX } from '../reports/catalog.js';
import { validatePreview, validateReport } from '../reports/validate.js';
import { def, type WorkspaceResolver } from './tool-def.js';

const SAVE_DESCRIPTION =
  '保存一张自定义明细报表。不传 reportId 是新建并返回新 id；传了是整份替换。' +
  '先调用 wms.report.catalog 看粒度、字段和哪些字段算收窄，不要编造字段 id，也不要写 SQL。' +
  '正文是 title、可选 note、parameters（[{key,label,type}]，type 为 text、number 或 date）、' +
  'sections（[{id,title,grain,columns,filters,sort?}]）。columns 是字段 id 数组。' +
  'filters 的每一项是 {field,op,value}。value 可以是字面量，或 {param:参数key}。' +
  '单据行和流水至少要有一个收窄条件，否则拒绝且不产生事件。一份报表最多 8 张表。' +
  '停用 module.report 后本工具拒绝；已经保存的报表还在。';

function assertEnabled(enabled: boolean): void {
  if (!enabled) throw new ReportDisabledError();
}

function clipRows<T extends { rows: Array<Record<string, string | number | null>> }>(page: T): T {
  return {
    ...page,
    rows: page.rows.map((row) => {
      const next: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(row)) {
        next[key] = typeof value === 'string' && value.length > 120 ? `${value.slice(0, 120)}…` : value;
      }
      return next;
    }),
  };
}

export function createReportTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const catalog: ToolDefinition<Record<string, never>> = {
    id: 'wms.report.catalog',
    label: '查看报表字段',
    description:
      '列出报表能用的粒度、每一行是什么、能选的字段，以及哪些字段上的条件算收窄。配报表之前先调用。不含数据。',
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: () => reportCatalog(),
  };

  const list: ToolDefinition<Record<string, never>> = {
    id: 'wms.report.list',
    label: '列出报表',
    description: '列出已保存的报表：id、标题、说明、参数，以及每张表的粒度和列。不返回数据行。',
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: (_params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return ws.reports.list();
    },
  };

  const save: ToolDefinition<Record<string, unknown>> = {
    id: 'wms.report.save',
    label: '保存报表',
    description: SAVE_DESCRIPTION,
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        reportId: { type: 'string', description: '已有报表的 id。不传则新建。' },
        title: { type: 'string', description: '报表标题' },
        note: { type: 'string', description: '给谁看、看什么（可选）' },
        parameters: { type: 'array', description: '共用参数 [{key,label,type}]', items: { type: 'object' } },
        sections: { type: 'array', description: '明细表，至少一张', items: { type: 'object' } },
      },
      required: ['title', 'sections'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertEnabled(ws.profile.getSnapshot().modules['module.report']?.enabled === true);
      const parsed = validateReport(params);
      const reportId = parsed.reportId ?? randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.reportSaved, {
        reportId,
        title: parsed.definition.title,
        ...(parsed.definition.note ? { note: parsed.definition.note } : {}),
        parameters: parsed.definition.parameters,
        sections: parsed.definition.sections,
      });
      ws.sync();
      return {
        reportId,
        title: parsed.definition.title,
        sectionCount: parsed.definition.sections.length,
      };
    },
  };

  const remove: ToolDefinition<{ reportId: string }> = {
    id: 'wms.report.delete',
    label: '删除报表',
    description: '按 reportId 删除一张报表。用户没有明确说要删，就不要调用。停用 module.report 后拒绝。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: { reportId: { type: 'string', description: '报表 id' } },
      required: ['reportId'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertEnabled(ws.profile.getSnapshot().modules['module.report']?.enabled === true);
      const reportId = typeof params.reportId === 'string' ? params.reportId.trim() : '';
      ws.reports.require(reportId);
      ctx.appendEvent(WMS_EVENT_TYPES.reportDeleted, { reportId });
      ws.sync();
      return { reportId, deleted: true };
    },
  };

  const run: ToolDefinition<{
    reportId: string;
    sectionId: string;
    params?: Record<string, unknown>;
    limit?: number;
    offset?: number;
  }> = {
    id: 'wms.report.run',
    label: '跑报表',
    description:
      '跑一张已保存报表里的一张表。params 填参数值。limit 默认 20、最大 30，用 offset 翻页。' +
      '返回 columns、rows、hasMore。长文本会截断。要改定义用 wms.report.save。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        reportId: { type: 'string', description: '报表 id' },
        sectionId: { type: 'string', description: '表 id' },
        params: { type: 'object', description: '参数值，key 对应报表 parameters' },
        limit: { type: 'number', description: '本页行数，1 到 30，默认 20' },
        offset: { type: 'number', description: '跳过的行数，默认 0' },
      },
      required: ['reportId', 'sectionId'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const page = ws.reports.run(
        params.reportId,
        params.sectionId,
        params.params ?? {},
        params.limit ?? 20,
        params.offset ?? 0,
        REPORT_TOOL_PAGE_MAX,
      );
      return clipRows(page);
    },
  };

  const preview: ToolDefinition<Record<string, unknown>> = {
    id: 'wms.report.preview',
    label: '预览报表',
    description:
      '不保存，先跑一张表的前几行。传 section（与保存时的一张表相同）、可选 parameters，以及 params、limit、offset。' +
      'limit 最大 30。用来核对列和条件对不对，确认后再 wms.report.save。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        section: { type: 'object', description: '一张明细表' },
        parameters: { type: 'array', description: '这张表用到的参数', items: { type: 'object' } },
        params: { type: 'object', description: '参数值' },
        limit: { type: 'number', description: '本页行数，1 到 30，默认 20' },
        offset: { type: 'number', description: '跳过的行数，默认 0' },
      },
      required: ['section'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const parsed = validatePreview(params);
      const supplied = params.params;
      return clipRows(
        ws.reports.preview(
          parsed.section,
          parsed.parameters,
          supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? (supplied as Record<string, unknown>) : {},
          params.limit ?? 20,
          params.offset ?? 0,
          REPORT_TOOL_PAGE_MAX,
        ),
      );
    },
  };

  return [def(catalog), def(list), def(save), def(remove), def(run), def(preview)];
}
