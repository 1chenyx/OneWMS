import { useEffect, useMemo, useRef, useState } from 'react';
import { PrinterOutlined, TagsOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  InputNumber,
  Select,
  Space,
  Typography,
} from 'antd';
import JsBarcode from 'jsbarcode';
import { useSkus } from '../api/hooks';
import type { Sku } from '../api/client';
import PageHeader from '../components/PageHeader';

/**
 * 条码标签页——把 SKU 档案变成能贴到货架/箱子上的标签。
 *
 * 码值规则（与扫码识别口径一致）：有条码用条码，没有条码退用 SKU 编码——
 * 自建仓库大量商品没有厂商条码，编码本身也能扫（扫码枪只是键盘输入）。
 * 码制固定 CODE128：字母数字都能编，市面扫码枪全支持。
 *
 * 打印：不用后端也不用生成 PDF——页面里放一张「标签纸」，@media print 只
 * 显示它（其余全部 visibility:hidden），交给浏览器/WebView 的打印对话框，
 * 用户在系统打印界面选标签纸尺寸即可。mm 为单位的标签尺寸保证 1:1 不缩放。
 */

/** 标签纸预设（mm）——覆盖常见的不干胶标签规格 */
const LABEL_PRESETS = [
  { key: '40x25', label: '40 × 25 mm（小号，货架位/小件）', width: 40, height: 25 },
  { key: '60x35', label: '60 × 35 mm（中号，最常用）', width: 60, height: 35 },
  { key: '80x45', label: '80 × 45 mm（大号，纸箱/整箱）', width: 80, height: 45 },
] as const;

/** 码值：条码优先，编码兜底 */
const codeValueOf = (sku: Sku) => (sku.barcode?.trim() ? sku.barcode.trim() : sku.skuCode);

