import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Input, InputNumber, Modal, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCreateSku, useProductSkus } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Product } from '../api/client';
import { monoCell } from './table-style';

/** 一个规格组合（笛卡尔积的一格） */
interface Combo {
  key: string;
  attrs: Record<string, string>;
}

const SEP = '\u0000';

/**
 * 规格矩阵批量建 SKU：把商品 specDims 的笛卡尔积摊成一张表，勾选要建的组合，
 * 逐个走 wms.sku.create（productCode + variantAttrs，编码留空由服务端按
 * 「商品码-取值」生成）。已存在的组合禁用勾选并显示现有 SKU 编码——
 * 服务端本来也会用 WMS_VARIANT_COMBO_EXISTS 拒重复，界面先挡住省得跑到一半报错。
 * SKU 名称统一用商品名，规格在选择器/清单里由 skuLabel 拼出来。
 * 条码可以逐个填，也可以按「前缀 + 起始号 + 步长」的规则一键填满——
 * 单位与包装不用管：不单独设置就继承商品的默认值。
 */
export default function VariantMatrixModal({
  open,
  onClose,
  product,
}: {
  open: boolean;
  onClose: () => void;
  product: Product | null;
}) {
  const { message } = AntApp.useApp();
  // useMemo 保住 dims 的引用：下面的 combos / existing / 重置勾选 effect 都依赖它，
  // 每次渲染新建 `?? []` 会让 effect 反复触发（关着弹窗时更是死循环）
  const dims = useMemo(() => product?.specDims ?? [], [product]);
  const { data: attached } = useProductSkus(open ? product?.productCode : undefined, true);
  const create = useCreateSku();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [barcodes, setBarcodes] = useState<Record<string, string>>({});
  const [rulePrefix, setRulePrefix] = useState('');
  const [ruleStart, setRuleStart] = useState<number>(1001);
  const [ruleStep, setRuleStep] = useState<number>(1);

  const combos = useMemo<Combo[]>(() => {
    let acc: Combo[] = [{ key: '', attrs: {} }];
    for (const dim of dims) {
      const next: Combo[] = [];
      for (const combo of acc) {
        for (const value of dim.values) {
          next.push({
            key: combo.key ? `${combo.key}${SEP}${value}` : value,
            attrs: { ...combo.attrs, [dim.name]: value },
          });
        }
      }
      acc = next;
    }
    return dims.length === 0 ? [] : acc;
  }, [dims]);

  /** 已挂 SKU 的组合 → 行（缺规格的历史挂靠认不出组合，不参与去重） */
  const existing = useMemo(() => {
    const map = new Map<string, { skuCode: string; barcode: string | null }>();
    for (const sku of attached ?? []) {
      if (!sku.variantAttrs) continue;
      map.set(dims.map((d) => sku.variantAttrs?.[d.name] ?? '').join(SEP), {
        skuCode: sku.skuCode,
        barcode: sku.barcode,
      });
    }
    return map;
  }, [attached, dims]);

  // 每次打开重置勾选与条码：默认勾上全部还没建的组合（最常见的意图是「补齐」）
  useEffect(() => {
    if (!open) return;
    setSelected(combos.filter((c) => !existing.has(c.key)).map((c) => c.key));
    setBarcodes({});
    setRulePrefix('');
    setRuleStart(1001);
    setRuleStep(1);
  }, [open, combos, existing]);

  /** 按规则填条码：给勾选中且未存在的组合，按表格顺序编「前缀 + 递增号」 */
  const applyRule = () => {
    const targets = combos.filter((c) => selected.includes(c.key) && !existing.has(c.key));
    if (targets.length === 0) {
      message.info('先勾选要生成的组合');
      return;
    }
    const next = { ...barcodes };
    targets.forEach((c, i) => {
      next[c.key] = `${rulePrefix}${ruleStart + i * ruleStep}`;
    });
    setBarcodes(next);
    message.success(`已按规则填入 ${targets.length} 个条码`);
  };

  const generate = async () => {
    if (!product) return;
    const targets = combos.filter((c) => selected.includes(c.key) && !existing.has(c.key));
    if (targets.length === 0) {
      message.info('没有要新建的组合');
      return;
    }
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    for (const combo of targets) {
      const barcode = barcodes[combo.key]?.trim();
      try {
        await create.mutateAsync({
          name: product.name,
          productCode: product.productCode,
          variantAttrs: combo.attrs,
          ...(barcode ? { barcode } : {}),
        });
        done += 1;
      } catch (e) {
        const spec = Object.values(combo.attrs).join(' / ');
        failed.push(`${spec}：${e instanceof ApiError ? e.message : String(e)}`);
      }
    }
    setBusy(false);
    if (done > 0) message.success(`已生成 ${done} 个规格 SKU`);
    if (failed.length > 0) message.error(`${failed.length} 个没建成 · ${failed[0]}`, 6);
    if (done > 0) onClose();
  };

  const columns: ColumnsType<Combo> = [
    {
      title: '规格组合',
      key: 'spec',
      render: (_, r) => (
        <>
          {dims.map((d) => (
            <Tag key={d.name}>
              {d.name} {r.attrs[d.name]}
            </Tag>
          ))}
        </>
      ),
    },
    {
      title: 'SKU 编码',
      key: 'skuCode',
      onCell: monoCell,
      render: (_, r) => {
        const hit = existing.get(r.key);
        return hit ? (
          hit.skuCode
        ) : (
          <Typography.Text type="secondary">
            {product ? `${product.productCode}-${Object.values(r.attrs).join('-')}` : ''}（待生成）
          </Typography.Text>
        );
      },
    },
    {
      title: '条码（可选）',
      key: 'barcode',
      onCell: monoCell,
      render: (_, r) => {
        const hit = existing.get(r.key);
        if (hit) return hit.barcode ?? <Typography.Text type="secondary">-</Typography.Text>;
        return (
          <Input
            aria-label={`条码 ${r.key}`}
            size="small"
            placeholder="可扫入 / 填"
            value={barcodes[r.key] ?? ''}
            onChange={(e) => setBarcodes((prev) => ({ ...prev, [r.key]: e.target.value }))}
          />
        );
      },
    },
  ];

  return (
    <Modal
      title={product ? `按规格生成 SKU · ${product.productCode}` : '按规格生成 SKU'}
      open={open}
      onCancel={busy ? undefined : onClose}
      onOk={generate}
      okText={`生成 ${selected.length} 个`}
      okButtonProps={{ disabled: selected.length === 0 }}
      confirmLoading={busy}
      width={720}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        共 {combos.length} 个组合，已存在 {existing.size} 个。名称统一用商品名「{product?.name}」，
        编码留空由系统按「商品码-取值」生成；单位与包装不用填——自动跟随商品默认。
      </Typography.Paragraph>
      <Space wrap size={8} style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          按规则填条码：
        </Typography.Text>
        <Input
          aria-label="条码前缀"
          size="small"
          style={{ width: 140 }}
          placeholder="前缀（可空）"
          value={rulePrefix}
          onChange={(e) => setRulePrefix(e.target.value)}
        />
        <InputNumber
          aria-label="条码起始号"
          size="small"
          style={{ width: 100 }}
          min={0}
          precision={0}
          value={ruleStart}
          onChange={(v) => setRuleStart(typeof v === 'number' ? v : 1001)}
        />
        <Typography.Text type="secondary">起，每次</Typography.Text>
        <InputNumber
          aria-label="条码步长"
          size="small"
          style={{ width: 70 }}
          min={1}
          precision={0}
          value={ruleStep}
          onChange={(v) => setRuleStep(typeof v === 'number' ? v : 1)}
        />
        <Typography.Text type="secondary">递增</Typography.Text>
        <Button size="small" onClick={applyRule}>
          填入勾选项
        </Button>
      </Space>
      <Table<Combo>
        rowKey="key"
        size="small"
        columns={columns}
        dataSource={combos}
        pagination={false}
        scroll={{ y: 320 }}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
          getCheckboxProps: (r) => ({ disabled: existing.has(r.key) }),
        }}
        locale={{ emptyText: '这个商品还没有规格维度，先去编辑商品加上' }}
      />
    </Modal>
  );
}
