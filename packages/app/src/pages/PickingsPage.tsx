import { useEffect, useMemo, useState } from 'react';
import { CheckSquareOutlined, CloseOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  InputNumber,
  Modal,
  Progress,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  useClosePicking,
  useCreatePicking,
  useOrders,
  usePickPickingLine,
  usePickings,
  useProfileSnapshot,
  useCancelPicking,
} from '../api/hooks';
import { ApiError } from '../api/client';
import type { Picking, PickingLine } from '../api/client';
import PageHeader from '../components/PageHeader';
import { PrintPreviewModal, PrintRoot, PrintSelectionBar, PrintStyle, usePrintSession } from '../components/print-preview';
import { PickingPrintSheet, pickingPrintTitle } from '../components/print-sheets';
import { TABLE_PAGINATION, monoCell, numCell } from '../components/table-style';
import { fmtQty } from '../lib/format';

/**
 * 拣货单管理页（M21）——聚合「拣货中」出库单的作业单。
 *  - 新建：多选出库单（state=picking）聚合；
 *  - 作业：展开行逐条「录入实拣」（可改实拣库位/批次——记实不扣账）；
 *  - 关单：全部行拣满后统一扣减（订单 → shipped；流水 reason: picking:单号）；
 *  - 取消：留审计，订单留待人工。
 *  - 打印：行上预览弹窗；勾选后一次打出多页。版式和弹窗是同一份。
 * 行为权威在服务端工具（wms.picking.*）：未拣满/余量不足/流程配置
 * 拒绝时按 400 + WMS_ 错误码提示。
 */