export default function LabelsPage() {
  const { message } = AntApp.useApp();
  const { data: skus, isLoading } = useSkus();
  const [selected, setSelected] = useState<string[]>([]);
  const [presetKey, setPresetKey] = useState<string>(LABEL_PRESETS[1].key);
  const [columns, setColumns] = useState(3);
  const [copies, setCopies] = useState(1);
  const [showName, setShowName] = useState(true);
  const [showSkuCode, setShowSkuCode] = useState(true);
  const [showValue, setShowValue] = useState(true);
  const [showUnit, setShowUnit] = useState(false);
  const [onlyWithBarcode, setOnlyWithBarcode] = useState(false);

  const preset = LABEL_PRESETS.find((p) => p.key === presetKey) ?? LABEL_PRESETS[1];

  const options = useMemo(() => {
    const list = onlyWithBarcode ? (skus ?? []).filter((s) => s.barcode) : (skus ?? []);
    return list.map((s) => ({
      value: s.id,
      label: `${s.skuCode} · ${s.name}${s.barcode ? `（条码 ${s.barcode}）` : '（无条码，用编码）'}`,
    }));
  }, [skus, onlyWithBarcode]);

  /** 待打印清单：每个 SKU 按份数重复（重复的标签要连排，方便一张张撕） */
  const sheet = useMemo(() => {
    const byId = new Map((skus ?? []).map((s) => [s.id, s] as const));
    const out: { key: string; sku: Sku; value: string }[] = [];
    const n = Math.min(Math.max(copies, 1), 999);
    for (const id of selected) {
      const sku = byId.get(id);
      if (!sku) continue;
      for (let i = 0; i < n; i += 1) {
        out.push({ key: `${sku.id}#${i}`, sku, value: codeValueOf(sku) });
      }
    }
    return out;
  }, [selected, skus, copies]);

  const selectAllFiltered = () => setSelected((skus ?? []).filter((s) => !onlyWithBarcode || s.barcode).map((s) => s.id));

  const doPrint = () => {
    if (sheet.length === 0) {
      message.warning('先选要打印的 SKU');
      return;
    }
    // 让浏览器绘制完最后一帧再拉起打印对话框，否则可能打出空白页
    window.setTimeout(() => window.print(), 60);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0, overflow: 'auto' }}>
      <PageHeader
        title="条码标签"
        subtitle="选 SKU → 挑标签纸规格 → 打印。有条码打条码，没条码打 SKU 编码（都能扫）"
        extra={
          <Button type="primary" icon={<PrinterOutlined />} disabled={sheet.length === 0} onClick={doPrint}>
            打印 {sheet.length > 0 ? `${sheet.length} 张` : ''}
          </Button>
        }
      />

      <Card title={<><TagsOutlined /> 选择与版式</>}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={8}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="选择 SKU（可多选、可搜索）"
              style={{ minWidth: 420, maxWidth: '100%' }}
              value={selected}
              onChange={setSelected}
              options={options}
              loading={isLoading}
              maxTagCount="responsive"
              allowClear
            />
            <Button size="small" onClick={selectAllFiltered}>全选当前列表</Button>
            <Checkbox checked={onlyWithBarcode} onChange={(e) => setOnlyWithBarcode(e.target.checked)}>
              只看有条码的
            </Checkbox>
          </Space>

          <Space wrap size={16}>
            <Space size={6}>
              <Typography.Text type="secondary">标签纸</Typography.Text>
              <Select
                style={{ width: 280 }}
                value={presetKey}
                onChange={setPresetKey}
                options={LABEL_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
              />
            </Space>
            <Space size={6}>
              <Typography.Text type="secondary">每行</Typography.Text>
              <InputNumber min={1} max={6} precision={0} value={columns} onChange={(v) => setColumns(v ?? 3)} style={{ width: 70 }} />
              <Typography.Text type="secondary">张</Typography.Text>
            </Space>
            <Space size={6}>
              <Typography.Text type="secondary">每个 SKU</Typography.Text>
              <InputNumber min={1} max={999} precision={0} value={copies} onChange={(v) => setCopies(v ?? 1)} style={{ width: 80 }} />
              <Typography.Text type="secondary">份</Typography.Text>
            </Space>
          </Space>

          <Space wrap size={16}>
            <Typography.Text type="secondary">标签上印什么：</Typography.Text>
            <Checkbox checked={showValue} onChange={(e) => setShowValue(e.target.checked)}>条码数字</Checkbox>
            <Checkbox checked={showSkuCode} onChange={(e) => setShowSkuCode(e.target.checked)}>SKU 编码</Checkbox>
            <Checkbox checked={showName} onChange={(e) => setShowName(e.target.checked)}>商品名称</Checkbox>
            <Checkbox checked={showUnit} onChange={(e) => setShowUnit(e.target.checked)}>单位（有设置的才印）</Checkbox>
          </Space>

          <Alert
            type="info"
            showIcon
            message="打印设置"
            description={
              <>
                点「打印」后在系统打印对话框里：纸张按你的标签纸选（或选 A4 先试排）、
                <Typography.Text strong>缩放必须选「实际大小 / 100%」</Typography.Text>
                ——一旦选「适应页面」标签尺寸就不是 1:1，贴上去会对不齐。
              </>
            }
          />
        </Space>
      </Card>

      <Card title={`预览（${sheet.length} 张 · ${preset.width}×${preset.height} mm）`}>
        {sheet.length === 0 ? (
          <Typography.Text type="secondary">还没有选 SKU——上面选完这里就出预览</Typography.Text>
        ) : (
          <div id="label-print-area">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, ${preset.width}mm)`,
                gap: 0,
              }}
            >
              {sheet.map((item) => (
                <Label
                  key={item.key}
                  value={item.value}
                  sku={item.sku}
                  widthMm={preset.width}
                  heightMm={preset.height}
                  showName={showName}
                  showSkuCode={showSkuCode}
                  showValue={showValue}
                  showUnit={showUnit}
                />
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* 打印样式：只让标签纸可见，其余（侧边栏/工具条/卡片边框）全部隐藏 */}
      <style>{`
        @media print {
          @page { margin: 6mm; }
          body * { visibility: hidden !important; }
          #label-print-area, #label-print-area * { visibility: visible !important; }
          #label-print-area { position: absolute !important; left: 0; top: 0; width: 100%; }
          #label-print-area .label-cell { border: none !important; page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}

/**
 * 单张标签：固定 mm 尺寸（打印 1:1），条码用 SVG 矢量渲染——位图放大会糊，
 * 矢量不会。JsBarcode 对编不了的字符会抛异常，这里兜住并显式报错，
 * 而不是打出一排空白标签让人白贴。
 */
function Label({
  value,
  sku,
  widthMm,
  heightMm,
  showName,
  showSkuCode,
  showValue,
  showUnit,
}: {
  value: string;
  sku: Sku;
  widthMm: number;
  heightMm: number;
  showName: boolean;
  showSkuCode: boolean;
  showValue: boolean;
  showUnit: boolean;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    try {
      // 清空上一次渲染的节点（同一元素重复调用会叠加）
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      JsBarcode(svg, value, {
        format: 'CODE128',
        displayValue: showValue,
        width: 1.4,
        height: Math.max(14, heightMm * 1.9),
        fontSize: 10,
        lineColor: '#000',
        margin: 0,
        textMargin: 1,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [value, showValue, heightMm]);

  return (
    <div
      className="label-cell"
      style={{
        width: `${widthMm}mm`,
        height: `${heightMm}mm`,
        boxSizing: 'border-box',
        border: '1px dashed #d9d9d9',
        padding: '1mm 1.5mm',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        overflow: 'hidden',
        background: '#fff',
        color: '#000',
      }}
    >
      {error ? (
        <Typography.Text type="danger" style={{ fontSize: 10 }}>
          条码生成失败：{error}
        </Typography.Text>
      ) : null}
      {/* svg 必须常驻：出错时若卸载它，ref 变 null，effect 早退就再也恢复不了 */}
      <svg
        ref={svgRef}
        style={{ maxWidth: '100%', height: 'auto', display: error ? 'none' : undefined }}
      />
      {showSkuCode ? (
        <div style={{ fontSize: 9, fontFamily: 'monospace', lineHeight: 1.2 }}>{sku.skuCode}</div>
      ) : null}
      {showUnit && sku.unit ? (
        <div style={{ fontSize: 9, lineHeight: 1.2 }}>单位：{sku.unit}</div>
      ) : null}
      {showName ? (
        <div
          style={{
            fontSize: 9,
            lineHeight: 1.2,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sku.name}
        </div>
      ) : null}
    </div>
  );
}
