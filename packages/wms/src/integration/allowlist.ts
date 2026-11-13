/**
 * 映射能读写的字段。入站 to 必须落在工具参数上，出站 from 必须落在规范快照上。
 * 分配策略、退货、预报不在这张表里，那些仍由仓库规则决定。
 */

import type { DateForm, InboundCanonical, OutboundCanonical, OutboundEvent, ValueSource } from './types.js';

export const OUTBOUND_EVENT_CANONICAL: Record<OutboundEvent, OutboundCanonical> = {
  'wms.order.created': 'order.snapshot',
  'wms.order.state_changed': 'order.snapshot',
  'wms.sku.created': 'sku.snapshot',
  'wms.sku.updated': 'sku.snapshot',
  'wms.partner.created': 'partner.snapshot',
  'wms.partner.updated': 'partner.snapshot',
  'wms.inventory.adjusted': 'inventory.movement',
};

export const INBOUND_CANONICALS = [
  'order.create',
  'order.transition',
  'sku.create',
  'sku.update',
  'partner.create',
  'partner.update',
] as const satisfies readonly InboundCanonical[];

export interface FieldRule {
  ops: readonly ValueSource['op'][];
  constValues?: readonly string[];
  /** const 字符串要匹配的格式。效期只收 YYYY-MM-DD。 */
  constPattern?: RegExp;
  /** date 算子的 to 必须是这一档，工具才认。 */
  dateTo?: DateForm;
  integer?: boolean;
}

export interface InboundShape {
  fields: Record<string, FieldRule>;
  required: readonly string[];
  /** 建单必须有明细。状态转移和主数据没有明细。 */
  lines: boolean;
  lineFields?: Record<string, FieldRule>;
  lineRequired?: readonly string[];
}

const note: FieldRule = { ops: ['path', 'const', 'template'] };
const codeRef: FieldRule = { ops: ['path', 'const', 'code', 'template'] };
const text: FieldRule = { ops: ['path', 'const', 'template'] };

export const INBOUND_SHAPE: Record<InboundCanonical, InboundShape> = {
  'order.create': {
    fields: {
      direction: { ops: ['const'], constValues: ['in', 'out'] },
      orderNo: { ops: ['path'] },
      note,
      partnerCode: codeRef,
    },
    required: ['direction', 'orderNo'],
    lines: true,
    lineFields: {
      skuCode: codeRef,
      quantity: { ops: ['number'] },
      locationCode: text,
      batchNo: text,
      batchExpiryDate: { ops: ['path', 'const', 'date'], constPattern: /^\d{4}-\d{2}-\d{2}$/, dateTo: 'date' },
    },
    lineRequired: ['skuCode', 'quantity'],
  },
  'order.transition': {
    fields: {
      orderNo: { ops: ['path'] },
      to: { ops: ['const', 'enum'] },
    },
    required: ['orderNo', 'to'],
    lines: false,
  },
  'sku.create': {
    fields: {
      skuCode: { ops: ['path'] },
      name: text,
      barcode: text,
      unit: text,
      reorderPoint: { ops: ['number'], integer: true },
    },
    required: ['skuCode', 'name'],
    lines: false,
  },
  'sku.update': {
    fields: {
      skuCode: { ops: ['path'] },
      name: text,
      barcode: text,
      unit: text,
      reorderPoint: { ops: ['number'], integer: true },
    },
    required: ['skuCode'],
    lines: false,
  },
  'partner.create': {
    fields: {
      partnerCode: { ops: ['path'] },
      kind: { ops: ['const'], constValues: ['supplier', 'customer'] },
      name: text,
      contact: text,
      phone: text,
      address: text,
      note,
    },
    required: ['partnerCode', 'kind', 'name'],
    lines: false,
  },
  'partner.update': {
    fields: {
      partnerCode: { ops: ['path'] },
      name: text,
      contact: text,
      phone: text,
      address: text,
      note,
    },
    required: ['partnerCode'],
    lines: false,
  },
};

/** 入站创建、更新、转移都把对方主键写到这个自然键上，重试才能认出同一张单。 */
export const NATURAL_KEY: Record<InboundCanonical, string> = {
  'order.create': 'orderNo',
  'order.transition': 'orderNo',
  'sku.create': 'skuCode',
  'sku.update': 'skuCode',
  'partner.create': 'partnerCode',
  'partner.update': 'partnerCode',
};

export const SNAPSHOT_TOP: Record<OutboundCanonical, readonly string[]> = {
  'order.snapshot': ['orderNo', 'direction', 'state', 'from', 'to', 'partnerCode', 'note', 'externalId', 'occurredAt'],
  'sku.snapshot': ['skuCode', 'name', 'barcode', 'unit', 'reorderPoint'],
  'partner.snapshot': ['partnerCode', 'kind', 'name', 'contact', 'phone', 'address', 'note'],
  'inventory.movement': ['skuCode', 'locationCode', 'batchNo', 'delta', 'reason', 'orderNo', 'occurredAt'],
};

export const SNAPSHOT_LINE: Partial<Record<OutboundCanonical, readonly string[]>> = {
  'order.snapshot': ['skuCode', 'quantity', 'locationCode', 'batchNo', 'batchExpiryDate', 'unit'],
};

export function canonicalFamily(kind: string): 'order' | 'sku' | 'partner' | 'inventory' | undefined {
  if (kind.startsWith('order.')) return 'order';
  if (kind.startsWith('sku.')) return 'sku';
  if (kind.startsWith('partner.')) return 'partner';
  if (kind === 'inventory.movement') return 'inventory';
  return undefined;
}

export function isInboundCanonical(kind: string): kind is InboundCanonical {
  return (INBOUND_CANONICALS as readonly string[]).includes(kind);
}
