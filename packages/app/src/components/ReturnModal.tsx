import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp, InputNumber, Modal, Select, Table, Typography } from 'antd';
import { useCreateOrder, useLocations } from '../api/hooks';
import { api, ApiError } from '../api/client';
import type { Order, ReturnableLine } from '../api/client';
import { fmtQty } from '../lib/format';
import { monoCell, numCell } from './table-style';

/**
 * 退货开单（module.return）。不新增状态：客退开入库单，退供开出库单，
 * 库存仍走原来的收货/发货。数量按原单 SKU + 批次封顶，库位可以改。
 * 查询只在弹窗打开时发，避免单据页每次渲染都打 returnable。
 */
export default function ReturnModal({
  open,
  onClose,
  order,
}: {
  open: boolean;
  onClose: () => void;
  order: Order | null;
}) {
  const { message } = AntApp.useApp();
  const { data: locations } = useLocations();
  const create = useCreateOrder();
  const returnable = useQuery({
    queryKey: ['order-returnable', order?.orderNo ?? ''],
    queryFn: () => api.orderReturnable(order!.orderNo),
    enabled: open && !!order,
  });
  const [qty, setQty] = useState<Record<number, number>>({});
  const [locs, setLocs] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open || !returnable.data) return;
    const nextQty: Record<number, number> = {};
    const nextLoc: Record<number, string> = {};
    returnable.data.lines.forEach((line, i) => {
      nextQty[i] = line.remaining;
      nextLoc[i] = line.locationCode;
    });
    setQty(nextQty);
    setLocs(nextLoc);
  }, [open, returnable.data]);

  const locationOptions = useMemo(
    () => (locations ?? []).map((l) => ({ value: l.locationCode, label: `${l.locationCode} · ${l.name ?? ''}` })),
    [locations],
  );

  const view = returnable.data;
  const direction = view?.direction;

  const submit = async () => {
    if (!view || !direction) return;
    const lines = view.lines.flatMap((line, i) => {
      const quantity = qty[i] ?? line.remaining;
      if (!(quantity > 0)) return [];
      const locationCode = locs[i] || line.locationCode;
      return [
        {
          skuCode: line.skuCode,
          quantity,
          locationCode: locationCode || undefined,
          batchNo: line.batchNo,
          ...(direction === 'in' && line.batchExpiryDate ? { batchExpiryDate: line.batchExpiryDate } : {}),
        },
      ];
    });
    if (lines.length === 0) {
      message.warning('请至少填写一行大于 0 的退货数量');
      return;
    }
    try {
      const created = await create.mutateAsync({
        direction,
        returnOf: view.sourceOrderNo,
        note: `退货 ${view.sourceOrderNo}`,
        lines,
      });
      message.success(`${created.orderNo} 已开出（${direction === 'in' ? '客退' : '退供'}）`);
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `退货失败：${String(e)}`);
    }
  };

  const title = view
    ? `${view.direction === 'in' ? '客退' : '退供'} · 原单 ${view.sourceOrderNo}`
    : `退货 · ${order?.orderNo ?? ''}`;

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: !view || returnable.isLoading }}
      okText={direction === 'out' ? '开退供单' : '开客退单'}
      destroyOnHidden
      width={760}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {direction === 'out'
          ? '退供开出库单，发货时按这里的数量扣库存。批次必须是原单上的批次，库位可以改成实际出库的库位。'
          : '客退开入库单，收货时按这里的数量加库存。批次和效期沿用原单，库位是货退回的位置，可以改。'}
      </Typography.Paragraph>
      {returnable.isError ? (
        <Typography.Text type="danger">
          {returnable.error instanceof ApiError ? returnable.error.message : '读取可退数量失败'}
        </Typography.Text>
      ) : (
        <Table<ReturnableLine>
          size="small"
          rowKey={(line) => `${line.skuCode}\u0000${line.batchNo}`}
          dataSource={view?.lines ?? []}
          loading={returnable.isLoading}
          pagination={false}
          locale={{ emptyText: '没有可退数量' }}
          columns={[
            { title: 'SKU', dataIndex: 'skuCode', width: 120, onCell: monoCell },
            { title: '名称', dataIndex: 'name' },
            { title: '批次', dataIndex: 'batchNo', width: 100, onCell: monoCell },
            {
              title: '可退',
              dataIndex: 'remaining',
              width: 90,
              align: 'right',
              onCell: numCell,
              render: (v: number, line) => fmtQty(v, line.unit),
            },
            {
              title: '本次数量',
              key: 'qty',
              width: 130,
              render: (_, line, i) => (
                <InputNumber
                  aria-label={`${line.skuCode} 退货数量`}
                  min={0}
                  max={line.remaining}
                  precision={3}
                  value={qty[i] ?? line.remaining}
                  onChange={(v) => setQty((prev) => ({ ...prev, [i]: typeof v === 'number' ? v : 0 }))}
                  style={{ width: '100%' }}
                />
              ),
            },
            {
              title: direction === 'out' ? '出库库位' : '退回库位',
              key: 'location',
              width: 180,
              render: (_, line, i) => {
                const value = locs[i] || line.locationCode;
                const options = locationOptions.some((o) => o.value === value)
                  ? locationOptions
                  : [{ value, label: value }, ...locationOptions];
                return (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    style={{ width: '100%' }}
                    options={options}
                    value={value}
                    onChange={(v) => setLocs((prev) => ({ ...prev, [i]: v }))}
                  />
                );
              },
            },
          ]}
        />
      )}
    </Modal>
  );
}
