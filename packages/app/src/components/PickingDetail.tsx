import { useMemo, useState } from 'react';
import { ArrowLeftOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Input, InputNumber, Progress, Select, Tag, Typography } from 'antd';
import {
  useCancelPicking,
  useClosePicking,
  useInventoryBuckets,
  useLocations,
  usePickPickingLine,
  usePickings,
  useProfileSnapshot,
} from '../api/hooks';
import { ApiError } from '../api/client';
import type { PickingLine } from '../api/client';
import PageHeader from './PageHeader';
import { fmtQty } from '../lib/format';

/**
 * 拣货详情。列表上不能直接拣，数量、库位和批次在这里按行确认。
 * 一行可以拆成多桶。关单后关联出库单进入已拣货。
 */
export default function PickingDetail({ pickingNo, onBack }: { pickingNo: string; onBack: () => void }) {
  const { message, modal } = AntApp.useApp();
  const snapshot = useProfileSnapshot();
  const partialOn = snapshot.data?.modules['module.partial']?.enabled === true;
  const { data: pickings, isLoading } = usePickings();
  const picking = (pickings ?? []).find((row) => row.pickingNo === pickingNo);
  const close = useClosePicking();
  const cancel = useCancelPicking();
  const open = picking?.state === 'created';
  const total = picking?.lines.reduce((sum, line) => sum + line.qtyToPick, 0) ?? 0;
  const picked = picking?.lines.reduce((sum, line) => sum + line.pickedQty, 0) ?? 0;

  const doClose = () =>
    modal.confirm({
      title: `确认关单 ${pickingNo}？`,
      content: '已经录入过的行按实拣扣减，出库单进入已拣货。发货再到出库单上做，不会再扣一次。没点过的行不能靠关单当成短发。',
      onOk: async () => {
        try {
          const result = await close.mutateAsync(pickingNo);
          const landed = result.orders[0]?.to === 'picked' ? '已拣货' : '已发货';
          message.success(`${pickingNo} 已关单，${result.orders.length} 张出库单进入${landed}`);
        } catch (error) {
          message.error(error instanceof ApiError ? error.message : `关单失败：${String(error)}`);
        }
      },
    });

  const doCancel = () =>
    modal.confirm({
      title: `确认取消拣货单 ${pickingNo}？`,
      content: '已录实拣保留审计。关联出库单留在拣货中，可以再建一张拣货单。',
      onOk: async () => {
        try {
          await cancel.mutateAsync(pickingNo);
          message.success(`${pickingNo} 已取消`);
          onBack();
        } catch (error) {
          message.error(error instanceof ApiError ? error.message : `取消失败：${String(error)}`);
        }
      },
    });

  if (!picking) {
    return (
      <div>
        <PageHeader title={pickingNo} subtitle={isLoading ? '正在读取拣货单' : '找不到这张拣货单'} />
        <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
          返回
        </Button>
      </div>
    );
  }

  const orders = [...new Set(picking.lines.map((line) => line.orderNo))];

  return (
    <div className="app-fill" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0, overflow: 'auto' }}>
      <PageHeader
        title={`拣货 ${picking.pickingNo}`}
        subtitle="在这里逐行确认实拣。一行可以拆成多桶。关单后出库单进入已拣货，库存按实拣扣减。"
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
              返回
            </Button>
            {open ? (
              <>
                <Button danger onClick={doCancel}>
                  取消
                </Button>
                <Button type="primary" onClick={doClose}>
                  关单
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {picking.state === 'created' ? <Tag color="processing">拣货中</Tag> : picking.state === 'closed' ? <Tag color="green">已关单</Tag> : <Tag>已取消</Tag>}
        <Progress percent={total > 0 ? Math.round((picked / total) * 100) : 0} style={{ width: 180, margin: 0 }} />
        <Typography.Text type="secondary">
          已拣 {fmtQty(picked)} / {fmtQty(total)}
        </Typography.Text>
        {orders.map((orderNo) => (
          <Tag key={orderNo} style={{ fontFamily: 'monospace' }}>
            {orderNo}
          </Tag>
        ))}
      </div>
      {partialOn && open ? (
        <Alert type="info" showIcon message="短发开着。可以少拣，但每一行都要先确认，没点过的行不能关成 0。" />
      ) : null}
      {picking.lines.map((line) => (
        <LineCard key={`${line.id}:${line.pickedQty}`} line={line} open={open} pickingNo={picking.pickingNo} />
      ))}
    </div>
  );
}

