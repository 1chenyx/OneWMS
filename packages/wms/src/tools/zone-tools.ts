import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { ZoneAlreadyExistsError, ZoneKindError, ZoneNotFoundError, WarehouseNotFoundError } from '../errors.js';
import { allocateCode } from '../numbering/allocate.js';
import { assertWarehouseEnabled } from '../queries/warehouse-queries.js';
import { assertZoneEnabled, assertZoneWarehouseMovable, listZones } from '../queries/zone-queries.js';
import { isZoneKind, zoneKindHint, type ZoneKind } from '../zone-kinds.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 没传 warehouseCode → undefined。
 * 多仓关闭时只要键在就拒绝。
 * 开启时：创建的空字符串当没传；更新的空字符串是划出仓库。
 */
function resolveZoneWarehouseId(
  ws: ReturnType<WorkspaceResolver>,
  params: { warehouseCode?: string },
  mode: 'create' | 'update',
): string | null | undefined {
  if (!Object.hasOwn(params, 'warehouseCode')) return undefined;
  assertWarehouseEnabled(ws);
  const code = typeof params.warehouseCode === 'string' ? params.warehouseCode.trim() : '';
  if (!code) return mode === 'create' ? undefined : null;
  const warehouse = ws.warehouses.byCode(code);
  if (!warehouse) throw new WarehouseNotFoundError(code);
  return warehouse.id;
}

function readKind(raw: unknown, required: boolean): ZoneKind | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ZoneKindError('');
    return undefined;
  }
  const kind = String(raw).trim();
  if (!isZoneKind(kind)) throw new ZoneKindError(kind);
  return kind;
}

/**
 * 库区档案（module.zone）。
 * 不改库存主键：货仍在库位上。分类只说明这块地方是拿来拣货、存货还是收发。
 * 工具不进 core.wms 的 tools 数组。
 */
export function createZoneTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const hint = zoneKindHint();

  const zoneCreate: ToolDefinition<{
    zoneCode?: string;
    name?: string;
    kind?: string;
    warehouseCode?: string;
  }> = {
    id: 'wms.zone.create',
    label: '创建库区',
    description:
      `创建一个库区。zoneCode 全库唯一，不传或空着则按编号规则（zone）生成，传了就用传入的。name 缺省同编码。kind 是分类，必填：${hint}。库区不是库存桶，库存仍在库位上；之后用 wms.location.create / wms.location.update 的 zoneCode 把库位划进来。可选 warehouseCode 把库区划进已有仓库（module.warehouse）；不传则未分仓。停用库区后本工具拒绝。停用多仓后只要带了 warehouseCode 就拒绝。`,
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        zoneCode: { type: 'string', description: '库区编码（可选。不传或空着按编号规则生成，如 ZN-01）' },
        name: { type: 'string', description: '库区名称（可选，缺省同编码）' },
        kind: {
          type: 'string',
          enum: ['receiving', 'qc', 'storage', 'picking', 'staging', 'shipping', 'return', 'defective'],
          description: `库区分类。${hint}`,
        },
        warehouseCode: { type: 'string', description: '所属仓库编码（可选；module.warehouse 启用时有效，不传则未分仓）' },
      },
      required: ['kind'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertZoneEnabled(ws);
      const kind = readKind(params.kind, true)!;
      const warehouseId = resolveZoneWarehouseId(ws, params, 'create');
      const zoneCode = allocateCode(ws, 'zone', params.zoneCode);
      if (ws.zones.byCode(zoneCode)) throw new ZoneAlreadyExistsError(zoneCode);
      const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : zoneCode;
      const zoneId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.zoneCreated, {
        zoneId,
        zoneCode,
        name,
        kind,
        ...(warehouseId ? { warehouseId } : {}),
      });
      ws.sync();
      return { zoneId, zoneCode, name, kind };
    },
  };

  const zoneUpdate: ToolDefinition<{
    zoneCode: string;
    name?: string;
    kind?: string;
    warehouseCode?: string;
  }> = {
    id: 'wms.zone.update',
    label: '更新库区',
    description:
      `更新库区的名称、分类或所属仓库。zoneCode 是业务键不可改。kind 可选，词表：${hint}。warehouseCode 传空字符串表示划出仓库；库区里还有库位时不能改仓库。停用 module.zone 后本工具拒绝。停用多仓后只要带了 warehouseCode 就拒绝。已经划进该库区的库位，改名和改分类不影响它们。`,
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        zoneCode: { type: 'string', description: '库区编码' },
        name: { type: 'string', description: '新的库区名称' },
        kind: {
          type: 'string',
          enum: ['receiving', 'qc', 'storage', 'picking', 'staging', 'shipping', 'return', 'defective'],
          description: `新的分类。${hint}`,
        },
        warehouseCode: {
          type: 'string',
          description: '所属仓库编码（可选）。空字符串表示划出仓库。不传则不改归属。库区里还有库位时不能改。停用 module.warehouse 后拒绝。',
        },
      },
      required: ['zoneCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertZoneEnabled(ws);
      const zoneCode = typeof params.zoneCode === 'string' ? params.zoneCode.trim() : '';
      const zone = zoneCode ? ws.zones.byCode(zoneCode) : undefined;
      if (!zone) throw new ZoneNotFoundError(zoneCode || '(空)');
      const name = params.name === undefined ? undefined : String(params.name).trim();
      if (name === '') throw new Error('TOOL_REJECTED: name 不能为空字符串（不改就别传）');
      const kind = readKind(params.kind, false);
      const warehouseId = resolveZoneWarehouseId(ws, params, 'update');
      if (warehouseId !== undefined) {
        assertZoneWarehouseMovable(ws, zone.id, zone.zoneCode, warehouseId, zone.warehouseId);
      }
      if (name !== undefined || kind !== undefined || warehouseId !== undefined) {
        ctx.appendEvent(WMS_EVENT_TYPES.zoneUpdated, {
          zoneId: zone.id,
          zoneCode: zone.zoneCode,
          ...(name !== undefined ? { name } : {}),
          ...(kind !== undefined ? { kind } : {}),
          ...(warehouseId !== undefined ? { warehouseId } : {}),
        });
        ws.sync();
      }
      return {
        zoneId: zone.id,
        zoneCode: zone.zoneCode,
        name: name ?? zone.name,
        kind: kind ?? zone.kind,
      };
    },
  };

  const zoneList: ToolDefinition<Record<string, never>> = {
    id: 'wms.zone.list',
    label: '库区清单',
    description:
      `列出库区（编码、名称、分类、所属仓库、划进来的库位个数）。分类：${hint}。未分区的库位不计入任何库区。停用 module.zone 后本工具拒绝。纯读，不产生事件。`,
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: (_params, ctx) => listZones(resolveWorkspace(ctx.workspaceId)),
  };

  return [def(zoneCreate), def(zoneUpdate), def(zoneList)];
}