export default function PickingsPage() {
  const { message, modal } = AntApp.useApp();
  const snapshot = useProfileSnapshot();
  const pickingOff = snapshot.data?.modules['module.picking']?.enabled === false;
  const [stateFilter, setStateFilter] = useState<'created' | 'closed' | 'canceled' | ''>('');
  const { data: pickings, isLoading } = usePickings(stateFilter || undefined);
  const { data: orders } = useOrders('out');
  const create = useCreatePicking();
  const pick = usePickPickingLine();
  const close = useClosePicking();
  const cancel = useCancelPicking();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
  const session = usePrintSession<Picking>();
  /** 换状态筛选后清空勾选。拣货单数据在客户端，勾选跟着当前这份清单。 */
  const [selectedPickingIds, setSelectedPickingIds] = useState<string[]>([]);
  useEffect(() => {
    setSelectedPickingIds([]);
  }, [stateFilter]);
  const selectedPickings = (pickings ?? []).filter((p) => selectedPickingIds.includes(p.id));
  const previewPicking = session.previewDocs[session.previewIndex];

  // 可聚合的出库单：拣货中状态（服务端还会再校验一层）
  const pickingStateOrders = useMemo(
    () => (orders ?? []).filter((o) => o.state === 'picking'),
    [orders],
  );

  const stateTag = (state: string) =>
    state === 'created' ? (
      <Tag color="processing">拣货中</Tag>
    ) : state === 'closed' ? (
      <Tag color="green">已关单</Tag>
    ) : (
      <Tag>已取消</Tag>
    );

  const doClose = (pickingNo: string) =>
    modal.confirm({
      title: `确认关单 ${pickingNo}？`,
      content: '全部行实拣即扣减：关联出库单流转到「已发货」，库存按实拣桶扣减。',
      onOk: async () => {
        try {
          const r = await close.mutateAsync(pickingNo);
          message.success(`${pickingNo} 已关单，${r.orders.length} 张出库单已发货`);
        } catch (e) {
          message.error(e instanceof ApiError ? e.message : `关单失败：${String(e)}`);
        }
      },
    });

  const doCancel = (pickingNo: string) =>
    modal.confirm({
      title: `确认取消拣货单 ${pickingNo}？`,
      content: '已录实拣保留审计；关联出库单留在「拣货中」待人工处理。',
      onOk: async () => {
        try {
          await cancel.mutateAsync(pickingNo);
          message.success(`${pickingNo} 已取消`);
        } catch (e) {
          message.error(e instanceof ApiError ? e.message : `取消失败：${String(e)}`);
        }
      },
    });

  const submitCreate = async () => {
    if (selectedOrders.length === 0) {
      message.warning('请至少选择一张「拣货中」状态的出库单');
      return;
    }
    try {
      const r = await create.mutateAsync({ orderNos: selectedOrders });
      message.success(`拣货单 ${r.pickingNo} 已创建（${r.lineCount} 行）`);
      setSelectedOrders([]);
      setCreateOpen(false);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `创建失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<Picking> = [
    { title: '拣货单号', dataIndex: 'pickingNo', key: 'pickingNo', onCell: monoCell },
    { title: '状态', dataIndex: 'state', key: 'state', width: 96, render: stateTag },
    {
      title: '进度',
      key: 'progress',
      width: 180,
      render: (_, r) => {
        const total = r.lines.reduce((s, l) => s + l.qtyToPick, 0);
        const picked = r.lines.reduce((s, l) => s + l.pickedQty, 0);
        const done = r.lines.filter((l) => l.pickedQty >= l.qtyToPick).length;
        return (
          <span>
            <Progress
              percent={total > 0 ? Math.round((picked / total) * 100) : 0}
              size="small"
              style={{ width: 100, marginRight: 8 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {done}/{r.lines.length} 行
            </Typography.Text>
          </span>
        );
      },
    },
    {
      title: '关联出库单',
      key: 'orders',
      render: (_, r) => (
        <span>
          {[...new Set(r.lines.map((l) => l.orderNo))].map((no) => (
            <Tag key={no} style={{ fontFamily: 'monospace' }}>
              {no}
            </Tag>
          ))}
        </span>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      render: (_, r) => (
        <>
          <Tooltip title="预览拣货单">
            <Button
              size="small"
              icon={<EyeOutlined />}
              aria-label="预览拣货单"
              style={{ marginRight: 8 }}
              onClick={() => session.openPreview([r])}
            />
          </Tooltip>
          {r.state === 'created' ? (
            <>
              <Button
                size="small"
                type="primary"
                icon={<CheckSquareOutlined />}
                style={{ marginRight: 8 }}
                onClick={() => doClose(r.pickingNo)}
              >
                关单扣减
              </Button>
              <Button size="small" danger icon={<CloseOutlined />} onClick={() => doCancel(r.pickingNo)}>
                取消
              </Button>
            </>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="拣货单"
        subtitle="聚合「拣货中」出库单：逐行实拣（可改拣其他库位/批次），关单统一扣减发货"
        extra={
          <>
            <Select
              allowClear
              placeholder="全部状态"
              style={{ width: 120 }}
              value={stateFilter || undefined}
              onChange={(v) => setStateFilter((v ?? '') as typeof stateFilter)}
              options={[
                { value: 'created', label: '拣货中' },
                { value: 'closed', label: '已关单' },
                { value: 'canceled', label: '已取消' },
              ]}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={pickingStateOrders.length === 0}
              onClick={() => setCreateOpen(true)}
            >
              新建拣货单
            </Button>
          </>
        }
      />
      {pickingOff ? (
        <Alert
          type="info"
          showIcon
          message="拣货已关闭。新的出库单直接发货。已经在拣货中的单仍可在这里做完，或在出库单上发货、取消。"
        />
      ) : null}
      <Card>
        <PrintSelectionBar
          count={selectedPickings.length}
          onPreview={() => session.openPreview(selectedPickings)}
          onPrint={() => session.printNow(selectedPickings)}
        />
        <Table<Picking>
          rowKey="id"
          rowSelection={{
            selectedRowKeys: selectedPickings.map((p) => p.id),
            onChange: (keys) => setSelectedPickingIds(keys.map(String)),
          }}
          columns={columns}
          dataSource={pickings ?? []}
          loading={isLoading}
          pagination={TABLE_PAGINATION}
          expandable={{
            rowExpandable: (r) => r.lines.length > 0,
            expandedRowRender: (r) => (
              <PickLinesTable picking={r} onPick={pick} />
            ),
          }}
          locale={{
            emptyText:
              pickingStateOrders.length === 0
                ? '没有「拣货中」状态的出库单可聚合——先把出库单流转到拣货中'
                : '还没有拣货单，点右上角新建',
          }}
        />
        <Modal
          title="新建拣货单"
          open={createOpen}
          onCancel={() => setCreateOpen(false)}
          onOk={submitCreate}
          confirmLoading={create.isPending}
          okText="创建"
          destroyOnHidden
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            选择「拣货中」状态的出库单聚合为一张拣货单（可多选）：
          </Typography.Paragraph>
          <Select
            mode="multiple"
            showSearch
            optionFilterProp="label"
            placeholder="选择出库单"
            style={{ width: '100%' }}
            value={selectedOrders}
            onChange={setSelectedOrders}
            options={pickingStateOrders.map((o) => ({
              value: o.orderNo,
              label: `${o.orderNo}（${o.lines.length} 行）`,
            }))}
          />
        </Modal>
      </Card>

      <PrintPreviewModal
        open={session.previewDocs.length > 0}
        title={previewPicking ? pickingPrintTitle(previewPicking) : ''}
        index={session.previewIndex}
        total={session.previewDocs.length}
        onIndexChange={session.setPreviewIndex}
        onClose={session.closePreview}
        onPrint={() => session.printNow(session.previewDocs)}
      >
        {previewPicking ? <PickingPrintSheet picking={previewPicking} /> : null}
      </PrintPreviewModal>
      <PrintRoot
        id="picking-print-area"
        docs={session.printDocs}
        renderDoc={(picking) => <PickingPrintSheet picking={picking} />}
      />
      <PrintStyle rootId="picking-print-area" />
    </div>
  );
}

/** 展开行：拣货明细 + 行内录入实拣（默认建议桶，可改实拣库位/批次） */
function PickLinesTable({
  picking,
  onPick,
}: {
  picking: Picking;
  onPick: ReturnType<typeof usePickPickingLine>;
}) {
  const { message } = AntApp.useApp();
  // 行 id → 实拣量 / 实拣库位 / 实拣批次
  const [qty, setQty] = useState<Record<string, number>>({});
  const [loc, setLoc] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<Record<string, string>>({});

  const submitPick = async (line: PickingLine) => {
    const pickedQty = qty[line.id] ?? line.qtyToPick;
    try {
      const r = await onPick.mutateAsync({
        pickingNo: picking.pickingNo,
        body: {
          orderNo: line.orderNo,
          skuCode: line.skuCode,
          suggestedBatchNo: line.suggestedBatchNo,
          pickedQty,
          ...(loc[line.id] ? { locationCode: loc[line.id] } : {}),
          ...(batch[line.id] ? { pickedBatchNo: batch[line.id] } : {}),
        },
      });
      message.success(
        r.remainingToPick > 0
          ? `${line.skuCode} 已拣 ${r.pickedQty}，还差 ${r.remainingToPick}`
          : `${line.skuCode} 已拣满`,
      );
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `录入失败：${String(e)}`);
    }
  };

  return (
    <Table<PickingLine>
      size="small"
      rowKey="id"
      dataSource={picking.lines}
      pagination={TABLE_PAGINATION}
      columns={[
        { title: '出库单', dataIndex: 'orderNo', onCell: monoCell, width: 150 },
        { title: 'SKU', dataIndex: 'skuCode', onCell: monoCell, width: 120 },
        { title: '名称', dataIndex: 'skuName' },
        {
          title: '应拣',
          dataIndex: 'qtyToPick',
          align: 'right',
          width: 90,
          onCell: numCell,
          render: (v: number, r) => fmtQty(v, r.unit),
        },
        { title: '建议库位', dataIndex: 'suggestedLocationCode', width: 100, onCell: monoCell },
        { title: '建议批次', dataIndex: 'suggestedBatchNo', width: 110, onCell: monoCell },
        {
          title: '已拣',
          dataIndex: 'pickedQty',
          width: 90,
          align: 'right',
          onCell: numCell,
          render: (v: number, r) =>
            v >= r.qtyToPick ? (
              <Tag color="green">{fmtQty(v, r.unit)}</Tag>
            ) : v > 0 ? (
              fmtQty(v, r.unit)
            ) : (
              <Typography.Text type="secondary">0</Typography.Text>
            ),
        },
        {
          title: '实拣库位',
          key: 'pickedLoc',
          width: 150,
          render: (_, r) =>
            picking.state === 'created' ? (
              <Select
                allowClear
                size="small"
                showSearch
                optionFilterProp="label"
                placeholder={r.pickedLocationCode ?? r.suggestedLocationCode}
                style={{ width: '100%' }}
                value={loc[r.id]}
                onChange={(v) => setLoc((p) => ({ ...p, [r.id]: v }))}
              />
            ) : (
              <span style={{ fontFamily: 'monospace' }}>{r.pickedLocationCode ?? r.suggestedLocationCode}</span>
            ),
        },
        {
          title: '实拣批次',
          key: 'pickedBatch',
          width: 130,
          render: (_, r) =>
            picking.state === 'created' ? (
              <Select
                allowClear
                size="small"
                showSearch
                placeholder={r.pickedBatchNo ?? r.suggestedBatchNo}
                style={{ width: '100%' }}
                value={batch[r.id]}
                onChange={(v) => setBatch((p) => ({ ...p, [r.id]: v }))}
              />
            ) : (
              <span style={{ fontFamily: 'monospace' }}>{r.pickedBatchNo ?? r.suggestedBatchNo}</span>
            ),
        },
        ...(picking.state === 'created'
          ? [
              {
                title: '录入实拣',
                key: 'pick',
                width: 200,
                render: (_: unknown, r: PickingLine) => (
                  <span>
                    <InputNumber
                      size="small"
                      min={0}
                      precision={3}
                      max={r.qtyToPick}
                      value={qty[r.id] ?? r.pickedQty}
                      onChange={(v) => setQty((p) => ({ ...p, [r.id]: v ?? 0 }))}
                      style={{ marginRight: 8, width: 80 }}
                    />
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      loading={onPick.isPending}
                      onClick={() => void submitPick(r)}
                    >
                      拣
                    </Button>
                  </span>
                ),
              } as ColumnsType<PickingLine>[number],
            ]
          : []),
      ]}
    />
  );
}
