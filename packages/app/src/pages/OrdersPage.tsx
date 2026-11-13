import { useEffect, useState } from 'react';
import { DownOutlined, PlusOutlined, RollbackOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Dropdown, Input, InputNumber, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProfileSnapshot } from '@one/core';
import { evalWhenCondition } from '@one/core/when';
import { useAcceptConflict, useDismissConflict, useOrderConflicts, useOrders, useProfileSnapshot, useTransitionOrder } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Order } from '../api/client';
import { rowsOf, totalOf, useListPage, type ListPage } from '../api/page';
import OrderDetailDrawer from '../components/OrderDetailDrawer';
import ReturnModal from '../components/ReturnModal';
import PageHeader from '../components/PageHeader';
import { OrderSheetPort } from '../components/sheet-specs';
import { PrintRoot, PrintSelectionBar, PrintStyle, usePrintSession } from '../components/print-preview';
import { OrderPrintSheet } from '../components/print-sheets';
import { serverPagination, monoCell } from '../components/table-style';
import { fmtQty } from '../lib/format';
import { useAppNav } from '../app-nav';
import OrderCreatePage from './OrderCreatePage';

/**
 * 单据管理页——流转按钮由 Profile workflows 驱动（UI 消费配置面）：
 * 候选目标状态 = workflows[inbound|outbound].transitions.filter(from === 当前态
 * 且 when 条件满足——M21 起模块停用会掐掉其贡献的转移)。
 * 行为权威仍是服务端状态机：非法转移被 400 WMS_INVALID_TRANSITION 兜底。
 * 质检、上架打开时，已收货不能在这里跳过，到质检页和上架页做。
 * 波次、拣货、打包、装车打开时，出库单按这个顺序做，发货仍回到这张单。
 * P1 表格规范：单号等宽列；明细在详情里看，主表只留主干；流转按钮收进
 * Dropdown（点选目标态 → modal.confirm 二次确认——出入库动库存，不裸点）。
 * 通向已取消的边不进流转菜单，单独放「取消」：开错的单停在已取消，单号保留。
 * 清单按页向服务端要，单号过滤走 q。点单号或「详情」打开抽屉。
 * 详情只看单据。右上角「打印预览」再看纸样。勾选当前页可以一次打出多页，不经过预览。
 * 「新建单据」离开清单，打开整页开单。入库页和出库页各开各的，方向在进页时已经定了。
 * AI 跳转携带的 orderNo 预填过滤框（M12 步骤4，挂载时一次性消费）。
 */
