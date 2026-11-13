import { useEffect, useMemo, useRef, useState } from 'react';
import { PrinterOutlined, TagsOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  InputNumber,
  Radio,
  Select,
  Space,
  Typography,
} from 'antd';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { useLocations, useLpns, useSkus } from '../api/hooks';
import PageHeader from '../components/PageHeader';

/**
 * 条码标签页——把 SKU 档案 / 库位 / 托盘变成能贴到货架、箱子、托盘上的标签。
 *
 * 码值规则（与扫码识别口径一致）：商品标签有条码用条码，没有条码退用 SKU 编码——
 * 自建仓库大量商品没有厂商条码，编码本身也能扫（扫码枪只是键盘输入）。
 * 库位标签编 locationCode，托盘(LPN)标签编 lpnCode。
 * 码制可选：CODE128 条码（字母数字都能编，市面扫码枪全支持）或 QR 二维码
 * （信息密度高，手机也能扫）。
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

type LabelKind = 'sku' | 'location' | 'lpn';
type Symbology = 'code128' | 'qr';

/** 打印条目（三种数据源归一）：value 是码值，code 是主文案，title 是辅助文案 */
interface LabelItem {
  key: string;
  value: string;
  code: string;
  title: string;
  unit?: string | null;
  /** 下拉选项展示用的备注（如「无条码，用编码」） */
  hint: string;
}

const KIND_META: Record<LabelKind, { label: string; placeholder: string }> = {
  sku: { label: '商品标签', placeholder: '选择 SKU（可多选、可搜索）' },
  location: { label: '库位标签', placeholder: '选择库位（可多选、可搜索）' },
  lpn: { label: '托盘标签', placeholder: '选择托盘（可多选、可搜索）' },
};

export default function LabelsPage() {
  const { message } = AntApp.useApp();
  const { data: skus, isLoading: skusLoading } = useSkus();
  const { data: locations, isLoading: locationsLoading } = useLocations();
  const { data: lpns, isLoading: lpnsLoading } = useLpns();
  const [kind, setKind] = useState<LabelKind>('sku');
  const [symbology, setSymbology] = useState<Symbology>('code128');
  const [selected, setSelected] = useState<string[]>([]);
  const [presetKey, setPresetKey] = useState<string>(LABEL_PRESETS[1].key);
  const [columns, setColumns] = useState(3);
  const [copies, setCopies] = useState(1);
  const [showName, setShowName] = useState(true);
  const [showCode, setShowCode] = useState(true);
  const [showValue, setShowValue] = useState(true);
  const [showUnit, setShowUnit] = useState(false);
  const [onlyWithBarcode, setOnlyWithBarcode] = useState(false);

  const preset = LABEL_PRESETS.find((p) => p.key === presetKey) ?? LABEL_PRESETS[1];

  /** 三种数据源归一成待选条目 */
  const items = useMemo<LabelItem[]>(() => {
    if (kind === 'location') {
      return (locations ?? []).map((l) => ({
        key: l.locationCode,
        value: l.locationCode,
        code: l.locationCode,
        title: l.name,
        hint: l.warehouseCode ? `仓库 ${l.warehouseCode}` : '',
      }));
    }
    if (kind === 'lpn') {
      return (lpns ?? []).map((p) => ({
        key: p.lpnCode,
        value: p.lpnCode,
        code: p.lpnCode,
        title: `库位 ${p.locationCode}`,
        hint: `${p.lineCount} 行`,
      }));
    }
    const list = onlyWithBarcode ? (skus ?? []).filter((s) => s.barcode) : (skus ?? []);
    return list.map((s) => ({
      key: s.skuCode,
      value: s.barcode?.trim() ? s.barcode.trim() : s.skuCode,
      code: s.skuCode,
      title: s.name,
      unit: s.unit,
      hint: s.barcode ? `条码 ${s.barcode}` : '无条码，用编码',
    }));
  }, [kind, skus, locations, lpns, onlyWithBarcode]);

  // 换标签类型时换一套选择（key 语义不同，留着会打出错标签）
  useEffect(() => {
    setSelected([]);
  }, [kind]);

  const isLoading = kind === 'sku' ? skusLoading : kind === 'location' ? locationsLoading : lpnsLoading;
  const options = items.map((it) => ({
    value: it.key,
    label: it.hint ? `${it.code} · ${it.title}（${it.hint}）` : `${it.code} · ${it.title}`,
  }));

  /** 待打印清单：每个条目按份数重复（重复的标签要连排，方便一张张撕） */
  const sheet = useMemo(() => {
    const byKey = new Map(items.map((it) => [it.key, it] as const));
    const out: LabelItem[] = [];
    const n = Math.min(Math.max(copies, 1), 999);
    for (const key of selected) {
      const item = byKey.get(key);
      if (!item) continue;
      for (let i = 0; i < n; i += 1) {
        out.push({ ...item, key: `${key}#${i}` });
      }
    }
    return out;
  }, [selected, items, copies]);

  const selectAllFiltered = () => setSelected(items.map((it) => it.key));

  const doPrint = () => {
    if (sheet.length === 0) {
      message.warning('先选要打印的条目');
      return;
    }
    // 让浏览器绘制完最后一帧再拉起打印对话框，否则可能打出空白页
    window.setTimeout(() => window.print(), 60);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0, overflow: 'auto' }}>
      <PageHeader
        title="条码标签"
        subtitle="选标签类型与条目 → 挑标签纸规格 → 打印。商品有条码打条码，没条码打 SKU 编码（都能扫）"
        extra={
          <Button type="primary" icon={<PrinterOutlined />} disabled={sheet.length === 0} onClick={doPrint}>
            打印 {sheet.length > 0 ? `${sheet.length} 张` : ''}
          </Button>
        }
      />

      <Card title={<><TagsOutlined /> 选择与版式</>}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={16}>
            <Space size={6}>
              <Typography.Text type="secondary">标签类型</Typography.Text>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                value={kind}
                onChange={(e) => setKind(e.target.value as LabelKind)}
                options={[
                  { value: 'sku', label: KIND_META.sku.label },
                  { value: 'location', label: KIND_META.location.label },
                  { value: 'lpn', label: KIND_META.lpn.label },
                ]}
              />
            </Space>
            <Space size={6}>
              <Typography.Text type="secondary">码制</Typography.Text>
              <Radio.Group
                optionType="button"
                value={symbology}
                onChange={(e) => setSymbology(e.target.value as Symbology)}
                options={[
                  { value: 'code128', label: '条码 CODE128' },
                  { value: 'qr', label: '二维码 QR' },
                ]}
              />
            </Space>
          </Space>

          <Space wrap size={8}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder={KIND_META[kind].placeholder}
              style={{ minWidth: 420, maxWidth: '100%' }}
              value={selected}
              onChange={setSelected}
              options={options}
              loading={isLoading}
              maxTagCount="responsive"
              allowClear
            />
            <Button size="small" onClick={selectAllFiltered}>全选当前列表</Button>
            {kind === 'sku' ? (
              <Checkbox checked={onlyWithBarcode} onChange={(e) => setOnlyWithBarcode(e.target.checked)}>
                只看有条码的
              </Checkbox>
            ) : null}
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
              <Typography.Text type="secondary">每个条目</Typography.Text>
              <InputNumber min={1} max={999} precision={0} value={copies} onChange={(v) => setCopies(v ?? 1)} style={{ width: 80 }} />
              <Typography.Text type="secondary">份</Typography.Text>
            </Space>
          </Space>

          <Space wrap size={16}>
            <Typography.Text type="secondary">标签上印什么：</Typography.Text>
            <Checkbox checked={showValue} onChange={(e) => setShowValue(e.target.checked)}>
              {symbology === 'qr' ? '码值文本' : '条码数字'}
            </Checkbox>
            <Checkbox checked={showCode} onChange={(e) => setShowCode(e.target.checked)}>
              {kind === 'sku' ? 'SKU 编码' : kind === 'location' ? '库位编码' : '托盘号'}
            </Checkbox>
            <Checkbox checked={showName} onChange={(e) => setShowName(e.target.checked)}>
              {kind === 'sku' ? '商品名称' : '名称/说明'}
            </Checkbox>
            {kind === 'sku' ? (
              <Checkbox checked={showUnit} onChange={(e) => setShowUnit(e.target.checked)}>单位（有设置的才印）</Checkbox>
            ) : null}
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
          <Typography.Text type="secondary">还没有选条目——上面选完这里就出预览</Typography.Text>
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
                  item={item}
                  symbology={symbology}
                  widthMm={preset.width}
                  heightMm={preset.height}
                  showName={showName}
                  showCode={showCode}
                  showValue={showValue}
                  showUnit={kind === 'sku' && showUnit}
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
 * 单张标签：固定 mm 尺寸（打印 1:1）。CODE128 用 SVG 矢量渲染——位图放大会糊，
 * 矢量不会；QR 由 qrcode 生成 dataURL 以 img 嵌入。JsBarcode 对编不了的字符会抛
 * 异常，这里兜住并显式报错，而不是打出一排空白标签让人白贴。
 */
