import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@one/core';
import { WMS_EVENT_TYPES } from '../events/catalog.js';
import { PartnerAlreadyExistsError, PartnerNotFoundError } from '../errors.js';
import { def, type WorkspaceResolver } from './tool-def.js';

/**
 * 往来单位工具（M21）——供应商/客户统一实体。
 * 护栏三步与 sku-tools 同款：sync → 校验（拒绝零事件）→ appendEvent → sync。
 * kind（supplier/customer）只在 create 声明且不可改——改身份 = 新建。
 */
export function createPartnerTools(resolveWorkspace: WorkspaceResolver): ToolDefinition[] {
  const partnerCreate: ToolDefinition<{
    partnerCode: string;
    kind: 'supplier' | 'customer';
    name: string;
    contact?: string;
    phone?: string;
    address?: string;
    note?: string;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.partner.create',
    label: '创建往来单位',
    description:
      '创建一个往来单位（供应商或客户）。kind 取 supplier（供应商，用于入库单）/ customer（客户，用于出库单），创建后不可更改——身份变化请新建编码。partnerCode 全库唯一（如 SUP-001 / CUS-001）；name 名称必填；可选 contact 联系人、phone 电话、address 地址、note 备注、extData 扩展字段。入库单/出库单可关联对应 kind 的往来单位（order.create 的 partnerCode 参数）。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        partnerCode: { type: 'string', description: '往来单位唯一编码，如 SUP-001' },
        kind: {
          type: 'string',
          enum: ['supplier', 'customer'],
          description: '种类：supplier=供应商（入库单往来单位）/ customer=客户（出库单往来单位）',
        },
        name: { type: 'string', description: '往来单位名称' },
        contact: { type: 'string', description: '联系人（可选）' },
        phone: { type: 'string', description: '联系电话（可选）' },
        address: { type: 'string', description: '地址（可选）' },
        note: { type: 'string', description: '备注（可选）' },
        extData: { type: 'object', description: '扩展字段键值对（可选）' },
      },
      required: ['partnerCode', 'kind', 'name'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (ws.partners.byCode(params.partnerCode)) {
        throw new PartnerAlreadyExistsError(params.partnerCode);
      }
      const partnerId = randomUUID();
      ctx.appendEvent(WMS_EVENT_TYPES.partnerCreated, {
        partnerId,
        partnerCode: params.partnerCode,
        kind: params.kind,
        name: params.name,
        contact: params.contact,
        phone: params.phone,
        address: params.address,
        note: params.note,
        extData: params.extData,
      });
      ws.sync();
      return { partnerId, partnerCode: params.partnerCode, kind: params.kind, name: params.name };
    },
  };

  const partnerUpdate: ToolDefinition<{
    partnerCode: string;
    name?: string;
    contact?: string;
    phone?: string;
    address?: string;
    note?: string;
    extData?: Record<string, unknown>;
  }> = {
    id: 'wms.partner.update',
    label: '更新往来单位',
    description:
      '更新往来单位的名称、联系人、电话、地址、备注或扩展字段。只传需要修改的字段，未传保持不变。种类（kind）不可修改。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        partnerCode: { type: 'string', description: '要更新的往来单位编码' },
        name: { type: 'string', description: '新的名称（可选）' },
        contact: { type: 'string', description: '新的联系人（可选）' },
        phone: { type: 'string', description: '新的联系电话（可选）' },
        address: { type: 'string', description: '新的地址（可选）' },
        note: { type: 'string', description: '新的备注（可选）' },
        extData: { type: 'object', description: '新的扩展字段（可选，整体替换）' },
      },
      required: ['partnerCode'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const partner = ws.partners.byCode(params.partnerCode);
      if (!partner) throw new PartnerNotFoundError(params.partnerCode);
      ctx.appendEvent(WMS_EVENT_TYPES.partnerUpdated, {
        partnerId: partner.id,
        partnerCode: partner.partnerCode,
        name: params.name,
        contact: params.contact,
        phone: params.phone,
        address: params.address,
        note: params.note,
        extData: params.extData,
      });
      ws.sync();
      return { partnerId: partner.id, partnerCode: partner.partnerCode, name: params.name ?? partner.name };
    },
  };

  const partnerList: ToolDefinition<{ kind?: 'supplier' | 'customer' }> = {
    id: 'wms.partner.list',
    label: '查询往来单位',
    description:
      '列出往来单位（供应商/客户统一档案）。可选 kind 过滤 supplier（供应商）或 customer（客户）。纯读操作——幂等，不产生事件。建入库单/出库单前可先查可选的往来单位（入库选供应商、出库选客户）。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['supplier', 'customer'],
          description: '按种类过滤（可选）',
        },
      },
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return { partners: ws.partners.list(params.kind) };
    },
  };

  return [def(partnerCreate), def(partnerUpdate), def(partnerList)];
}
