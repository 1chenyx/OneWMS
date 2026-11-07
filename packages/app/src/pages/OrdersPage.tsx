import { useState } from 'react';
import { DownOutlined, PlusOutlined, PrinterOutlined, RollbackOutlined, VerticalAlignTopOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Dropdown, Input, InputNumber, Segmented, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProfileSnapshot } from '@one/core';
import { evalWhenCondition } from '@one/core/when';
import { useAcceptConflict, useDismissConflict, useOrderConflicts, useOrders, useProfileSnapshot, useTransitionOrder } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Order, OrderLine } from '../api/client';
import { rowsOf, totalOf, useListPage, type ListPage } from '../api/page';
import OrderFormModal from '../components/OrderFormModal';
import PutawayModal from '../components/PutawayModal';
import ReturnModal from '../components/ReturnModal';
import PageHeader from '../components/PageHeader';
import { OrderSheetPort } from '../components/sheet-specs';
import { serverPagination, monoCell, numCell, printTd, printTh } from '../components/table-style';
import { fmtQty } from '../lib/format';
import { useAppNav } from '../app-nav';

/**
 * 单据管理页——流转按钮由 Profile workflows 驱动（UI 消费配置面）：
 * 候选目标状态 = workflows[inbound|outbound].transitions.filter(from === 当前态
 * 且 when 条件满足——M21 起模块停用会掐掉其贡献的转移)。
 * 行为权威仍是服务端状态机：非法转移被 400 WMS_INVALID_TRANSITION 兜底。
 * 上架（M21）：入库单 received 态且 module.putaway 启用时出现「上架」按钮
 * （弹窗可选归位目标库位；服务端工具 wms.order.putaway 是行为权威）。
 * P1 表格规范：单号等宽列；明细收进展开行（主表只留主干）；流转按钮收进
 * Dropdown（点选目标态 → modal.confirm 二次确认——出入库动库存，不裸点）；
 * 清单按页向服务端要，单号过滤走 q。打印仍用当前页里的那张单据。
 * AI 跳转携带的 orderNo 预填过滤框（M12 步骤4，挂载时一次性消费）。
 */
