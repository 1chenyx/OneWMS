import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { DEFAULT_LOCATION_ID, WMS_EVENT_TYPES } from '../events/catalog.js';
import { LocationAlreadyExistsError, LocationNotFoundError, WarehouseNotFoundError } from '../errors.js';
import { assertWarehouseEnabled } from '../queries/warehouse-queries.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 解析本次要写入的仓库。
 * 没传 warehouseCode → undefined（创建即未分仓，更新则不动归属）。
 * 模块关闭时只要键在（含空字符串）就拒绝，不落事件。
 * 模块开启时：创建的空字符串当没传；更新的空字符串是划出仓库（显式 null）。
 */
function resolveWarehouseId(
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

/** 容量：正数才写入。创建时空着表示不限；更新时 null 表示清空。 */
function readCapacity(raw: unknown, present: boolean, mode: 'create' | 'update'): number | null | undefined {
  if (!present) return undefined;
  if (raw === null || raw === '') return mode === 'create' ? undefined : null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error('TOOL_REJECTED: 容量必须是正数。不填表示不限。');
  }
  return raw;
}

export function createLocationTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const locationCreate: ToolDefinition<{
    locationCode: string;
    name?: string;
    warehouseCode?: string;
    capacity?: number | null;
  }> = {
    id: 'wms.location.create',
    label: '创建库位',
    description:
      '创建一个新的库位（仓库内的物理存储位）。locationCode 是全库唯一的库位编码（如 A-01），name 是显示名称（可选，缺省同编码）。库存可分库位存放与移库；保留字 DEFAULT 不可用于创建（它是未指定库位时库存的默认归宿，虚拟存在）。可选 warehouseCode 把库位划进已有仓库（module.warehouse）；不传或空字符串则未分仓。停用多仓后只要带了 warehouseCode 就拒绝。容量是库位最多放多少。不填表示不限。上架是否拦截由 putawayCapacity 决定。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        locationCode: { type: 'string', description: '库位唯一编码，如 A-01' },
        name: { type: 'string', description: '库位显示名称（可选，缺省同编码）' },
        warehouseCode: { type: 'string', description: '所属仓库编码（可选；module.warehouse 启用时有效，不传则未分仓）' },
        capacity: { type: 'number', description: '容量（可选，正数）。不填表示不限。上架是否拦截由 putawayCapacity 决定' },
      },
      required: ['locationCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (typeof params.locationCode !== 'string' || !params.locationCode) {
        throw new Error('TOOL_REJECTED: locationCode 不能为空');
      }
      const capacity = readCapacity(params.capacity, Object.hasOwn(params, 'capacity'), 'create');
      const warehouseId = resolveWarehouseId(ws, params, 'create');
      if (params.locationCode === DEFAULT_LOCATION_ID) {
        throw new Error('TOOL_REJECTED: DEFAULT 是保留字（默认库位，虚拟存在），不可创建同名库位');
      }
      if (ws.locations.byCode(params.locationCode)) {
        throw new LocationAlreadyExistsError(params.locationCode);
      }
      const locationId = randomUUID();
      const name = params.name ?? params.locationCode;
      ctx.appendEvent(WMS_EVENT_TYPES.locationCreated, {
        locationId,
        locationCode: params.locationCode,
        name,
        ...(warehouseId ? { warehouseId } : {}),
        ...(typeof capacity === 'number' ? { capacity } : {}),
      });
      ws.sync();
      return {
        locationId,
        locationCode: params.locationCode,
        name,
        ...(typeof capacity === 'number' ? { capacity } : {}),
      };
    },
  };

  const locationUpdate: ToolDefinition<{
    locationCode: string;
    name?: string;
    warehouseCode?: string;
    capacity?: number | null;
  }> = {
    id: 'wms.location.update',
    label: '更新库位',
    description:
      '更新库位的显示名称，也可在 module.warehouse 启用时改所属仓库。只传需要修改的字段，未传字段保持不变。warehouseCode 传空字符串表示划出仓库。locationCode 是业务键不可改（历史单据/流水按它引用）——要换编码请新建库位再移库。虚拟库位 DEFAULT 不可更新（它不落库，也不能划进仓库）。停用多仓后只要带了 warehouseCode 就拒绝；只改名称不受影响。容量是库位最多放多少。不填表示不限。传 null 清空容量。上架是否拦截由 putawayCapacity 决定。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        locationCode: { type: 'string', description: '要更新的库位编码' },
        name: { type: 'string', description: '新的库位显示名称（可选）' },
        warehouseCode: {
          type: 'string',
          description: '所属仓库编码（可选）。空字符串表示划出仓库。不传则不改归属。停用 module.warehouse 后拒绝。',
        },
        capacity: {
          type: 'number',
          nullable: true,
          description: '容量（可选，正数）。null 表示清空，不传则不改。不填表示不限。上架是否拦截由 putawayCapacity 决定',
        },
      },
      required: ['locationCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const capacity = readCapacity(params.capacity, Object.hasOwn(params, 'capacity'), 'update');
      const warehouseId = resolveWarehouseId(ws, params, 'update');
      const location = ws.locations.byCode(params.locationCode);
      if (!location) throw new LocationNotFoundError(params.locationCode);
      const name = params.name === undefined ? undefined : String(params.name).trim();
      if (name === '') throw new Error('TOOL_REJECTED: name 不能为空字符串（不改就别传）');
      ctx.appendEvent(WMS_EVENT_TYPES.locationUpdated, {
        locationId: location.id,
        locationCode: location.locationCode,
        name,
        ...(warehouseId !== undefined ? { warehouseId } : {}),
        ...(capacity !== undefined ? { capacity } : {}),
      });
      ws.sync();
      return {
        locationId: location.id,
        locationCode: location.locationCode,
        name: name ?? location.name,
      };
    },
  };

  const locationList: ToolDefinition<Record<string, never>> = {
    id: 'wms.location.list',
    label: '库位清单',
    description:
      '列出全部已创建的库位（编码 + 名称）。填了容量的库位会带上 capacity。注意：还存在一个虚拟的默认库位 DEFAULT（未指定库位的库存归宿），不出现在本清单，但可在库存调整/移库/单据行中显式引用。容量是库位最多放多少。不填表示不限。上架是否拦截由 putawayCapacity 决定。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: (_params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return ws.locations.list().map((l) => {
        const row: {
          locationCode: string;
          name: string;
          createdAt: string;
          warehouseCode?: string;
          capacity?: number;
        } = {
          locationCode: l.locationCode,
          name: l.name,
          createdAt: l.createdAt,
        };
        if (typeof l.capacity === 'number') row.capacity = l.capacity;
        if (l.warehouseId) {
          const warehouse = ws.warehouses.byId(l.warehouseId);
          if (warehouse) row.warehouseCode = warehouse.warehouseCode;
        }
        return row;
      });
    },
  };

  return [def(locationCreate), def(locationUpdate), def(locationList)];
}
