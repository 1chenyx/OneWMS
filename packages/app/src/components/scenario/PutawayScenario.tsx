import { useState } from 'react';
import { Button, Space, Table, Tag, Typography } from 'antd';
import { ApiError } from '../../api/client';
import { useOrderDetail, usePutawayOrder } from '../../api/hooks';
import { fmtQty } from '../../lib/format';
import { ResultBanner, ScanStep, StepBar, scenarioById, useBeeper, useScenarioSettings } from './shared';

interface Banner {
  kind: 'success' | 'error' | 'info';
  text: string;
}

const DEF = scenarioById('putaway');

/**
 * 上架场景：扫单 → 扫目标库位 → 确认上架。
 *
 * 现场最常见的形态是「一车货全归到一个位」，所以扫到的库位对整单生效；
 * 要一行分几个位、或按 SKU 拆桶，用上架页的分行分配。
 * 行上已经写了目标库位的（收货时指过位）保持原样，不被这一扫覆盖。
 */
export default function PutawayScenario() {
  const { feedbackSound } = useScenarioSettings();
  const beep = useBeeper(feedbackSound);
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [locationCode, setLocationCode] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const orderQ = useOrderDetail(orderNo);
  const putaway = usePutawayOrder();

  const order = orderQ.data;
  const lines = order?.lines ?? [];
  const ready = order?.direction === 'in' && order?.state === 'received';

  const reset = () => {
    setOrderNo(null);
    setLocationCode(null);
    setBanner(null);
  };

  const confirm = async () => {
    if (!order) return;
    const targets = locationCode
      ? lines.map((l) => ({
          skuCode: l.skuCode,
          batchNo: l.batchNo,
          toLocationCode: l.locationCode || locationCode,
        }))
      : undefined;
    try {
      const r = await putaway.mutateAsync({ orderNo: order.orderNo, targets });
      const moved = r.movedLines?.length ?? 0;
      setBanner({
        kind: 'success',
        text: moved > 0 ? `${r.orderNo} 已上架，归位 ${moved} 处` : `${r.orderNo} 已上架，货留在收货库位`,
      });
      beep(true);
      if (r.warning) beep(false);
    } catch (e) {
      setBanner({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      beep(false);
    }
  };

  const step = !order ? 0 : !locationCode ? 1 : 2;

  return (
    <div>
      <StepBar steps={DEF.steps} active={step} />
      <ScanStep
        label="扫入库单号"
        placeholder="IN-…（已收货的单）"
        onScan={(v) => {
          setBanner(null);
          setLocationCode(null);
          setOrderNo(v.trim());
        }}
      />
      {orderQ.isError ? <ResultBanner kind="error" text={`查不到这张单：${orderNo}`} /> : null}

      {order ? (
        <>
          <Space style={{ marginBottom: 8 }} wrap>
            <Tag>{order.orderNo}</Tag>
            <Tag color={ready ? 'green' : 'orange'}>{order.state}</Tag>
            {!ready ? <Typography.Text type="warning">只有已收货的入库单能上架</Typography.Text> : null}
          </Space>

          <ScanStep
            label="扫目标库位（整单归到这一个位；不扫则按行上已写的目标）"
            placeholder="A-01-02 或扫托盘号"
            onScan={(v) => {
              setBanner(null);
              setLocationCode(v.trim());
            }}
          />
          {locationCode ? <Tag color="blue">目标：{locationCode}</Tag> : null}

          <Table
            size="small"
            rowKey={(_: unknown, i?: number) => String(i)}
            pagination={false}
            dataSource={lines}
            columns={[
              { title: 'SKU', dataIndex: 'skuCode' },
              { title: '名称', dataIndex: 'name', ellipsis: true },
              { title: '批次', dataIndex: 'batchNo', width: 120, render: (v?: string) => v || <Tag>默认</Tag> },
              { title: '数量', dataIndex: 'quantity', width: 90, render: (v: number) => fmtQty(v) },
              {
                title: '归到',
                width: 130,
                render: (_: unknown, l: (typeof lines)[number]) => l.locationCode || locationCode || <Tag>收货库位</Tag>,
              },
            ]}
          />

          <Space style={{ marginTop: 16 }}>
            <Button type="primary" size="large" disabled={!ready} loading={putaway.isPending} onClick={confirm}>
              确认上架
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