export default function OrdersPage() {
  const { message, modal } = AntApp.useApp();
  const { takeInitialFilter } = useAppNav();
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all');
  const [orderNoFilter, setOrderNoFilter] = useState(() => takeInitialFilter()?.orderNo ?? '');
  const noKw = orderNoFilter.trim();
  const list = useListPage(`${direction}|${noKw}`);
  const { data: orders, isLoading } = useOrders(direction === 'all' ? undefined : direction, {
    q: noKw || undefined,
    limit: list.limit,
    offset: list.offset,
  });
  const orderPayload = orders as Order[] | ListPage<Order> | undefined;
  // 测试桩仍返回整表数组，过滤留在客户端。服务端分页时 q 已经过滤过。
  const visibleOrders = Array.isArray(orderPayload)
    ? orderPayload.filter((o) => (noKw ? o.orderNo.toLowerCase().includes(noKw.toLowerCase()) : true))
    : rowsOf(orderPayload);
  const snapshot = useProfileSnapshot();
  const transition = useTransitionOrder();
  const conflicts = useOrderConflicts();
  const acceptConflict = useAcceptConflict();
  const dismissConflict = useDismissConflict();
  const [formOpen, setFormOpen] = useState(false);
  const [putawayOrder, setPutawayOrder] = useState<Order | null>(null);
  const [returnOrder, setReturnOrder] = useState<Order | null>(null);
  /** A1 打印：正在打印的单据（非空 = 打印区已挂载，可拉起系统打印） */
  const [printOrder, setPrintOrder] = useState<Order | null>(null);

  const doTransition = async (
    orderNo: string,
    to: string,
    lines?: { skuCode: string; quantity: number; locationCode?: string; batchNo?: string }[],
  ) => {
    try {
      await transition.mutateAsync(lines ? { orderNo, to, lines } : { orderNo, to });
      message.success(`${orderNo} → ${stateLabel(snapshot.data, to)}`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `操作失败：${String(e)}`);
    }
  };

  const askTransition = (order: Order, to: string) => {
    const partial = allowsPartialQty(snapshot.data, order.direction, order.state, to);
    const draft = order.lines.map((l) => l.quantity);
    const qtyWord = order.direction === 'in' ? '实收' : '实发';
    modal.confirm({
      title: `确认流转到「${stateLabel(snapshot.data, to, order.direction)}」？`,
      width: partial ? 520 : undefined,
      content: partial ? (
        <div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            {qtyWord}可以少于订单数量，库存按这个数入账。不改则按订单数量整单入账。
          </Typography.Paragraph>
          {order.lines.map((l, i) => (
            <div key={`${l.skuCode}#${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <Typography.Text code>{l.skuCode}</Typography.Text>
              <span>订单 {fmtQty(l.quantity, l.unit)}</span>
              <InputNumber
                aria-label={`${l.skuCode} ${qtyWord}数量`}
                min={0}
                max={l.quantity}
                precision={3}
                defaultValue={l.quantity}
                onChange={(v) => {
                  draft[i] = typeof v === 'number' ? v : l.quantity;
                }}
                style={{ width: 120 }}
              />
            </div>
          ))}
        </div>
      ) : undefined,
      onOk: () => {
        if (!partial) return doTransition(order.orderNo, to);
        const lines = order.lines.map((l, i) => ({
          skuCode: l.skuCode,
          locationCode: l.locationCode,
          batchNo: l.batchNo,
          quantity: draft[i] ?? l.quantity,
        }));
        const changed = lines.some((l, i) => l.quantity !== order.lines[i]!.quantity);
        return doTransition(order.orderNo, to, changed ? lines : undefined);
      },
    });
  };

  /** 打印出入库单（A1）：先挂打印区（纸质单据含效期/批次/库位与签收栏），
   *  绘完最后一帧再拉起系统打印对话框；打完（afterprint）卸掉打印区。 */
  const doPrint = (r: Order) => {
    setPrintOrder(r);
    const cleanup = () => {
      setPrintOrder(null);
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.setTimeout(() => window.print(), 60);
  };

  const columns: ColumnsType<Order> = [
    {
      title: '单号',
      dataIndex: 'orderNo',
      key: 'orderNo',
      onCell: monoCell,
      render: (v: string, r) =>
        r.returnOfOrderNo ? (
          <span>
            {v}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                原单 {r.returnOfOrderNo}
              </Typography.Text>
            </div>
          </span>
        ) : (
          v
        ),
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      filters: [
        { text: '入库', value: 'in' },
        { text: '出库', value: 'out' },
      ],
      onFilter: (v, r) => r.direction === v,
      render: (v: Order['direction'], r) => {
        if (r.returnOfOrderNo) {
          return v === 'in' ? <Tag color="cyan">客退</Tag> : <Tag color="gold">退供</Tag>;
        }
        return (
          <span>
            {v === 'in' ? <Tag color="blue">入库</Tag> : <Tag color="orange">出库</Tag>}
            {r.replenishment ? <Tag color="purple">补货</Tag> : null}
          </span>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      render: (v: string, r) => {
        const label = stateLabel(snapshot.data, v, r.direction);
        return (
          <span>
            <Tag color={v === 'done' ? 'green' : v === 'canceled' ? 'default' : v === 'announced' ? 'gold' : 'processing'}>
              {label}
            </Tag>
            {r.expectedAt ? (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  预计 {r.expectedAt}
                </Typography.Text>
              </div>
            ) : null}
          </span>
        );
      },
    },
    {
      title: '往来单位',
      key: 'partner',
      render: (_, r) =>
        r.partnerName ? (
          <span>
            {r.partnerName}
            {r.partnerCode ? (
              <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                {r.partnerCode}
              </Typography.Text>
            ) : null}
          </span>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v ?? '-' },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      title: '打印',
      key: 'print',
      width: 64,
      render: (_, r) => (
        <Tooltip title="打印单据（A1）">
          <Button
            size="small"
            icon={<PrinterOutlined />}
            aria-label="打印单据"
            onClick={() => doPrint(r)}
          />
        </Tooltip>
      ),
    },
    {
      title: '流转',
      key: 'actions',
      width: 220,
      render: (_, r) => {
        const nexts = nextStates(snapshot.data, r.direction, r.state);
        const canPutaway =
          r.direction === 'in' && r.state === 'received' && nexts.includes('putaway');
        const showReturn = canStartReturn(snapshot.data, r);
        if (nexts.length === 0 && !showReturn) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <>
            {showReturn ? (
              <Tooltip title="按原单开退货单（module.return）。客退入库，退供出库">
                <Button
                  size="small"
                  icon={<RollbackOutlined />}
                  style={{ marginRight: 8 }}
                  onClick={() => setReturnOrder(r)}
                >
                  退货
                </Button>
              </Tooltip>
            ) : null}
            {canPutaway ? (
              <Tooltip title="确认上架，可选归位目标库位（module.putaway）">
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<VerticalAlignTopOutlined />}
                  style={{ marginRight: 8 }}
                  onClick={() => setPutawayOrder(r)}
                >
                  上架
                </Button>
              </Tooltip>
            ) : null}
            {nexts.length > 0 ? (
            <Dropdown
              trigger={['click']}
              menu={{
                items: nexts.map((to) => ({
                  key: to,
                  label: stateLabel(snapshot.data, to, r.direction),
                })),
                onClick: ({ key }) => askTransition(r, key),
              }}
            >
              <Button
                size="small"
                loading={transition.isPending && transition.variables?.orderNo === r.orderNo}
              >
                流转 <DownOutlined />
              </Button>
            </Dropdown>
            ) : null}
          </>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader
        title="出入库单"
        subtitle="单据与流转；流转按钮由配置层流程定义驱动"
        extra={
          <>
            <Segmented
              value={direction}
              onChange={(v) => setDirection(v as 'all' | 'in' | 'out')}
              options={[
                { value: 'all', label: '全部' },
                { value: 'in', label: '入库' },
                { value: 'out', label: '出库' },
              ]}
            />
            <Input
              allowClear
              placeholder="按单号过滤"
              value={orderNoFilter}
              onChange={(e) => setOrderNoFilter(e.target.value)}
              style={{ width: 180 }}
            />
            <OrderSheetPort
              labelState={(state, direction) => stateLabel(snapshot.data, state, direction)}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
              新建单据
            </Button>
          </>
        }
      />
      {(conflicts.data ?? []).length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="有单据状态冲突待裁决"
          description={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(conflicts.data ?? []).map((c) => (
                <div key={c.eventId}>
                  <Typography.Text code>{c.orderNo}</Typography.Text>
                  {` 停在 ${c.actualState}，另一条事件要改成 ${c.toState}。接受会按当前流程再走一次转移（可能动库存）；驳回则保持现状。`}
                  <Button
                    size="small"
                    type="link"
                    onClick={() =>
                      acceptConflict.mutate(c.eventId, {
                        onSuccess: () => message.success(`${c.orderNo} 已按冲突目标转移`),
                        onError: (e) => message.error(e instanceof ApiError ? e.message : String(e)),
                      })
                    }
                  >
                    接受
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    onClick={() =>
                      dismissConflict.mutate(c.eventId, {
                        onSuccess: () => message.success(`${c.orderNo} 的冲突已驳回`),
                        onError: (e) => message.error(e instanceof ApiError ? e.message : String(e)),
                      })
                    }
                  >
                    驳回
                  </Button>
                </div>
              ))}
            </div>
          }
        />
      ) : null}
      <Card>
        <Table<Order>
          rowKey="id"
          columns={columns}
          dataSource={visibleOrders}
          loading={isLoading}
          pagination={serverPagination({
            current: list.page,
            total: totalOf(orderPayload),
            onChange: list.setPage,
          })}
          locale={{ emptyText: '还没有单据' }}
          expandable={{
            rowExpandable: (r) => r.lines.length > 0,
            expandedRowRender: (r) => (
              <Table<OrderLine>
                size="small"
                rowKey={(l, i) => `${l.skuCode}#${i}`}
                columns={[
                  { title: 'SKU', dataIndex: 'skuCode', key: 'skuCode', width: 180, onCell: monoCell },
                  { title: '名称', dataIndex: 'name', key: 'name' },
                  {
                    title: '数量',
                    dataIndex: 'quantity',
                    key: 'quantity',
                    align: 'right',
                    width: 120,
                    onCell: numCell,
                    render: (v: number, l) => fmtQty(v, l.unit),
                  },
                  {
                    title: '已入账',
                    dataIndex: 'fulfilledQty',
                    key: 'fulfilledQty',
                    align: 'right',
                    width: 120,
                    onCell: numCell,
                    render: (v: number | null | undefined, l) =>
                      v == null ? (
                        <Typography.Text type="secondary">—</Typography.Text>
                      ) : (
                        fmtQty(Math.abs(v), l.unit)
                      ),
                  },
                  { title: '批次', dataIndex: 'batchNo', key: 'batchNo', width: 110, onCell: monoCell },
                  {
                    title: '目标库位',
                    dataIndex: 'locationCode',
                    key: 'locationCode',
                    width: 110,
                    onCell: monoCell,
                  },
                ]}
                dataSource={r.lines}
                pagination={false}
                style={{ maxWidth: 640 }}
              />
            ),
          }}
        />
        <OrderFormModal open={formOpen} onClose={() => setFormOpen(false)} />
        <PutawayModal open={putawayOrder !== null} order={putawayOrder} onClose={() => setPutawayOrder(null)} />
        <ReturnModal open={returnOrder !== null} order={returnOrder} onClose={() => setReturnOrder(null)} />
      </Card>

      {printOrder ? (
        <Card title={`打印预览：${printOrder.direction === 'in' ? '入库单' : '出库单'} ${printOrder.orderNo}`}>
          <div id="order-print-area" style={{ maxWidth: 720 }}>
            <Typography.Title level={4} style={{ marginTop: 0 }}>
              {printOrder.direction === 'in' ? '入库单' : '出库单'} {printOrder.orderNo}
            </Typography.Title>
            <div style={{ fontSize: 12, color: '#444', marginBottom: 8 }}>
              创建时间：{printOrder.createdAt.slice(0, 19).replace('T', ' ')}
              {printOrder.returnOfOrderNo ? `　原单号：${printOrder.returnOfOrderNo}` : ''}
              {printOrder.expectedAt ? `　预计到货：${printOrder.expectedAt}` : ''}
              {printOrder.partnerName ? `　往来单位：${printOrder.partnerName}` : ''}
              {printOrder.note ? `　备注：${printOrder.note}` : ''}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={printTh}>SKU</th>
                  <th style={printTh}>名称</th>
                  <th style={printTh}>数量</th>
                  <th style={printTh}>批次</th>
                  {printOrder.direction === 'in' ? <th style={printTh}>效期</th> : null}
                  <th style={printTh}>{printOrder.direction === 'in' ? '目标库位' : '库位'}</th>
                </tr>
              </thead>
              <tbody>
                {printOrder.lines.map((l, i) => (
                  <tr key={`${l.skuCode}#${i}`}>
                    <td style={printTd}>{l.skuCode}</td>
                    <td style={printTd}>{l.name}</td>
                    <td style={{ ...printTd, textAlign: 'right' }}>{fmtQty(l.quantity, l.unit)}</td>
                    <td style={printTd}>{l.batchNo ?? '-'}</td>
                    {printOrder.direction === 'in' ? (
                      <td style={printTd}>{l.batchExpiryDate ?? '-'}</td>
                    ) : null}
                    <td style={printTd}>{l.locationCode ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 32, fontSize: 12 }}>签收人签字：______________　　日期：______________</div>
          </div>
        </Card>
      ) : null}

      {/* 打印样式：只让单据可见，其余（侧边栏/工具条/卡片边框）全部隐藏 */}
      <style>{`
        @media print {
          @page { margin: 12mm; }
          body * { visibility: hidden !important; }
          #order-print-area, #order-print-area * { visibility: visible !important; }
          #order-print-area { position: absolute !important; left: 0; top: 0; width: 100%; }
          #order-print-area tr { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}

/** 方向 → workflow id（Profile 种子约定） */
const WORKFLOW_BY_DIRECTION = { in: 'inbound', out: 'outbound' } as const;

/** 状态中文标签：优先读 Profile workflows 的 states（配置驱动），缺失时退回原文 */
function stateLabel(snapshot: ProfileSnapshot | undefined, state: string, direction?: Order['direction']): string {
  if (snapshot && direction) {
    const wf = snapshot.workflows[WORKFLOW_BY_DIRECTION[direction]];
    const hit = wf?.states.find((s) => s.id === state);
    if (hit) return hit.label;
  }
  // 方向未知（如目标态提示）：两个 workflow 都找一遍
  for (const wf of Object.values(snapshot?.workflows ?? {})) {
    const hit = wf.states.find((s) => s.id === state);
    if (hit) return hit.label;
  }
  return state;
}

/** 这次转移可以改实收/实发：模块开着，且这条边是入库加账或出库减账，不是冲销 */
function allowsPartialQty(
  snapshot: ProfileSnapshot | undefined,
  direction: Order['direction'],
  from: string,
  to: string,
): boolean {
  if (snapshot?.modules['module.partial']?.enabled !== true) return false;
  const wf = snapshot.workflows[WORKFLOW_BY_DIRECTION[direction]];
  const edge = wf?.transitions.find((t) => t.from === from && t.to === to);
  if (edge?.effect === 'check' || edge?.effect === 'none') return false;
  if (direction === 'in') {
    if (edge?.effect === 'decrease') return false;
    if (edge?.effect === 'increase') return true;
    return to === settingState(snapshot, 'inboundIncreaseState', 'received');
  }
  if (edge?.effect === 'increase') return false;
  if (edge?.effect === 'decrease') return true;
  return to === settingState(snapshot, 'outboundDecreaseState', 'shipped');
}

/** 已入账、且本身不是退货单时，可以按原单开退货。完成态没有下一步也仍然显示。 */
function canStartReturn(snapshot: ProfileSnapshot | undefined, order: Order): boolean {
  if (snapshot?.modules['module.return']?.enabled !== true) return false;
  if (order.returnOfOrderNo) return false;
  if (order.direction === 'out') return order.state === 'shipped' || order.state === 'done';
  return order.state === 'received' || order.state === 'putaway' || order.state === 'done';
}

function settingState(snapshot: ProfileSnapshot, key: string, fallback: string): string {
  const raw = snapshot.modules['core.wms']?.settings?.[key];
  return typeof raw === 'string' && raw.trim() ? raw : fallback;
}

/** 候选目标状态（去重）：when 与 @one/core/when 同一实现，停用模块即不展示其转移 */
function nextStates(snapshot: ProfileSnapshot | undefined, direction: Order['direction'], state: string): string[] {
  const wf = snapshot?.workflows[WORKFLOW_BY_DIRECTION[direction]];
  if (!wf) return [];
  return [
    ...new Set(
      wf.transitions
        .filter((t) => t.from === state && evalWhenCondition(t.when, snapshot?.modules ?? {}))
        .map((t) => t.to),
    ),
  ];
}