function Label({
  item,
  symbology,
  widthMm,
  heightMm,
  showName,
  showCode,
  showValue,
  showUnit,
}: {
  item: LabelItem;
  symbology: Symbology;
  widthMm: number;
  heightMm: number;
  showName: boolean;
  showCode: boolean;
  showValue: boolean;
  showUnit: boolean;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (symbology !== 'code128') return;
    const svg = svgRef.current;
    if (!svg) return;
    try {
      // 清空上一次渲染的节点（同一元素重复调用会叠加）
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      JsBarcode(svg, item.value, {
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
  }, [symbology, item.value, showValue, heightMm]);

  useEffect(() => {
    if (symbology !== 'qr') return;
    let alive = true;
    QRCode.toDataURL(item.value, { margin: 0, width: 240, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (alive) {
          setQrUrl(url);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [symbology, item.value]);

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
          码生成失败：{error}
        </Typography.Text>
      ) : null}
      {symbology === 'code128' ? (
        // svg 必须常驻：出错时若卸载它，ref 变 null，effect 早退就再也恢复不了
        <svg
          ref={svgRef}
          style={{ maxWidth: '100%', height: 'auto', display: error ? 'none' : undefined }}
        />
      ) : qrUrl ? (
        <img src={qrUrl} alt={item.value} style={{ maxWidth: '100%', maxHeight: `${heightMm * 0.7}mm`, height: 'auto' }} />
      ) : null}
      {showValue && symbology === 'qr' ? (
        <div style={{ fontSize: 9, fontFamily: 'monospace', lineHeight: 1.2 }}>{item.value}</div>
      ) : null}
      {showCode ? (
        <div style={{ fontSize: 9, fontFamily: 'monospace', lineHeight: 1.2 }}>{item.code}</div>
      ) : null}
      {showUnit && item.unit ? (
        <div style={{ fontSize: 9, lineHeight: 1.2 }}>单位：{item.unit}</div>
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
          {item.title}
        </div>
      ) : null}
    </div>
  );
}
