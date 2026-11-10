import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { WarehouseAlreadyExistsError, WarehouseNotFoundError } from '../errors.js';
import { allocateCode } from '../numbering/allocate.js';
import { assertWarehouseEnabled, listWarehouseStock, listWarehouses } from '../queries/warehouse-queries.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 仓库档案（module.warehouse）。
 * 不改库存主键：货仍在库位上。把库位划进仓库只是给库位记一个上级。
 * 工具不进 core.wms 的 tools 数组。
 */
export function createWarehouseTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const warehouseCreate: ToolDefinition<{ warehouseCode?: string; name?: string }> = {
    id: 'wms.warehouse.create',
    label: '创建仓库',
    description:
      '创建一个仓库。warehouseCode 全库唯一，不传或空着则按编号规则（warehouse）生成，传了就用传入的。name 缺省同编码。仓库不是库存桶，库存仍在库位上；之后用 wms.location.create / wms.location.update 的 warehouseCode 把库位划进来。停用 module.warehouse 后本工具拒绝。虚拟库位 DEFAULT 不能划进仓库。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        warehouseCode: { type: 'string', description: '仓库编码（可选。不传或空着按编号规则生成，如 WH-01）' },
        name: { type: 'string', description: '仓库名称（可选，缺省同编码）' },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertWarehouseEnabled(ws);
      const warehouseCode = allocateCode(ws, 'warehouse', params.warehouseCode);
      if (ws.warehouses.byCode(warehouseCode)) throw new WarehouseAlreadyExistsError(warehouseCode);
      const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : warehouseCode;
      const warehouseId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.warehouseCreated, { warehouseId, warehouseCode, name });
      ws.sync();
      return { warehouseId, warehouseCode, name };
    },
  };

  const warehouseUpdate: ToolDefinition<{ warehouseCode: string; name?: string }> = {
    id: 'wms.warehouse.update',
    label: '更新仓库',
    description:
      '更新仓库的显示名称。warehouseCode 是业务键不可改。停用 module.warehouse 后本工具拒绝。已经划进该仓库的库位不受更名影响。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        warehouseCode: { type: 'string', description: '仓库编码' },
        name: { type: 'string', description: '新的仓库名称' },
      },
      required: ['warehouseCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      assertWarehouseEnabled(ws);
      const warehouseCode = typeof params.warehouseCode === 'string' ? params.warehouseCode.trim() : '';
      const warehouse = warehouseCode ? ws.warehouses.byCode(warehouseCode) : undefined;
      if (!warehouse) throw new WarehouseNotFoundError(warehouseCode || '(空)');
      const name = params.name === undefined ? undefined : String(params.name).trim();
      if (name === '') throw new Error('TOOL_REJECTED: name 不能为空字符串（不改就别传）');
      if (name !== undefined) {
        ctx.appendEvent(WMS_EVENT_TYPES.warehouseUpdated, {
          warehouseId: warehouse.id,
          warehouseCode: warehouse.warehouseCode,
          name,
        });
        ws.sync();
      }
      return {
        warehouseId: warehouse.id,
        warehouseCode: warehouse.warehouseCode,
        name: name ?? warehouse.name,
      };
    },
  };

  const warehouseList: ToolDefinition<Record<string, never>> = {
    id: 'wms.warehouse.list',
    label: '仓库清单',
    description:
      '列出仓库（编码、名称、划进来的库位个数）。未分仓的库位和虚拟库位 DEFAULT 不计入任何仓库。停用 module.warehouse 后本工具拒绝。纯读，不产生事件。',
    permission: 'read',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: (_params, ctx) => listWarehouses(resolveWorkspace(ctx.workspaceId)),
  };

  const warehouseStock: ToolDefinition<{ warehouseCode: string }> = {
    id: 'wms.warehouse.stock',
    label: '仓库库存',
    description:
      '列出某个仓库里的库存：只含划进该仓库的库位，按 SKU、库位、批次给出余量。未分仓的库位和 DEFAULT 不在结果里。零余量不列出。仓库不存在会报错。停用 module.warehouse 后本工具拒绝。纯读，不产生事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        warehouseCode: { type: 'string', description: '仓库编码' },
      },
      required: ['warehouseCode'],
    },
    handler: (params, ctx) => {
      const code = typeof params.warehouseCode === 'string' ? params.warehouseCode.trim() : '';
      return listWarehouseStock(resolveWorkspace(ctx.workspaceId), code);
    },
  };

  return [def(warehouseCreate), def(warehouseUpdate), def(warehouseList), def(warehouseStock)];
}
