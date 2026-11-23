import { useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Progress, Space, Table, Tag, Typography } from 'antd';
import type { StocktakeLine } from '../../api/client';
import { ApiError } from '../../api/client';
import { useCountStocktake, useStocktakeDetail } from '../../api/hooks';
import { fmtQty } from '../../lib/format';
import { ResultBanner, ScanStep, StepBar, scenarioById, useBeeper, useScannedSku, useScenarioSettings } from './shared';

interface Banner {
  kind: 'success' | 'error' | 'info';
  text: string;
}

const DEF = scenarioById('stocktake');

/**
 * 盘点场景：扫盘点单 → 扫库位 → 盲录实盘数量。
 *
 * 「盲录」是纪律不是缺陷：这一屏不显示账面量与预期量，只显示「盘了没盘」。
 * 现场照着实物数、录进去，差异留给关单时的对账。看到账面数再数，数出来的就是账面数。
 */
export default function StocktakeScenario() {
  const { feedbackSound } = useScenarioSettings();
  const beep = useBeeper(feedbackSound);
  const [no, setNo] = useState<string | null>(null);
  const [locationCode, setLocationCode] = useState<string | null>(null);
  const [scanned, setScanned] = useState<string | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const detailQ = useStocktakeDetail(no);
  const skuQ = useScannedSku(scanned);
  const count = useCountStocktake();

  const detail = detailQ.data;
  const allLines = detail?.lines ?? [];

  /** 这个位上该盘的货（盲录：只带 SKU 与批次，不带账面数） */
  const lines = useMemo(
    () =>
      locationCode
        ? allLines.filter((l) => l.locationCode.toLowerCase() === locationCode.toLowerCase())
        : [],
    [allLines, locationCode],
  );
  const knownLocation = allLines.some((l) => l.locationCode.toLowerCase() === (locationCode ?? '').toLowerCase());
  const target = lines.find((l) => l.skuCode === skuQ.data?.skuCode) ?? null;
  const countedCount = allLines.filter((l) => l.countedQty !== null).length;

  // 扫错货 / 条码查无此货：响一声退回扫货步
  useEffect(() => {
    if (!scanned || skuQ.isPending || target) return;
    setBanner({
      kind: 'error',
      text: skuQ.data ? `${skuQ.data.skuCode} 不在这一位的盘点范围里` : `查不到这个条码：${scanned}`,
    });
    beep(false);
    setScanned(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned, skuQ.isPending, skuQ.data, target]);

  const onScanLocation = (v: string) => {
    const code = v.trim();
    if (!allLines.some((l) => l.locationCode.toLowerCase() === code.toLowerCase())) {
      setBanner({ kind: 'error', text: `${code} 不在这张盘点单的范围里` });
      beep(false);
      return;
    }
    setBanner(null);
    setLocationCode(code);
    setScanned(null);
    setQty(null);
    beep(true);
  };

  const confirm = async () => {
    if (!detail || !target || qty == null) return;
    try {
      const r = await count.mutateAsync({
        no: detail.stocktakeNo,
        body: {
          skuCode: target.skuCode,
          locationCode: target.locationCode,
          batchNo: target.batchNo,
          countedQty: qty,
        },
      });
      setBanner({ kind: 'success', text: `${target.skuCode} 实盘已记 ${fmtQty(r.countedQty)}` });
      beep(true);
      setScanned(null);
      setQty(null);
    } catch (e) {
      setBanner({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      beep(false);
    }
  };

  const reset = () => {
    setNo(null);
    setLocationCode(null);
    setScanned(null);
    setQty(null);
    setBanner(null);
  };

  const step = !detail ? 0 : !knownLocation ? 1 : 2;

  return (
    <div>
      <StepBar steps={DEF.steps} active={step} />
      <ScanStep
        label="扫盘点单号"
        placeholder="ST-…"
        onScan={(v) => {
          setBanner(null);
          setLocationCode(null);
          setScanned(null);
          setQty(null);
          setNo(v.trim());
        }}
      />
      {detailQ.isError ? <ResultBanner kind="error" text={`查不到这张盘点单：${no}`} /> : null}

      {detail ? (
        <>
          <Space style={{ marginBottom: 8 }} wrap>
            <Tag>{detail.stocktakeNo}</Tag>
            <Tag color={detail.state === 'created' ? 'green' : 'orange'}>{detail.state}</Tag>
            <Typography.Text type="secondary">
              范围：{Array.isArray(detail.scope) ? detail.scope.join('、') : detail.scope}
            </Typography.Text>
          </Space>
          <Progress
            percent={allLines.length ? Math.round((countedCount / allLines.length) * 100) : 0}
            size="small"
            format={() => `${countedCount}/${allLines.length}`}
            style={{ marginBottom: 12 }}
          />

          <ScanStep label="扫库位" placeholder="A-01-02" onScan={onScanLocation} />

          {knownLocation ? (
            <>
              <ScanStep label="扫 SKU 条码" placeholder="扫货物条码" onScan={(v) => { setBanner(null); setScanned(v.trim()); setQty(null); }} />
              {target ? (
                <Space style={{ marginBottom: 12 }} align="center">
                  <Typography.Text strong>
                    {target.skuCode} {target.name}
                  </Typography.Text>
                  {target.batchNo ? <Tag>{target.batchNo}</Tag> : null}
                  <InputNumber
                    size="large"
                    min={0}
                    value={qty}
                    onChange={(v) => setQty(v)}
                    placeholder="实盘数量"
                    style={{ width: 130 }}
                    autoFocus
                  />
                  <Button type="primary" size="large" disabled={qty == null} loading={count.isPending} onClick={confirm}>
                    记实盘
                  </Button>
                </Space>
              ) : null}

              <Table<StocktakeLine>
                size="small"
                rowKey={(l) => `${l.skuCode}:${l.batchNo}`}
                pagination={false}
                dataSource={lines}
                columns={[
                  { title: 'SKU', dataIndex: 'skuCode' },
                  { title: '名称', dataIndex: 'name', ellipsis: true },
                  { title: '批次', dataIndex: 'batchNo', width: 120, render: (v: string) => v || <Tag>默认</Tag> },
                  {
                    title: '盘了没',
                    width: 110,
                    render: (_: unknown, l: StocktakeLine) =>
                      l.countedQty !== null ? <Tag color="green">已盘</Tag> : <Tag>未盘</Tag>,
                  },
                ]}
              />
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                盲录：这一屏不显示账面量。差异在关单对账时才算。
              </Typography.Text>
            </>
          ) : null}

          <Space style={{ marginTop: 16 }}>
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
