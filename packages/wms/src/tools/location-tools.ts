import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { DEFAULT_LOCATION_ID, WMS_EVENT_TYPES } from '../events/catalog.js';
import { LocationAlreadyExistsError, LocationNotFoundError } from '../errors.js';
import { def, type WorkspaceResolver } from './tool-def.js';

export function createLocationTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const locationCreate: ToolDefinition<{ locationCode: string; name?: string }> = {
    id: 'wms.location.create',
    label: '创建库位',
    description:
      '创建一个新的库位（仓库内的物理存储位）。locationCode 是全库唯一的库位编码（如 A-01），name 是显示名称（可选，缺省同编码）。库存可分库位存放与移库；保留字 DEFAULT 不可用于创建（它是未指定库位时库存的默认归宿，虚拟存在）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        locationCode: { type: 'string', description: '库位唯一编码，如 A-01' },
        name: { type: 'string', description: '库位显示名称（可选，缺省同编码）' },
      },
      required: ['locationCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (typeof params.locationCode !== 'string' || !params.locationCode) {
        throw new Error('TOOL_REJECTED: locationCode 不能为空');
      }
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
      });
      ws.sync();
      return { locationId, locationCode: params.locationCode, name };
    },
  };

  const locationUpdate: ToolDefinition<{ locationCode: string; name?: string }> = {
    id: 'wms.location.update',
    label: '更新库位',
    description:
      '更新库位的显示名称。只传需要修改的字段，未传字段保持不变。locationCode 是业务键不可改（历史单据/流水按它引用）——要换编码请新建库位再移库。虚拟库位 DEFAULT 不可更新（它不落库）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        locationCode: { type: 'string', description: '要更新的库位编码' },
        name: { type: 'string', description: '新的库位显示名称（可选）' },
      },
      required: ['locationCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const location = ws.locations.byCode(params.locationCode);
      if (!location) throw new LocationNotFoundError(params.locationCode);
      const name = params.name === undefined ? undefined : String(params.name).trim();
      if (name === '') throw new Error('TOOL_REJECTED: name 不能为空字符串（不改就别传）');
      ctx.appendEvent(WMS_EVENT_TYPES.locationUpdated, {
        locationId: location.id,
        locationCode: location.locationCode,
        name,
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
      '列出全部已创建的库位（编码 + 名称）。注意：还存在一个虚拟的默认库位 DEFAULT（未指定库位的库存归宿），不出现在本清单，但可在库存调整/移库/单据行中显式引用。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: (_params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return ws.locations
        .list()
        .map((l) => ({ locationCode: l.locationCode, name: l.name, createdAt: l.createdAt }));
    },
  };

  return [def(locationCreate), def(locationUpdate), def(locationList)];
}
