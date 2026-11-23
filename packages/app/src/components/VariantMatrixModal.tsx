import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Modal, Table, Tag, Typography } from 'antd';
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

  /** 已挂 SKU 的组合 → 编码（缺规格的历史挂靠认不出组合，不参与去重） */
  const existing = useMemo(() => {
    const map = new Map<string, string>();
    for (const sku of attached ?? []) {
      if (!sku.variantAttrs) continue;
      map.set(dims.map((d) => sku.variantAttrs?.[d.name] ?? '').join(SEP), sku.skuCode);
    }
    return map;
  }, [attached, dims]);

  // 每次打开重置勾选：默认勾上全部还没建的组合（最常见的意图是「补齐」）
  useEffect(() => {
    if (!open) return;
    setSelected(combos.filter((c) => !existing.has(c.key)).map((c) => c.key));
  }, [open, combos, existing]);

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
      try {
        await create.mutateAsync({
          name: product.name,
          productCode: product.productCode,
          variantAttrs: combo.attrs,
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
          hit
        ) : (
          <Typography.Text type="secondary">
            {product ? `${product.productCode}-${Object.values(r.attrs).join('-')}` : ''}（待生成）
          </Typography.Text>
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
      width={620}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        共 {combos.length} 个组合，已存在 {existing.size} 个。名称统一用商品名「{product?.name}」，
        编码留空由系统按「商品码-取值」生成；单位、条码、安全库存建好后到 SKU 管理页补。
      </Typography.Paragraph>
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
