import { useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Progress, Space, Table, Tag, Typography } from 'antd';
import type { PickingLine } from '../../api/client';
import { ApiError } from '../../api/client';
import { usePickPickingLine, usePickings } from '../../api/hooks';
import { fmtQty } from '../../lib/format';
import {
  ResultBanner,
  ScanStep,
  StepBar,
  scenarioById,
  useBeeper,
  useLocationZoneMap,
  useScannedSku,
  useScenarioSettings,
} from './shared';

interface Banner {
  kind: 'success' | 'error' | 'info';
  text: string;
}

const DEF = scenarioById('pick');

/**
 * 拣选场景：扫拣货单 → 按路径逐位「扫位 → 扫货 → 录数量」。
 *
 * 路径由 settings.pickPathStrategy 定：locationCode 按库位编码排（默认），
 * pickZoneFirst 先按库区再按库位——现场走一条不回头的动线。
 * 顺序是前端排的，实拣仍按行提交给 wms.picking.pickLine，与表单页同一把尺。
 * 扫错位、扫错货当场拦下来：拣错一行的代价远大于一声提示音。
 */
export default function PickScenario() {
  const { feedbackSound, pickPathStrategy } = useScenarioSettings();
  const beep = useBeeper(feedbackSound);
  const [pickingNo, setPickingNo] = useState<string | null>(null);
  const [atLocation, setAtLocation] = useState(false);
  const [scanned, setScanned] = useState<string | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const pickingsQ = usePickings();
  const skuQ = useScannedSku(scanned);
  const zoneQ = useLocationZoneMap(pickPathStrategy === 'pickZoneFirst');
  const pick = usePickPickingLine();

  // 拣货单清单本身就带行，扫到单号在前端挑出来即可，不再多问一次服务端
  const picking = pickingNo
    ? (pickingsQ.data ?? []).find((row) => row.pickingNo === pickingNo) ?? null
    : null;
  const notFound = !!pickingNo && !picking && !pickingsQ.isPending;

  /** 作业顺序：先按路径排，未拣完的在前 */
  const walk = useMemo(() => {
    const lines = [...(picking?.lines ?? [])];
    const zoneOf = (code: string) =>
      pickPathStrategy === 'pickZoneFirst' ? (zoneQ.data?.get(code) ?? '') : '';
    lines.sort((a, b) => {
      const za = zoneOf(a.suggestedLocationCode).localeCompare(zoneOf(b.suggestedLocationCode));
      if (za !== 0) return za;
      const la = a.suggestedLocationCode.localeCompare(b.suggestedLocationCode, undefined, { numeric: true });
      if (la !== 0) return la;
      return a.skuCode.localeCompare(b.skuCode);
    });
    return lines;
  }, [picking, pickPathStrategy, zoneQ.data]);

  const current = walk.find((l) => l.pickedQty < l.qtyToPick) ?? null;
  const done = walk.length > 0 && !current;
  const scannedLine = current && skuQ.data?.skuCode === current.skuCode ? current : null;
  const remainingQty = current ? Math.max(0, current.qtyToPick - current.pickedQty) : 0;

  // 扫错货当场响一声并退回扫货步：拣错一行的代价远大于一声提示音
  useEffect(() => {
    if (!scanned || skuQ.isPending || scannedLine) return;
    setBanner({
      kind: 'error',
      text: skuQ.data ? `${skuQ.data.skuCode} 不是这一行要拣的货` : `查不到这个条码：${scanned}`,
    });
    beep(false);
    setScanned(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned, skuQ.isPending, skuQ.data, scannedLine]);

  const onScanPicking = (v: string) => {
    setBanner(null);
    setAtLocation(false);
    setScanned(null);
    setQty(null);
    setPickingNo(v.trim());
  };

  const onScanLocation = (v: string) => {
    if (!current) return;
    const ok = v.trim().toLowerCase() === current.suggestedLocationCode.toLowerCase();
    if (!ok) {
      setBanner({ kind: 'error', text: `不是这一位：该行在 ${current.suggestedLocationCode}` });
      beep(false);
      return;
    }
    setBanner(null);
    setAtLocation(true);
    beep(true);
  };

  const onScanSku = (v: string) => {
    setBanner(null);
    setScanned(v.trim());
    setQty(null);
  };

  const confirm = async () => {
    if (!picking || !current || qty == null) return;
    // 超拣在这里拦：现场只报一句「多了」，比让服务端驳回再解释一遍快
    if (qty > remainingQty) {
      setBanner({
        kind: 'error',
        text: `${current.skuCode} 实拣超过待拣（待拣 ${fmtQty(remainingQty, current.unit)}）。短发按这个量录，多的录不进来`,
      });
      beep(false);
      return;
    }
    try {
      const r = await pick.mutateAsync({
        pickingNo: picking.pickingNo,
        body: {
          orderNo: current.orderNo,
          skuCode: current.skuCode,
          suggestedBatchNo: current.suggestedBatchNo,
          pickedQty: qty,
        },
      });
      setBanner({
        kind: 'success',
        text:
          r.remainingToPick > 0
            ? `${current.skuCode} 实拣 ${fmtQty(r.pickedQty, current.unit)}，还差 ${fmtQty(r.remainingToPick, current.unit)}`
            : `${current.skuCode} 已拣满`,
      });
      beep(true);
      setAtLocation(false);
      setScanned(null);
      setQty(null);
    } catch (e) {
      setBanner({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      beep(false);
    }
  };

  const step = !picking ? 0 : !atLocation ? 1 : !scannedLine ? 2 : qty == null ? 2 : 3;
  const picked = walk.filter((l) => l.pickedQty >= l.qtyToPick).length;

  return (
    <div>
      <StepBar steps={DEF.steps} active={step} />
      <ScanStep label="扫拣货单号" placeholder="PK-…" onScan={onScanPicking} />
      {notFound ? <ResultBanner kind="error" text={`查不到这张拣货单：${pickingNo}`} /> : null}

      {picking ? (
        <>
          <Space style={{ marginBottom: 8 }} wrap>
            <Tag>{picking.pickingNo}</Tag>
            <Tag color={picking.state === 'created' ? 'green' : 'orange'}>{picking.state}</Tag>
            <Typography.Text type="secondary">
              路径：{pickPathStrategy === 'pickZoneFirst' ? '先库区后库位' : '按库位编码'}
            </Typography.Text>
          </Space>

          {current ? (
            <>
              <Progress percent={Math.round((picked / walk.length) * 100)} size="small" style={{ marginBottom: 12 }} />
              <ScanStep
                label={`第 1 步：到 ${current.suggestedLocationCode} 扫库位`}
                placeholder={current.suggestedLocationCode}
                onScan={onScanLocation}
              />
              {atLocation ? (
                <ScanStep
                  label={`第 2 步：扫 ${current.skuCode}（${current.skuName}）`}
                  placeholder="扫货物条码"
                  onScan={onScanSku}
                />
              ) : null}
              {scannedLine ? (
                <Space style={{ marginBottom: 12 }} align="center">
                  <Typography.Text strong>
                    {scannedLine.skuCode} {scannedLine.skuName}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    应拣 {fmtQty(scannedLine.qtyToPick)} / 已拣 {fmtQty(scannedLine.pickedQty)} / 待拣{' '}
                    {fmtQty(remainingQty)}
                  </Typography.Text>
                  <InputNumber
                    size="large"
                    min={0}
                    value={qty}
                    onChange={(v) => setQty(v)}
                    placeholder="实拣量"
                    style={{ width: 120 }}
                    autoFocus
                  />
                  <Button type="primary" size="large" disabled={qty == null} loading={pick.isPending} onClick={confirm}>
                    确认这一行
                  </Button>
                </Space>
              ) : null}
            </>
          ) : (
            <ResultBanner kind={done ? 'success' : 'info'} text={done ? '这张拣货单已全部拣完，去拣货页关单' : '没有待拣行'} />
          )}

          <Table<PickingLine>
            size="small"
            rowKey="id"
            pagination={false}
            style={{ marginTop: 12 }}
            dataSource={walk}
            columns={[
              { title: '顺序', width: 70, render: (_: unknown, __: PickingLine, i: number) => i + 1 },
              { title: '库位', dataIndex: 'suggestedLocationCode' },
              { title: 'SKU', dataIndex: 'skuCode' },
              { title: '名称', dataIndex: 'skuName', ellipsis: true },
              { title: '应拣', dataIndex: 'qtyToPick', width: 90, render: (v: number) => fmtQty(v) },
              {
                title: '状态',
                width: 110,
                render: (_: unknown, l: PickingLine) =>
                  l.pickedQty >= l.qtyToPick ? <Tag color="green">已拣 {fmtQty(l.pickedQty)}</Tag> : <Tag>待拣</Tag>,
              },
            ]}
          />

          <Space style={{ marginTop: 16 }}>
            <Button
              size="large"
              onClick={() => {
                setPickingNo(null);
                setAtLocation(false);
                setScanned(null);
                setQty(null);
                setBanner(null);
              }}
            >
              换一张单
            </Button>
          </Space>
        </>
      ) : null}

      {banner ? <ResultBanner kind={banner.kind} text={banner.text} /> : null}
    </div>
  );
}
