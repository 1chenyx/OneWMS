import { useMemo, useState } from 'react';
import { ArrowLeftOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, InputNumber, Select, Tag, Typography } from 'antd';
import { useInventoryBuckets, useLocations, usePutawayOrder } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Order, OrderLine } from '../api/client';
import PageHeader from './PageHeader';
import { fmtQty } from '../lib/format';

/**
 * 上架作业。一行可以拆到多个库位，没分走的留在收货库位。
 * 序列号商品整行上架。数量合计超过本行时不能提交。
 */
export default function PutawayWork({ order, onBack }: { order: Order; onBack: () => void }) {
  const { message } = AntApp.useApp();
  const { data: locations } = useLocations();
  const { data: buckets } = useInventoryBuckets();
  const putaway = usePutawayOrder();
  const [slots, setSlots] = useState<Record<string, Slot[]>>(() => freshSlots(order));

  const locationOptions = useMemo(
    () =>
      (locations ?? []).map((row) => ({
        value: row.locationCode,
        label: row.name ? `${row.locationCode} · ${row.name}` : row.locationCode,
      })),
    [locations],
  );

  const over = order.lines.some((line, index) => assigned(slots[keyOf(line, index)] ?? []) > line.quantity + 1e-9);
  const moves = plannedMoves(order, slots);

  const submit = async () => {
    if (over) {
      message.warning('有一行分出去的数量超过了本行');
      return;
    }
    try {
      const result = await putaway.mutateAsync({
        orderNo: order.orderNo,
        targets: moves.length > 0 ? moves : undefined,
      });
      const moved = result.movedLines?.length ?? 0;
      message.success(moved > 0 ? `${order.orderNo} 已上架，归位 ${moved} 处` : `${order.orderNo} 已上架，货留在收货库位`);
      if (result.warning) message.warning(result.warning);
      onBack();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : `上架失败：${String(error)}`);
    }
  };

  return (
    <div className="app-fill" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title={`上架 ${order.orderNo}`}
        subtitle="一行可以分到多个库位。没写目标、或数量没分完的，留在收货库位。确认后整张单进入已上架。"
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
              返回
            </Button>
            <Button type="primary" loading={putaway.isPending} disabled={over} onClick={() => void submit()}>
              确认上架
            </Button>
          </>
        }
      />
      {order.partnerName ? (
        <Typography.Text type="secondary">
          往来单位 {order.partnerName}
          {order.partnerCode ? `（${order.partnerCode}）` : ''}
        </Typography.Text>
      ) : null}
      {order.lines.map((line, index) => {
        const id = keyOf(line, index);
        const rows = slots[id] ?? [];
        const used = assigned(rows);
        const left = line.quantity - used;
        const serialLocked = (line.serials?.length ?? 0) > 0;
        const source = line.locationCode ?? 'DEFAULT';
        const moving = rows.some(
          (slot) => Boolean(slot.locationCode) && slot.locationCode !== source && slot.quantity > 0,
        );
        return (
          <Card
            key={id}
            size="small"
            title={
              <span>
                <Typography.Text code>{line.skuCode}</Typography.Text>
                <span style={{ marginLeft: 8 }}>{line.name}</span>
              </span>
            }
            extra={<span>本行 {fmtQty(line.quantity, line.unit)}</span>}
          >
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
              <span>
                收货库位 <Typography.Text code>{source}</Typography.Text>
              </span>
              <span>
                批次 <Typography.Text code>{line.batchNo ?? 'DEFAULT'}</Typography.Text>
              </span>
              {line.batchExpiryDate ? <span>效期 {line.batchExpiryDate}</span> : null}
              {serialLocked ? <Tag>序列号 {line.serials!.length} 件，整行上架</Tag> : null}
            </div>
            {rows.map((slot, slotIndex) => {
              const here = onHand(buckets, line, slot.locationCode);
              const capacity = (locations ?? []).find((row) => row.locationCode === slot.locationCode)?.capacity;
              return (
                <div key={slot.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    aria-label="目标库位"
                    placeholder="留在收货库位"
                    style={{ width: 220 }}
                    options={locationOptions}
                    value={slot.locationCode}
                    onChange={(value) => updateSlot(id, slot.id, { locationCode: value })}
                  />
                  <InputNumber
                    aria-label="上架数量"
                    min={0}
                    precision={3}
                    disabled={serialLocked}
                    value={slot.quantity}
                    onChange={(value) => updateSlot(id, slot.id, { quantity: typeof value === 'number' ? value : 0 })}
                    style={{ width: 120 }}
                  />
                  <Typography.Text type="secondary">
                    {slot.locationCode
                      ? `该库位此批次现有 ${fmtQty(here, line.unit)}${capacity != null && capacity > 0 ? `，容量 ${capacity}` : ''}`
                      : '不选库位就留在收货处'}
                  </Typography.Text>
                  {!serialLocked && rows.length > 1 ? (
                    <Button type="link" onClick={() => removeSlot(id, slot.id)}>
                      去掉
                    </Button>
                  ) : null}
                  {slotIndex === 0 && !serialLocked ? (
                    <Button
                      type="link"
                      icon={<PlusOutlined aria-hidden />}
                      onClick={() =>
                        setSlots((prev) => ({
                          ...prev,
                          [id]: [...(prev[id] ?? []), { id: `${id}-${Date.now()}`, quantity: Math.max(0, left) }],
                        }))
                      }
                    >
                      再分一个库位
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {left > 1e-9 ? (
              <Alert type="info" showIcon message={`还有 ${fmtQty(left, line.unit)} 留在 ${source}`} />
            ) : left < -1e-9 ? (
              <Alert type="error" showIcon message={`分出去的数量比本行多了 ${fmtQty(-left, line.unit)}`} />
            ) : moving ? (
              <Typography.Text type="secondary">这一行的数量已经分完。</Typography.Text>
            ) : (
              <Typography.Text type="secondary">整行留在 {source}。</Typography.Text>
            )}
          </Card>
        );
      })}
    </div>
  );

  function updateSlot(lineId: string, slotId: string, patch: Partial<Slot>) {
    setSlots((prev) => ({
      ...prev,
      [lineId]: (prev[lineId] ?? []).map((slot) => (slot.id === slotId ? { ...slot, ...patch } : slot)),
    }));
  }

  function removeSlot(lineId: string, slotId: string) {
    setSlots((prev) => ({
      ...prev,
      [lineId]: (prev[lineId] ?? []).filter((slot) => slot.id !== slotId),
    }));
  }
}

interface Slot {
  id: string;
  locationCode?: string;
  quantity: number;
}

function keyOf(line: OrderLine, index: number): string {
  return `${index}:${line.skuCode}:${line.locationCode ?? ''}:${line.batchNo ?? ''}`;
}

function freshSlots(order: Order): Record<string, Slot[]> {
  const next: Record<string, Slot[]> = {};
  order.lines.forEach((line, index) => {
    next[keyOf(line, index)] = [{ id: `${index}-0`, quantity: line.quantity }];
  });
  return next;
}

function assigned(rows: Slot[]): number {
  return rows.reduce((sum, slot) => sum + (Number.isFinite(slot.quantity) ? slot.quantity : 0), 0);
}

function plannedMoves(order: Order, slots: Record<string, Slot[]>) {
  const targets: {
    skuCode: string;
    fromLocationCode?: string;
    batchNo?: string;
    toLocationCode: string;
    quantity: number;
  }[] = [];
  order.lines.forEach((line, index) => {
    const source = line.locationCode ?? '';
    for (const slot of slots[keyOf(line, index)] ?? []) {
      if (!slot.locationCode || slot.quantity <= 0) continue;
      if (slot.locationCode === (line.locationCode ?? 'DEFAULT') || slot.locationCode === source) continue;
      targets.push({
        skuCode: line.skuCode,
        fromLocationCode: line.locationCode,
        batchNo: line.batchNo,
        toLocationCode: slot.locationCode,
        quantity: slot.quantity,
      });
    }
  });
  return targets;
}

function onHand(
  buckets: { skuCode: string; locationCode: string; batchNo: string; quantity: number }[] | undefined,
  line: OrderLine,
  locationCode: string | undefined,
): number {
  if (!locationCode || !buckets) return 0;
  const batch = line.batchNo ?? 'DEFAULT';
  return buckets
    .filter((row) => row.skuCode === line.skuCode && row.locationCode === locationCode && row.batchNo === batch)
    .reduce((sum, row) => sum + row.quantity, 0);
}