export default function OrdersPage({ direction }: { direction: 'in' | 'out' }) {
  const { message, modal } = AntApp.useApp();
  const { takeInitialFilter, navigate } = useAppNav();
  const [orderNoFilter, setOrderNoFilter] = useState(() => takeInitialFilter()?.orderNo ?? '');
  const noKw = orderNoFilter.trim();
  const list = useListPage(`${direction}|${noKw}`);
  const { data: orders, isLoading } = useOrders(direction, {
    q: noKw || undefined,
    limit: list.limit,
    offset: list.offset,
  });
  const orderPayload = orders as Order[] | ListPage<Order> | undefined;
  // 测试桩仍返回整表数组，过滤留在客户端。服务端分页时 q 已经过滤过。
  const visibleOrders = (
    Array.isArray(orderPayload)
      ? orderPayload.filter((o) => (noKw ? o.orderNo.toLowerCase().includes(noKw.toLowerCase()) : true))
      : rowsOf(orderPayload)
  ).filter((o) => o.direction === direction);
  const snapshot = useProfileSnapshot();
  const transition = useTransitionOrder();
  const conflicts = useOrderConflicts();
  const acceptConflict = useAcceptConflict();
  const dismissConflict = useDismissConflict();
  const [creating, setCreating] = useState(false);
  const [returnOrder, setReturnOrder] = useState<Order | null>(null);
  const session = usePrintSession<Order>();
  /** 勾选范围是当前页。翻页或改筛选后清空，避免打出已经不在列表里的单。 */
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  useEffect(() => {
    setSelectedOrderIds([]);
  }, [direction, noKw, list.page]);
  const selectedOrders = visibleOrders.filter((o) => selectedOrderIds.includes(o.id));
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pinnedDetail, setPinnedDetail] = useState<Order | null>(null);
  const listedDetail = detailId ? visibleOrders.find((o) => o.id === detailId) : undefined;
  const detailOrder = listedDetail ?? (pinnedDetail?.id === detailId ? pinnedDetail : null);
  const openDetail = (order: Order) => {
    setDetailId(order.id);
    setPinnedDetail(order);
  };

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

  const askCancel = (order: Order) => {
    modal.confirm({
      title: `取消单据 ${order.orderNo}？`,
      okText: '确认取消',
      cancelText: '留下',
      okButtonProps: { danger: true },
      content: cancelExplain(snapshot.data, order),
      onOk: () => doTransition(order.orderNo, 'canceled'),
    });
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

  const goPick = (order: Order) => {
    if (order.state === 'picking') {
      navigate('pickings', { orderNo: order.orderNo });
      return;
    }
    modal.confirm({
      title: `把 ${order.orderNo} 转入拣货？`,
      content: '转入后打开拣货单。拣货在详情里做。关单后这张单进入已拣货，再回来发货。',
      onOk: async () => {
        try {
          await transition.mutateAsync({ orderNo: order.orderNo, to: 'picking' });
          message.success(`${order.orderNo} → ${stateLabel(snapshot.data, 'picking', 'out')}`);
          navigate('pickings', { orderNo: order.orderNo });
        } catch (e) {
          message.error(e instanceof ApiError ? e.message : `操作失败：${String(e)}`);
        }
      },
    });
  };

  const columns: ColumnsType<Order> = [
    {
      title: '单号',
      dataIndex: 'orderNo',
      key: 'orderNo',
      onCell: monoCell,
      render: (v: string, r) => (
        <span>
          <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => openDetail(r)}>
            {v}
          </Button>
          {r.returnOfOrderNo ? (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                原单 {r.returnOfOrderNo}
              </Typography.Text>
            </div>
          ) : null}
        </span>
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
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (v: string) => v.slice(0, 19).replace('T', ' '),
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    },
    {
      title: '详情',
      key: 'detail',
      width: 72,
      render: (_, r) => (
        <Button size="small" onClick={() => openDetail(r)}>
          详情
        </Button>
      ),
    },
    {
      title: '流转',
      key: 'actions',
      width: 260,
      render: (_, r) => {
        const nexts = nextStates(snapshot.data, r.direction, r.state);
        const moduleOn = (id: string) => snapshot.data?.modules[id]?.enabled === true;
        const putawayOn = moduleOn('module.putaway');
        const pickingOn = moduleOn('module.picking');
        const qcOn = moduleOn('module.qc');
        const waveOn = moduleOn('module.wave');
        const reviewOn = moduleOn('module.review');
        const packOn = moduleOn('module.pack');
        const loadOn = moduleOn('module.load');
        const canQc = qcOn && r.direction === 'in' && r.state === 'received' && nexts.includes('inspected');
        const canPutaway = r.direction === 'in' && nexts.includes('putaway') && !(qcOn && r.state === 'received');
        const canWave = waveOn && r.direction === 'out' && r.state === 'created' && nexts.includes('waved');
        const canOpenWave = waveOn && r.direction === 'out' && r.state === 'waved';
        const canGoPick =
          pickingOn &&
          r.direction === 'out' &&
          (r.state === 'picking' ||
            (!waveOn && (r.state === 'waved' || r.state === 'created') && nexts.includes('picking')));
        const canReview =
          reviewOn && r.direction === 'out' && nexts.includes('reviewed') && !canWave && !canGoPick;
        const canPack = packOn && r.direction === 'out' && nexts.includes('packed') && !canReview;
        const canLoad = loadOn && r.direction === 'out' && nexts.includes('loaded') && !canReview && !canPack;
        const shipState = snapshot.data
          ? settingState(snapshot.data, 'outboundDecreaseState', 'shipped')
          : 'shipped';
        const canCancel = nexts.includes('canceled');
        let flowNexts = nexts.filter((to) => !['putaway', 'inspected', 'waved', 'reviewed', 'packed', 'loaded', 'canceled'].includes(to));
        if (canQc || (putawayOn && (r.state === 'received' || r.state === 'inspected'))) {
          flowNexts = flowNexts.filter((to) => to !== 'done');
        }
        if (canWave || canOpenWave || canGoPick || canReview || canPack || canLoad) {
          flowNexts = flowNexts.filter((to) => to !== 'picking' && to !== 'picked' && to !== shipState && to !== 'done');
        }
        const showReturn = canStartReturn(snapshot.data, r);
        if (
          flowNexts.length === 0 &&
          !showReturn &&
          !canPutaway &&
          !canGoPick &&
          !canQc &&
          !canWave &&
          !canOpenWave &&
          !canReview &&
          !canPack &&
          !canLoad &&
          !canCancel
        ) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
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
            {canQc ? (
              <Tooltip title="到质检页确认。开启质检后，这一步必做。">
                <Button size="small" type="primary" ghost style={{ marginRight: 8 }} onClick={() => navigate('qc', { orderNo: r.orderNo })}>
                  去质检
                </Button>
              </Tooltip>
            ) : null}
            {canPutaway ? (
              <Tooltip title="到上架页确认上架。开启上架后，这一步必做。">
                <Button
                  size="small"
                  type="primary"
                  ghost
                  style={{ marginRight: 8 }}
                  onClick={() => navigate('putaway', { orderNo: r.orderNo })}
                >
                  去上架
                </Button>
              </Tooltip>
            ) : null}
            {canWave ? (
              <Tooltip title="到波次页勾上要一起拣的单。组波后按库位把数量加总，再整波拣货。">
                <Button size="small" type="primary" ghost style={{ marginRight: 8 }} onClick={() => navigate('wave', { orderNo: r.orderNo })}>
                  去组波
                </Button>
              </Tooltip>
            ) : null}
            {canOpenWave ? (
              <Tooltip title="这张单已经在某个波次里。拣货要整波一起做。">
                <Button size="small" type="primary" ghost style={{ marginRight: 8 }} onClick={() => navigate('wave', { orderNo: r.orderNo })}>
                  看波次
                </Button>
              </Tooltip>
            ) : null}
            {canGoPick ? (
              <Tooltip
                title={
                  r.state === 'picking'
                    ? '到拣货单详情里逐行拣货。关单后这张出库单进入已拣货，再回来发货。'
                    : '转入拣货并打开拣货单。拣货在详情里做，不能直接发货或完成。'
                }
              >
                <Button
                  size="small"
                  type="primary"
                  ghost
                  style={{ marginRight: 8 }}
                  onClick={() => goPick(r)}
                >
                  去拣货
                </Button>
              </Tooltip>
            ) : null}
            {canReview ? (
              <Tooltip title="到复核页确认。开启复核后，不能直接打包、装车或发货。">
                <Button size="small" type="primary" ghost style={{ marginRight: 8 }} onClick={() => navigate('review', { orderNo: r.orderNo })}>
                  去复核
                </Button>
              </Tooltip>
            ) : null}
            {canPack ? (
              <Tooltip title="到打包页确认。开启打包后，不能直接装车或发货。">
                <Button size="small" type="primary" ghost style={{ marginRight: 8 }} onClick={() => navigate('pack', { orderNo: r.orderNo })}>
                  去打包
                </Button>
              </Tooltip>
            ) : null}
            {canLoad ? (
              <Tooltip title="到装车页确认。开启装车后，不能直接发货。">
                <Button size="small" type="primary" ghost style={{ marginRight: 8 }} onClick={() => navigate('load', { orderNo: r.orderNo })}>
                  去装车
                </Button>
              </Tooltip>
            ) : null}
            {canCancel ? (
              <Tooltip title="开错了就取消。单据留在列表里，状态改为已取消，单号不回收。">
                <Button
                  size="small"
                  danger
                  aria-label={`取消单据 ${r.orderNo}`}
                  style={{ marginRight: 8 }}
                  onClick={() => askCancel(r)}
                >
                  取消
                </Button>
              </Tooltip>
            ) : null}
            {flowNexts.length > 0 ? (
            <Dropdown
              trigger={['click']}
              menu={{
                items: flowNexts.map((to) => ({
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

  if (creating) {
    return (
      <OrderCreatePage direction={direction} onClose={() => setCreating(false)} />
    );
  }

  return (
    <div
      className="app-fill list-page"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}
    >
      <PageHeader
        title={direction === 'in' ? '入库单' : '出库单'}
        subtitle={
          direction === 'in'
            ? '收货和到货预报。开启质检、上架后，到对应页面做完，不能直接完成。'
            : '波次把多张出库单合成一波，按库位一起拣。之后是拣货、复核、打包、装车，发货仍在这里。'
        }
        extra={
          <>
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
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
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
      <Card className="list-card">
        <PrintSelectionBar count={selectedOrders.length} onPrint={() => session.printNow(selectedOrders)} />
        <Table<Order>
          rowKey="id"
          rowSelection={{
            selectedRowKeys: selectedOrders.map((o) => o.id),
            onChange: (keys) => setSelectedOrderIds(keys.map(String)),
          }}
          columns={columns}
          dataSource={visibleOrders}
          loading={isLoading}
          pagination={serverPagination({
            current: list.page,
            total: totalOf(orderPayload),
            onChange: list.setPage,
          })}
          locale={{ emptyText: '还没有单据' }}
        />
        <ReturnModal open={returnOrder !== null} order={returnOrder} onClose={() => setReturnOrder(null)} />
      </Card>

      <OrderDetailDrawer
        order={detailOrder}
        onClose={() => {
          setDetailId(null);
          setPinnedDetail(null);
        }}
        stateLabel={(state, direction) => stateLabel(snapshot.data, state, direction)}
        onPrint={(order) => session.printNow([order])}
        canCancel={detailOrder ? nextStates(snapshot.data, detailOrder.direction, detailOrder.state).includes('canceled') : false}
        onCancelOrder={detailOrder ? () => askCancel(detailOrder) : undefined}
      />
      <PrintRoot
        id="order-print-area"
        docs={session.printDocs}
        renderDoc={(order) => <OrderPrintSheet order={order} />}
      />
      <PrintStyle rootId="order-print-area" />
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

/** 取消后单据留在列表里。已入账的边按效应说明会不会回冲。 */
function cancelExplain(snapshot: ProfileSnapshot | undefined, order: Order): string {
  const wf = snapshot?.workflows[WORKFLOW_BY_DIRECTION[order.direction]];
  const edge = wf?.transitions.find(
    (t) => t.from === order.state && t.to === 'canceled' && evalWhenCondition(t.when, snapshot?.modules ?? {}),
  );
  const keep = '单据会留在列表里，状态改为已取消，单号不回收。';
  if (edge?.effect === 'decrease') return `${keep}已经入账的数量会从库存扣回。`;
  if (edge?.effect === 'increase') return `${keep}已经出库的数量会加回库存。`;
  return `${keep}库存不会变动。`;
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
  if (order.direction === 'out') return order.state === 'picked' || order.state === 'shipped' || order.state === 'done';
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

export function InboundOrdersPage() {
  return <OrdersPage direction="in" />;
}

export function OutboundOrdersPage() {
  return <OrdersPage direction="out" />;
}
