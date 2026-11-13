/**
 * 出站快照。状态以事件当时为准，明细和主数据读当前投影。
 * 对方编码来自本连接器已经接受过的收件。
 */

import type { EventEnvelope } from '@one/core';
import { DEFAULT_LOCATION_ID } from '../events/catalog.js';
import { withOrderLines } from '../queries/order-queries.js';
import type { WmsWorkspace } from '../wms.js';
import { OUTBOUND_EVENT_CANONICAL } from './allowlist.js';
import type { IntegrationQueue } from './queue.js';
import type { OutboundEvent } from './types.js';

export type SnapshotBuild =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; retry: boolean; message: string };

export function buildOutboundSnapshot(
  ws: WmsWorkspace,
  env: EventEnvelope,
  connectorId: string,
  queue: IntegrationQueue,
): SnapshotBuild {
  if (!isOutboundEvent(env.type)) return { ok: false, retry: false, message: '不是出站事件' };
  const payload = asRecord(env.payload);
  if (!payload) return { ok: false, retry: false, message: '事件载荷不是对象' };
  if (env.type === 'wms.order.created' || env.type === 'wms.order.state_changed') {
    return orderSnapshot(ws, env, payload, connectorId, queue);
  }
  if (env.type === 'wms.sku.created' || env.type === 'wms.sku.updated') return skuSnapshot(ws, payload);
  if (env.type === 'wms.partner.created' || env.type === 'wms.partner.updated') return partnerSnapshot(ws, payload);
  return movementSnapshot(ws, env, payload);
}

function isOutboundEvent(type: string): type is OutboundEvent {
  return Object.hasOwn(OUTBOUND_EVENT_CANONICAL, type);
}

function orderSnapshot(
  ws: WmsWorkspace,
  env: EventEnvelope,
  payload: Record<string, unknown>,
  connectorId: string,
  queue: IntegrationQueue,
): SnapshotBuild {
  const orderNo = readString(payload, 'orderNo');
  if (!orderNo) return { ok: false, retry: false, message: '事件没有单号' };
  const order = ws.orders.byNo(orderNo);
  if (!order) return { ok: false, retry: true, message: '单据还没进投影' };
  const view = withOrderLines(ws, order);
  const value: Record<string, unknown> = {
    orderNo: view.orderNo,
    direction: view.direction,
    occurredAt: env.createdAt,
    lines: view.lines.map((line) => ({
      skuCode: line.skuCode,
      quantity: line.quantity,
      locationCode: line.locationCode,
      batchNo: line.batchNo,
      ...(line.batchExpiryDate ? { batchExpiryDate: line.batchExpiryDate } : {}),
      ...(line.unit ? { unit: line.unit } : {}),
    })),
  };
  if (env.type === 'wms.order.state_changed') {
    const from = readString(payload, 'from');
    const to = readString(payload, 'to');
    if (!from || !to) return { ok: false, retry: false, message: '状态事件没有 from 或 to' };
    value.from = from;
    value.to = to;
    value.state = to;
  } else {
    value.state = payload.asn != null ? 'announced' : 'created';
  }
  if (view.partnerCode) value.partnerCode = view.partnerCode;
  if (view.note) value.note = view.note;
  const externalId = queue.externalIdFor(connectorId, view.orderNo);
  if (externalId) value.externalId = externalId;
  return { ok: true, value };
}

function skuSnapshot(ws: WmsWorkspace, payload: Record<string, unknown>): SnapshotBuild {
  const skuCode = readString(payload, 'skuCode');
  if (!skuCode) return { ok: false, retry: false, message: '事件没有 SKU 编码' };
  const sku = ws.skus.byCode(skuCode);
  if (!sku) return { ok: false, retry: true, message: 'SKU 还没进投影' };
  const value: Record<string, unknown> = {
    skuCode: sku.skuCode,
    name: sku.name,
    reorderPoint: sku.reorderPoint,
  };
  if (sku.barcode) value.barcode = sku.barcode;
  if (sku.unit) value.unit = sku.unit;
  return { ok: true, value };
}

function partnerSnapshot(ws: WmsWorkspace, payload: Record<string, unknown>): SnapshotBuild {
  const partnerCode = readString(payload, 'partnerCode');
  if (!partnerCode) return { ok: false, retry: false, message: '事件没有往来单位编码' };
  const partner = ws.partners.byCode(partnerCode);
  if (!partner) return { ok: false, retry: true, message: '往来单位还没进投影' };
  const value: Record<string, unknown> = {
    partnerCode: partner.partnerCode,
    kind: partner.kind,
    name: partner.name,
  };
  if (partner.contact) value.contact = partner.contact;
  if (partner.phone) value.phone = partner.phone;
  if (partner.address) value.address = partner.address;
  if (partner.note) value.note = partner.note;
  return { ok: true, value };
}

function movementSnapshot(ws: WmsWorkspace, env: EventEnvelope, payload: Record<string, unknown>): SnapshotBuild {
  const skuCode = readString(payload, 'skuCode');
  const delta = payload.delta;
  if (!skuCode || typeof delta !== 'number' || !Number.isFinite(delta)) {
    return { ok: false, retry: false, message: '库存事件缺字段' };
  }
  const locationId = readString(payload, 'locationId');
  const locationCode =
    readString(payload, 'locationCode') ??
    (locationId ? ws.locations.byId(locationId)?.locationCode : undefined) ??
    DEFAULT_LOCATION_ID;
  const value: Record<string, unknown> = { skuCode, locationCode, delta, occurredAt: env.createdAt };
  const batchNo = readString(payload, 'batchNo');
  const reason = readString(payload, 'reason');
  const orderNo = readString(payload, 'orderNo');
  if (batchNo) value.batchNo = batchNo;
  if (reason) value.reason = reason;
  if (orderNo) value.orderNo = orderNo;
  return { ok: true, value };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
