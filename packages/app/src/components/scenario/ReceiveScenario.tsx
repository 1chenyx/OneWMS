import { useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Space, Table, Tag, Typography } from 'antd';
import { ApiError } from '../../api/client';
import { useOrderDetail, useTransitionOrder } from '../../api/hooks';
import { fmtQty } from '../../lib/format';
import { ResultBanner, ScanStep, StepBar, scenarioById, useBeeper, useScannedSku, useScenarioSettings } from './shared';

interface Banner {
  kind: 'success' | 'error' | 'info';
  text: string;
}

const DEF = scenarioById('receive');

/** 一行还剩多少没收（null = 从没记过短收，按订单数量） */
function remaining(qty: number, fulfilled: number | null | undefined): number {
  return fulfilled == null ? qty : Math.max(0, qty - fulfilled);
}

/**
 * 收货场景：扫单 → 扫货 → 录数量 → 确认收货。
 *
 * 扫到的行记实收量，没扫的行按「订单数量 − 已入账」补齐一起交上去——
 * 一次确认就是整张单的收货结果，与表单页/AI 走同一个 wms.order.transition。
 * 超收在本地先拦（扫到的量 > 本行剩余），工具的守卫是第二道。
 */
export default function ReceiveScenario() {
  const { feedbackSound } = useScenarioSettings();
  const beep = useBeeper(feedbackSound);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [scanned, setScanned] = useState<string | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [banner, setBanner] = useState<Banner | null>(null);

  const orderQ = useOrderDetail(orderNo);
  const skuQ = useScannedSku(scanned);
  const receive = useTransitionOrder();

  const order = orderQ.data;
  const lines = order?.lines ?? [];
  const isReceiveState = order?.state === 'created' || order?.state === 'qc_passed';

  /** 本行待收量：已扫过的用扫到的量，没扫过的按剩余补 */
  const effective = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of lines) {
      const rest = remaining(l.quantity, l.fulfilledQty);
      map[l.skuCode] = counts[l.skuCode] ?? rest;
    }
    return map;
  }, [lines, counts]);

  const scannedLine = lines.find((l) => l.skuCode === skuQ.data?.skuCode);
  const scannedRest = scannedLine ? remaining(scannedLine.quantity, scannedLine.fulfilledQty) : 0;

  // 扫到的货对不上这张单（或条码查无此货）：当场说清楚并退回扫码步。
  // 放副作用里而不是渲染中——渲染期 setState 会打乱 React 的提交顺序。
  useEffect(() => {
    if (!scanned || skuQ.isPending) return;
    if (skuQ.data && scannedLine) return;
    const text = !skuQ.data
      ? `查不到这个条码：${scanned}`
      : `${skuQ.data.skuCode} 不在 ${order?.orderNo ?? '这张单'} 上`;
    setBanner({ kind: 'error', text });
    beep(false);
    setScanned(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned, skuQ.isPending, skuQ.data, scannedLine?.skuCode]);

  const reset = () => {
    setOrderNo(null);
    setScanned(null);
    setQty(null);
    setCounts({});
    setBanner(null);
  };

  const onScanOrder = (v: string) => {
    setBanner(null);
    setScanned(null);
    setQty(null);
    setCounts({});
    setOrderNo(v.trim());
  };

  const onScanSku = (v: string) => {
    setBanner(null);
    setScanned(v.trim());
    setQty(null);
  };

  const addCount = () => {
    if (!scannedLine || qty == null) return;
    if (qty > scannedRest) {
      setBanner({ kind: 'error', text: `超收：${scannedLine.skuCode} 本行只剩 ${fmtQty(scannedRest)}` });
      beep(false);
      return;
    }
    setCounts((prev) => ({ ...prev, [scannedLine.skuCode]: qty }));
    setBanner({ kind: 'success', text: `已记 ${scannedLine.skuCode} × ${fmtQty(qty)}` });
    beep(true);
    setScanned(null);
    setQty(null);
  };

  const confirm = async () => {
    if (!order) return;
    try {
      const r = await receive.mutateAsync({
        orderNo: order.orderNo,
        to: 'received',
        lines: lines.map((l) => ({ skuCode: l.skuCode, quantity: effective[l.skuCode] })),
      });
      setBanner({ kind: 'success', text: `${r.orderNo} 已收货（${r.from} → ${r.to}）` });
      beep(true);
      setCounts({});
      setScanned(null);
      setQty(null);
    } catch (e) {
      setBanner({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      beep(false);
    }
  };

  const step = !order ? 0 : !scannedLine ? 1 : qty == null ? 2 : 3;

  return (
    <div>
      <StepBar steps={DEF.steps} active={step} />
      <ScanStep label="扫入库单号" onScan={onScanOrder} placeholder="IN-… 或扫单据条码" />
      {orderQ.isError ? (
        <ResultBanner kind="error" text={`查不到这张单：${orderNo}`} />
      ) : null}

      {order ? (
        <>
          <Space style={{ marginBottom: 8 }} wrap>
            <Tag>{order.orderNo}</Tag>
            <Tag color={isReceiveState ? 'green' : 'orange'}>{order.state}</Tag>
            {order.partnerName ? <Tag color="blue">{order.partnerName}</Tag> : null}
            {!isReceiveState ? <Typography.Text type="warning">这张单当前状态不能收货</Typography.Text> : null}
          </Space>

          <ScanStep label="扫 SKU 条码" onScan={onScanSku} placeholder="扫货物条码或输入 SKU 编码" />

          {scannedLine ? (
            <Space style={{ marginBottom: 12 }} align="center">
              <Typography.Text strong>
                {scannedLine.skuCode} {scannedLine.name}
              </Typography.Text>
              <Typography.Text type="secondary">
                应收 {fmtQty(scannedLine.quantity)} / 剩余 {fmtQty(scannedRest)}
              </Typography.Text>
              <InputNumber
                size="large"
                min={0}
                max={scannedRest}
                value={qty}
                onChange={(v) => setQty(v)}
                placeholder="数量"
                style={{ width: 120 }}
                autoFocus
              />
              <Button type="primary" size="large" disabled={qty == null} onClick={addCount}>
                记一行
              </Button>
            </Space>
          ) : null}

          <Table
            size="small"
            rowKey="skuCode"
            pagination={false}
            dataSource={lines}
            columns={[
              { title: 'SKU', dataIndex: 'skuCode' },
              { title: '名称', dataIndex: 'name', ellipsis: true },
              { title: '订单量', dataIndex: 'quantity', width: 100, render: (v: number) => fmtQty(v) },
              {
                title: '本次实收',
                width: 120,
                render: (_: unknown, l: (typeof lines)[number]) =>
                  counts[l.skuCode] != null ? (
                    <Tag color="green">{fmtQty(counts[l.skuCode])}</Tag>
                  ) : (
                    <Tag>{fmtQty(effective[l.skuCode])}</Tag>
                  ),
              },
            ]}
          />

          <Space style={{ marginTop: 16 }}>
            <Button type="primary" size="large" disabled={!isReceiveState} loading={receive.isPending} onClick={confirm}>
              确认收货
            </Button>
            <Button size="large" onClick={reset}>
              换一张单
            </Button>
          </Space>
        </>
      ) : null}

      {banner ? <ResultBanner kind={banner.kind} text={banner.text} /> : null}
    </div>
  );
}
