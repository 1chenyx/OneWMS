import { useEffect, useMemo, useRef, useState } from 'react';
import { EyeOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Input,
  Modal,
  Progress,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCreatePicking, useOrders, usePickings, useProfileSnapshot } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Picking } from '../api/client';
import PickingDetail from '../components/PickingDetail';
import PageHeader from '../components/PageHeader';
import { useDraftNumber } from '../components/use-seeded-code';
import { PrintPreviewModal, PrintRoot, PrintSelectionBar, PrintStyle, usePrintSession } from '../components/print-preview';
import { PickingPrintSheet, pickingPrintTitle } from '../components/print-sheets';
import { TABLE_PAGINATION, monoCell } from '../components/table-style';
import { useAppNav } from '../app-nav';

/**
 * 拣货单列表。拣货、关单和取消都在详情里做，列表上不能直接拣。
 * 新建：多选拣货中的出库单。打印仍在列表上。
 */
export default function PickingsPage() {
  const { message } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const [pending] = useState(() => takeInitialFilter() ?? {});
  const pendingOrderNo = pending.orderNo ?? '';
  const snapshot = useProfileSnapshot();
  const pickingOff = snapshot.data?.modules['module.picking']?.enabled === false;
  const [stateFilter, setStateFilter] = useState<'created' | 'closed' | 'canceled' | ''>('');
  const { data: pickings, isLoading } = usePickings(stateFilter || undefined);
  const { data: orders } = useOrders('out');
  const create = useCreatePicking();
  const [detailNo, setDetailNo] = useState<string | null>(pending.pickingNo ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const pickingNo = useDraftNumber(createOpen ? 'picking' : null);
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
  const openedForOrder = useRef(false);
  useEffect(() => {
    if (openedForOrder.current || !pendingOrderNo || pending.pickingNo) return;
    if (!pickingStateOrders.some((order) => order.orderNo === pendingOrderNo)) return;
    openedForOrder.current = true;
    setSelectedOrders([pendingOrderNo]);
    setCreateOpen(true);
  }, [pendingOrderNo, pickingStateOrders]);

  const stateTag = (state: string) =>
    state === 'created' ? (
      <Tag color="processing">拣货中</Tag>
    ) : state === 'closed' ? (
      <Tag color="green">已关单</Tag>
    ) : (
      <Tag>已取消</Tag>
    );

  const submitCreate = async () => {
    if (selectedOrders.length === 0) {
      message.warning('请至少选择一张「拣货中」状态的出库单');
      return;
    }
    try {
      const code = pickingNo.value.trim();
      const r = await create.mutateAsync({ orderNos: selectedOrders, ...(code ? { pickingNo: code } : {}) });
      message.success(`拣货单 ${r.pickingNo} 已创建（${r.lineCount} 行）`);
      setSelectedOrders([]);
      setCreateOpen(false);
      setDetailNo(r.pickingNo);
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
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_, r) => (
        <>
          <Button size="small" type="primary" style={{ marginRight: 8 }} onClick={() => setDetailNo(r.pickingNo)}>
            {r.state === 'created' ? '拣货' : '查看'}
          </Button>
          <Tooltip title="预览拣货单">
            <Button
              size="small"
              icon={<EyeOutlined />}
              aria-label="预览拣货单"
              onClick={() => session.openPreview([r])}
            />
          </Tooltip>
        </>
      ),
    },
  ];

  if (detailNo) {
    return <PickingDetail pickingNo={detailNo} onBack={() => setDetailNo(null)} />;
  }

  return (
    <div className="app-fill list-page" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="拣货单"
        subtitle="点进拣货单再逐行拣。一行可以拆成多桶。关单后出库单进入已拣货，再到出库单发货。"
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
          message="拣货已关闭。新的出库单直接发货。已经在拣货中的单仍可在这里做完，或在出库单上发货、取消。已经拣完的单到出库单发货。"
        />
      ) : null}
      <Card className="list-card">
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
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            拣货单号已按规则填好，可以改。留空则保存时再生成。
          </Typography.Paragraph>
          <Input
            aria-label="拣货单号"
            style={{ marginBottom: 12 }}
            placeholder="留空则按编号规则生成"
            value={pickingNo.value}
            onChange={(event) => pickingNo.onChange(event.target.value)}
          />
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
