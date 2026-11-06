import { useMemo, useState } from 'react';
import { App as AntApp, Modal, Select, Table, Typography } from 'antd';
import { usePutawayOrder, useLocations } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Order } from '../api/client';
import { monoCell, numCell } from './table-style';

/**
 * 上架确认弹窗（M21，module.putaway）：
 * 每行可选目标库位——不选 = 留在收货库位（纯确认）；选了 = 归位（一对移库
 * 流水，批次/效期保留，reason: putaway:单号）。行为权威在服务端工具：
 * 源桶不足 / 行不匹配 / 模块停用都会被拒（400 + WMS_ 错误码）。
 */
export default function PutawayModal({
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
  const putaway = usePutawayOrder();
  // 行索引 → 目标库位（undefined = 不归位）
  const [targets, setTargets] = useState<Record<number, string>>({});

  const locationOptions = useMemo(
    () => (locations ?? []).map((l) => ({ value: l.locationCode, label: `${l.locationCode} · ${l.name ?? ''}` })),
    [locations],
  );

  const submit = async () => {
    if (!order) return;
    const ts = order.lines
      .map((line, i) => ({
        skuCode: line.skuCode,
        fromLocationCode: line.locationCode,
        batchNo: line.batchNo,
        toLocationCode: targets[i],
      }))
      .filter((t): t is typeof t & { toLocationCode: string } => Boolean(t.toLocationCode));
    try {
      const r = await putaway.mutateAsync({
        orderNo: order.orderNo,
        targets: ts.length > 0 ? ts : undefined,
      });
      message.success(
        r.movedLines && r.movedLines.length > 0
          ? `${order.orderNo} 已上架，归位 ${r.movedLines.length} 行`
          : `${order.orderNo} 已上架`,
      );
      setTargets({});
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `上架失败：${String(e)}`);
    }
  };

  return (
    <Modal
      title={`上架确认 · ${order?.orderNo ?? ''}`}
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={putaway.isPending}
      okText="确认上架"
      destroyOnHidden
      width={680}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        收货已入账（库存已在收货库位）。为行选择目标库位即归位（移库流水，批次与效期保留）；
        不选则留在原地，仅确认上架。
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey={(_, i) => String(i)}
        dataSource={order?.lines ?? []}
        pagination={false}
        columns={[
          { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell, width: 140 },
          { title: '名称', dataIndex: 'name' },
          { title: '数量', dataIndex: 'quantity', align: 'right', width: 80, onCell: numCell },
          { title: '批次', dataIndex: 'batchNo', width: 110, onCell: monoCell },
          { title: '收货库位', dataIndex: 'locationCode', width: 110, onCell: monoCell },
          {
            title: '归位到（可选）',
            key: 'target',
            width: 200,
            render: (_, __, i) => (
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="留在收货库位"
                style={{ width: '100%' }}
                options={locationOptions.filter(
                  (o) => o.value !== (order?.lines[i]?.locationCode ?? ''),
                )}
                value={targets[i]}
                onChange={(v) => setTargets((prev) => ({ ...prev, [i]: v }))}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}
