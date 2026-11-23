import { useEffect, useState } from 'react';
import { Button, InputNumber, Space, Tag, Typography } from 'antd';
import { ApiError } from '../../api/client';
import { useMoveInventory } from '../../api/hooks';
import { fmtQty } from '../../lib/format';
import { ResultBanner, ScanStep, StepBar, scenarioById, useBeeper, useScannedSku, useScenarioSettings } from './shared';

interface Banner {
  kind: 'success' | 'error' | 'info';
  text: string;
}

const DEF = scenarioById('move');

/**
 * 移库场景：扫源库位 → 扫货 → 录数量 → 扫目标库位 → 确认。
 *
 * 走 wms.inventory.move：改的是桶的库位归属，实物总量不变，账上落一对
 * transfer 流水（源位 −N、目标位 +N）。批次不填 = 该 SKU 在这个位上唯一有量的批次，
 * 多批次必须指名——这一层判断留给工具，前端不猜。
 */
export default function MoveScenario() {
  const { feedbackSound } = useScenarioSettings();
  const beep = useBeeper(feedbackSound);
  const [fromCode, setFromCode] = useState<string | null>(null);
  const [scanned, setScanned] = useState<string | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [toCode, setToCode] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const skuQ = useScannedSku(scanned);
  const move = useMoveInventory();

  const sku = skuQ.data;

  // 条码查无此货：响一声退回扫货步
  useEffect(() => {
    if (!scanned || skuQ.isPending || sku) return;
    setBanner({ kind: 'error', text: `查不到这个条码：${scanned}` });
    beep(false);
    setScanned(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned, skuQ.isPending, sku]);

  const reset = () => {
    setFromCode(null);
    setScanned(null);
    setQty(null);
    setToCode(null);
    setBanner(null);
  };

  const confirm = async () => {
    if (!sku || qty == null || !toCode) return;
    try {
      const r = await move.mutateAsync({
        skuCode: sku.skuCode,
        quantity: qty,
        fromLocationCode: fromCode ?? undefined,
        toLocationCode: toCode,
      });
      setBanner({
        kind: 'success',
        text: `${r.skuCode} × ${fmtQty(r.quantity)}：${r.fromLocationCode} → ${r.toLocationCode}（批次 ${r.batchNo}）`,
      });
      beep(true);
      setScanned(null);
      setQty(null);
      setToCode(null);
    } catch (e) {
      setBanner({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      beep(false);
    }
  };

  const step = !fromCode ? 0 : !sku ? 1 : qty == null ? 2 : 3;

  return (
    <div>
      <StepBar steps={DEF.steps} active={step} />

      <ScanStep
        label="扫源库位（货现在在哪；不扫 = 该 SKU 唯一有量的位）"
        placeholder="A-01-02"
        onScan={(v) => {
          setBanner(null);
          setScanned(null);
          setQty(null);
          setToCode(null);
          setFromCode(v.trim());
        }}
      />
      {fromCode ? <Tag color="blue">源位：{fromCode}</Tag> : null}

      <ScanStep
        label="扫 SKU 条码"
        placeholder="扫货物条码"
        onScan={(v) => {
          setBanner(null);
          setScanned(v.trim());
          setQty(null);
          setToCode(null);
        }}
      />

      {sku ? (
        <Space style={{ marginBottom: 12 }} align="center" wrap>
          <Typography.Text strong>
            {sku.skuCode} {sku.name}
          </Typography.Text>
          <InputNumber
            size="large"
            min={0}
            value={qty}
            onChange={(v) => setQty(v)}
            placeholder="数量"
            style={{ width: 120 }}
            autoFocus
          />
        </Space>
      ) : null}

      {sku && qty != null ? (
        <ScanStep
          label="扫目标库位"
          placeholder="B-03-01"
          onScan={(v) => {
            setBanner(null);
            setToCode(v.trim());
          }}
        />
      ) : null}
      {toCode ? <Tag color="green">目标位：{toCode}</Tag> : null}

      <Space style={{ marginTop: 16 }}>
        <Button
          type="primary"
          size="large"
          disabled={!sku || qty == null || !toCode}
          loading={move.isPending}
          onClick={confirm}
        >
          确认移库
        </Button>
        <Button size="large" onClick={reset}>
          清空重来
        </Button>
      </Space>

      {banner ? <ResultBanner kind={banner.kind} text={banner.text} /> : null}
    </div>
  );
}
