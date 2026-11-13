import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { IntegrationCodeError } from '../errors.js';
import { CONNECTOR_ID_PATTERN } from '../integration/ids.js';
import type { CodeEntity } from '../integration/types.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 外部编码对照。按连接器记，走账本，别的节点重放后用同一张表。
 * 不进连接器 JSON。缺对照时映射拒绝整笔报文，这里也不创建货品或往来。
 */

const ENTITIES = ['sku', 'partner', 'warehouse'] as const;
const CODE_MAX = 256;

const ENTITY_PARAM = {
  type: 'string' as const,
  enum: [...ENTITIES],
  description: '实体：sku 货品，partner 往来，warehouse 仓库',
};

export function createIntegrationCodeTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const bind: ToolDefinition<{
    connectorId: string;
    entity: string;
    externalCode: string;
    internalCode: string;
  }> = {
    id: 'integration.code.bind',
    label: '绑定编码',
    description:
      '把某个连接器上的对方编码对上我们的编码。connectorId 是连接器 id。entity 是 sku、partner 或 warehouse。externalCode 是对方编码，internalCode 是我们的编码。同一实体下两边都只能出现一次。已经是这一对时不再写事件。把对方编码改对到新的内部编码可以，新的内部编码已被占用就会拒绝。不创建货品、往来或仓库。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: '连接器 id' },
        entity: ENTITY_PARAM,
        externalCode: { type: 'string', description: '对方编码' },
        internalCode: { type: 'string', description: '我们的编码，如 SKU-00001、CUS-0008' },
      },
      required: ['connectorId', 'entity', 'externalCode', 'internalCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const connectorId = readConnector(params.connectorId);
      const entity = readEntity(params.entity);
      const externalCode = readCode(params.externalCode, '对方编码');
      const internalCode = readCode(params.internalCode, '内部编码');
      const current = ws.codes.byExternal(connectorId, entity, externalCode);
      if (current?.internalCode === internalCode) {
        return { connectorId, entity, externalCode, internalCode };
      }
      const taken = ws.codes.byInternal(connectorId, entity, internalCode);
      if (taken && taken.externalCode !== externalCode) {
        throw new IntegrationCodeError(`内部编码 ${internalCode} 已经对上对方编码 ${taken.externalCode}`);
      }
      ctx.appendEvent(WMS_EVENT_TYPES.integrationCodeBound, {
        codeId: current?.id ?? randomUUID(),
        connectorId,
        entity,
        externalCode,
        internalCode,
      });
      ws.sync();
      return { connectorId, entity, externalCode, internalCode };
    },
  };

  const unbind: ToolDefinition<{ connectorId: string; entity: string; externalCode: string }> = {
    id: 'integration.code.unbind',
    label: '解除编码',
    description:
      '按连接器、实体和对方编码解除一条对照。没有这条对照会拒绝。解除后，报文里的这个对方编码会被整笔拒绝，不会自动建档。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: '连接器 id' },
        entity: ENTITY_PARAM,
        externalCode: { type: 'string', description: '要解除的对方编码' },
      },
      required: ['connectorId', 'entity', 'externalCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const connectorId = readConnector(params.connectorId);
      const entity = readEntity(params.entity);
      const externalCode = readCode(params.externalCode, '对方编码');
      const current = ws.codes.byExternal(connectorId, entity, externalCode);
      if (!current) throw new IntegrationCodeError(`没有 ${entity} 的对方编码 ${externalCode}`);
      ctx.appendEvent(WMS_EVENT_TYPES.integrationCodeUnbound, {
        codeId: current.id,
        connectorId,
        entity,
        externalCode,
        internalCode: current.internalCode,
      });
      ws.sync();
      return { connectorId, entity, externalCode, internalCode: current.internalCode };
    },
  };

  const list: ToolDefinition<{ connectorId: string; entity?: string }> = {
    id: 'integration.code.list',
    label: '编码清单',
    description:
      '列出某个连接器的编码对照。可传 entity（sku、partner、warehouse）只看一类。返回对方编码和内部编码。纯读，不产生事件。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: '连接器 id' },
        entity: ENTITY_PARAM,
      },
      required: ['connectorId'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const connectorId = readConnector(params.connectorId);
      const entity = params.entity === undefined || params.entity === '' ? undefined : readEntity(params.entity);
      const rows = ws.codes.list(connectorId, entity).map((row) => ({
        entity: row.entity,
        externalCode: row.externalCode,
        internalCode: row.internalCode,
      }));
      return { rows };
    },
  };

  return [def(bind), def(unbind), def(list)];
}

function readConnector(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!CONNECTOR_ID_PATTERN.test(text)) throw new IntegrationCodeError('连接器 id不合法');
  return text;
}

function readEntity(value: unknown): CodeEntity {
  if (value === 'sku' || value === 'partner' || value === 'warehouse') return value;
  throw new IntegrationCodeError('实体只能是货品、往来或仓库');
}

function readCode(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > CODE_MAX || /[\s\u0000-\u001f]/.test(text)) {
    throw new IntegrationCodeError(`${label}不合法`);
  }
  return text;
}