function LineCard({ line, open, pickingNo }: { line: PickingLine; open: boolean; pickingNo: string }) {
  const { message } = AntApp.useApp();
  const pick = usePickPickingLine();
  const { data: locationRows } = useLocations();
  const { data: buckets } = useInventoryBuckets();
  const locationOptions = [
    { value: 'DEFAULT', label: '默认库位' },
    ...(locationRows ?? [])
      .filter((row) => row.locationCode !== 'DEFAULT')
      .map((row) => ({ value: row.locationCode, label: row.locationCode })),
  ];
  const [rows, setRows] = useState<Bucket[]>(() => initialBuckets(line));
  const sum = rows.reduce((total, row) => total + (Number.isFinite(row.quantity) ? row.quantity : 0), 0);
  const over = sum > line.qtyToPick + 1e-9;
  const hints = useMemo(
    () =>
      (buckets ?? [])
        .filter((row) => row.skuCode === line.skuCode && row.quantity > 0)
        .slice(0, 6),
    [buckets, line.skuCode],
  );

  const submit = async () => {
    if (over) {
      message.warning(`${line.skuCode} 实拣超过应拣`);
      return;
    }
    const allocations = rows
      .filter((row) => row.quantity > 0)
      .map((row) => ({
        quantity: row.quantity,
        locationCode: row.locationCode || line.suggestedLocationCode,
        batchNo: row.batchNo || line.suggestedBatchNo,
      }));
    try {
      const result = await pick.mutateAsync({
        pickingNo,
        body: {
          orderNo: line.orderNo,
          skuCode: line.skuCode,
          suggestedBatchNo: line.suggestedBatchNo,
          pickedQty: sum,
          allocations,
        },
      });
      message.success(
        result.remainingToPick > 0
          ? `${line.skuCode} 已拣 ${fmtQty(result.pickedQty, line.unit)}，还差 ${fmtQty(result.remainingToPick, line.unit)}`
          : `${line.skuCode} 已拣满`,
      );
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : `录入失败：${String(error)}`);
    }
  };

  return (
    <Card
      size="small"
      title={
        <span>
          <Typography.Text code>{line.skuCode}</Typography.Text>
          <span style={{ marginLeft: 8 }}>{line.skuName}</span>
          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
            {line.orderNo}
          </Typography.Text>
        </span>
      }
      extra={
        line.pickedQty >= line.qtyToPick ? (
          <Tag color="green">已拣满 {fmtQty(line.pickedQty, line.unit)}</Tag>
        ) : line.pickedQty > 0 ? (
          <Tag color="gold">
            已拣 {fmtQty(line.pickedQty, line.unit)} / {fmtQty(line.qtyToPick, line.unit)}
          </Tag>
        ) : (
          <span>应拣 {fmtQty(line.qtyToPick, line.unit)}</span>
        )
      }
    >
      <div style={{ marginBottom: 8 }}>
        建议 <Typography.Text code>{line.suggestedLocationCode}</Typography.Text>
        <span style={{ margin: '0 8px' }}>/</span>
        <Typography.Text code>{line.suggestedBatchNo}</Typography.Text>
      </div>
      {hints.length > 0 ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          可拣：
          {hints.map((row) => `${row.locationCode} / ${row.batchNo} 还有 ${fmtQty(row.quantity, line.unit)}`).join('；')}
        </Typography.Paragraph>
      ) : null}
      {open ? (
        <>
          {rows.map((row) => (
            <div key={row.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <Select
                showSearch
                optionFilterProp="label"
                aria-label="实拣库位"
                style={{ width: 140 }}
                value={row.locationCode}
                options={locationOptions}
                onChange={(value) => setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, locationCode: value } : item)))}
              />
              <Input
                aria-label="实拣批次"
                style={{ width: 140 }}
                value={row.batchNo}
                onChange={(event) =>
                  setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, batchNo: event.target.value } : item)))
                }
              />
              <InputNumber
                aria-label="实拣数量"
                min={0}
                precision={3}
                value={row.quantity}
                onChange={(value) =>
                  setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, quantity: typeof value === 'number' ? value : 0 } : item)))
                }
                style={{ width: 110 }}
              />
              {rows.length > 1 ? (
                <Button type="link" onClick={() => setRows((prev) => prev.filter((item) => item.id !== row.id))}>
                  去掉
                </Button>
              ) : null}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              icon={<PlusOutlined />}
              onClick={() =>
                setRows((prev) => [
                  ...prev,
                  {
                    id: `${line.id}-${Date.now()}`,
                    locationCode: line.suggestedLocationCode,
                    batchNo: line.suggestedBatchNo,
                    quantity: Math.max(0, round3(line.qtyToPick - sum)),
                  },
                ])
              }
            >
              再加一桶
            </Button>
            <Button type="primary" loading={pick.isPending} disabled={over} onClick={() => void submit()}>
              确认这行
            </Button>
            <Typography.Text type={over ? 'danger' : 'secondary'}>
              合计 {fmtQty(sum, line.unit)} / 应拣 {fmtQty(line.qtyToPick, line.unit)}
            </Typography.Text>
          </div>
        </>
      ) : (
        <div>
          {(line.allocations?.length
            ? line.allocations
            : [{ locationCode: line.pickedLocationCode ?? line.suggestedLocationCode, batchNo: line.pickedBatchNo ?? line.suggestedBatchNo, quantity: line.pickedQty }]
          ).map((row, index) => (
            <div key={`${row.locationCode}-${index}`}>
              <Typography.Text code>{row.locationCode}</Typography.Text>
              <span style={{ margin: '0 8px' }}>/</span>
              <Typography.Text code>{row.batchNo}</Typography.Text>
              <span style={{ marginLeft: 8 }}>{fmtQty(row.quantity, line.unit)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface Bucket {
  id: string;
  locationCode: string;
  batchNo: string;
  quantity: number;
}

function initialBuckets(line: PickingLine): Bucket[] {
  if (line.allocations && line.allocations.length > 0) {
    return line.allocations.map((row, index) => ({
      id: `${line.id}-${index}`,
      locationCode: row.locationCode,
      batchNo: row.batchNo,
      quantity: row.quantity,
    }));
  }
  if (line.pickedQty > 0) {
    return [
      {
        id: `${line.id}-0`,
        locationCode: line.pickedLocationCode ?? line.suggestedLocationCode,
        batchNo: line.pickedBatchNo ?? line.suggestedBatchNo,
        quantity: line.pickedQty,
      },
    ];
  }
  return [
    {
      id: `${line.id}-0`,
      locationCode: line.suggestedLocationCode,
      batchNo: line.suggestedBatchNo,
      quantity: line.qtyToPick,
    },
  ];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
