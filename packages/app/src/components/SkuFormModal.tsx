import { useEffect, useMemo } from 'react';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Form, Input, InputNumber, Modal, Select, Space, Switch } from 'antd';
import type { FieldExtension } from '@one/core';
import { useCreateSku, useNextNumber, useProducts, useProfileSnapshot, useUpdateSku } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Sku, SkuPackage } from '../api/client';
import { filledCode, useSeededField } from './use-seeded-code';

/**
 * SKU 表单（动态表单，Profile 消费闭环的输入侧）——新建 / 编辑同一份：
 * 固定字段（编码/名称/所属商品+规格/条码/基本单位+包装换算/安全库存）+ 可见扩展字段按 type 映射控件，
 * 隐藏字段连输入项都不出现（软删除的界面投影）。
 *
 * 编辑态（传入 sku）：skuCode 是业务键禁用（历史单据/流水按它引用）；
 * 扩展字段整体替换（wms.sku.update 语义），所以未填的扩展字段会被清掉——
 * 打开时按 sku.extData 回填，用户看到的是「改后结果」而不是「差异」。
 *
 * 多规格：选了商品才出现规格组合下拉（维度来自商品的 specDims）；没选商品
 * 就一个字段都不下发（工具语义「两者都不传 = 不挂 / 不改挂」，不能取消挂靠）。
 *
 * 包装换算：unit 是基本单位（库存与账面恒按它记），packages 是录入用的包装单位
 * （1 箱 = 24 瓶）。编辑态整体替换——原样保存会原样下发；行全删 = 传 [] 清空。
 */
export default function SkuFormModal({
  open,
  onClose,
  sku,
}: {
  open: boolean;
  onClose: () => void;
  /** 传入 = 编辑该 SKU；不传 = 新建 */
  sku?: Sku | null;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const snapshot = useProfileSnapshot();
  const serialOn = snapshot.data?.modules['module.serial']?.enabled === true;
  const create = useCreateSku();
  const update = useUpdateSku();
  const editing = sku != null;

  // 商品选择器只列启用档（停用商品不允许新挂 / 改挂）；skuSeed 用来认出「编码框还是系统建议值」
  const products = useProducts();
  const skuSeed = useNextNumber(open && !editing ? 'sku' : null);
  const productCode = Form.useWatch('productCode', form) as string | undefined;
  const variantAttrs = (Form.useWatch('variantAttrs', form) ?? {}) as Record<string, string | undefined>;
  // 编码框的实时值：留空时把服务端会生成的编码预告出来（codeHint 要用）
  const codeValue = Form.useWatch('skuCode', form) as string | undefined;
  // 基本单位实时值：包装换算的分母，提示文案跟着变
  const unitValue = (Form.useWatch('unit', form) as string | undefined)?.trim();
  const specDims = (products.data ?? []).find((p) => p.productCode === productCode)?.specDims ?? [];

  // 扩展字段元数据（visible = false 的不出现：列与输入项同源）
  const extensions = useMemo(
    () => (snapshot.data?.schema.entities['sku']?.extensions ?? []).filter((e) => e.visible),
    [snapshot.data],
  );

  /**
   * 回填 effect 的依赖用「内容签名」而不是 extensions 数组本身。
   * 编码/商品/规格三个 useWatch 会让父组件在每次敲键时重渲染，快照查询（或测试里的 mock）
   * 逐渲染给新数组的话，effect 就跟着反复 resetFields —— 用户刚敲进编码框的字符会被清掉。
   * 签名相同不重跑；profile 快照晚到（签名真的变了）仍会补填一次扩展字段。
   */
  const extSignature = extensions.map((e) => `${e.key}:${e.type}:${e.visible}`).join('|');

  const productOptions = useMemo(() => {
    const rows = (products.data ?? []).map((p) => ({
      value: p.productCode,
      label:
        p.specDims.length > 0
          ? `${p.productCode} · ${p.name}（${p.specDims.map((d) => d.name).join('×')}）`
          : `${p.productCode} · ${p.name}`,
    }));
    // 编辑态挂在已停用商品下：清单里没有它，补一项免得选择器显示成裸编码
    if (editing && sku.productCode && !rows.some((r) => r.value === sku.productCode)) {
      rows.push({ value: sku.productCode, label: `${sku.productCode}（已停用）` });
    }
    return rows;
  }, [products.data, editing, sku]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (!sku) return;
    // 回填：扩展字段按声明类型转成控件值（json 序列化回文本框）
    const values: Record<string, unknown> = {
      skuCode: sku.skuCode,
      name: sku.name,
      barcode: sku.barcode ?? undefined,
      reorderPoint: sku.reorderPoint > 0 ? sku.reorderPoint : undefined,
      unit: sku.unit ?? undefined,
      packages: (sku.packages ?? []).map((p) => ({ unit: p.unit, ratio: p.ratio })),
      ...(sku.productCode ? { productCode: sku.productCode } : {}),
      ...(sku.variantAttrs ? { variantAttrs: { ...sku.variantAttrs } } : {}),
      ...(serialOn ? { serialTracked: sku.serialTracked === true } : {}),
    };
    for (const ext of extensions) {
      const v = sku.extData[ext.key];
      if (v === undefined || v === null) continue;
      values[ext.key] = ext.type === 'json' ? JSON.stringify(v) : v;
    }
    form.setFieldsValue(values);
  }, [open, sku, form, extSignature, serialOn]);

  useSeededField(form, 'skuCode', open && !editing ? 'sku' : null);

  /**
   * 换到带维度的商品：编码框若还是系统建议值就清空，交给服务端按「商品码-取值」生成
   * （T-SHIRT + 红/S → T-SHIRT-红-S）。手改过的编码不动。
   */
  const onProductChange = (next: string | undefined) => {
    if (editing) return;
    const dims = (products.data ?? []).find((p) => p.productCode === next)?.specDims ?? [];
    if (dims.length === 0) return;
    const current = filledCode(form.getFieldValue('skuCode'));
    if (current && current === skuSeed.data?.value) form.setFieldValue('skuCode', '');
  };

  const submit = async (values: Record<string, unknown>) => {
    // 收集扩展字段值：空值跳过；json 类型提交前 parse
    const extData: Record<string, unknown> = {};
    for (const ext of extensions) {
      const v = values[ext.key];
      if (v === undefined || v === null || v === '') continue;
      if (ext.type === 'json') {
        try {
          extData[ext.key] = JSON.parse(v as string);
        } catch {
          message.error(`「${ext.label}」不是合法的 JSON`);
          return;
        }
      } else {
        extData[ext.key] = v;
      }
    }
    const barcode = (values.barcode as string | undefined)?.trim();
    const unit = (values.unit as string | undefined)?.trim();
    // 包装单位：去空白、丢空行；没填基本单位、重名、比例非正都拦在提交前（服务端同样会拒）
    let packages: SkuPackage[];
    try {
      packages = normalizePackages(values.packages, unit ?? '');
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      return;
    }
    const reorderPoint =
      typeof values.reorderPoint === 'number' && values.reorderPoint >= 0 ? values.reorderPoint : 0;
    // 挂商品：按维度顺序重建组合（无维度商品不带 variantAttrs，带了服务端会拒）
    const picked = values.productCode as string | undefined;
    const attachment = picked
      ? {
          productCode: picked,
          ...(specDims.length > 0
            ? {
                variantAttrs: Object.fromEntries(
                  specDims.map((d) => [d.name, (values.variantAttrs as Record<string, string>)?.[d.name] ?? '']),
                ),
              }
            : {}),
        }
      : {};
    try {
      if (editing) {
        await update.mutateAsync({
          skuCode: sku.skuCode,
          body: {
            name: values.name as string,
            // 空条码不下发（wms.sku.update 不接受清空语义，传空串会被拒）
            ...(barcode ? { barcode } : {}),
            reorderPoint,
            // 单位与条码不同：编辑态显式传（空串 = 清空），未改也幂等
            unit: unit ?? '',
            // 整体替换：原来有包装、现在全删了 → 传 [] 清空；原来就没有 → 不传
            ...(packages.length > 0 || (sku.packages?.length ?? 0) > 0 ? { packages } : {}),
            ...(serialOn ? { serialTracked: values.serialTracked === true } : {}),
            ...attachment,
            extData,
          },
        });
        message.success(`SKU ${sku.skuCode} 已更新`);
      } else {
        const skuCode = filledCode(values.skuCode);
        const created = await create.mutateAsync({
          ...(skuCode ? { skuCode } : {}),
          name: values.name as string,
          barcode: barcode || undefined,
          reorderPoint: reorderPoint > 0 ? reorderPoint : undefined,
          unit: unit || undefined,
          ...(packages.length > 0 ? { packages } : {}),
          ...(serialOn && values.serialTracked === true ? { serialTracked: true } : {}),
          ...attachment,
          extData: Object.keys(extData).length ? extData : undefined,
        });
        message.success(`SKU ${created.skuCode} 已创建`);
      }
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `${editing ? '保存' : '创建'}失败：${String(e)}`);
    }
  };

  // 挂规格且编码留空时，把服务端会生成的编码预告出来（与 wms.sku.create 的默认编码同式）
  const codeHint =
    !editing && productCode && specDims.length > 0 && !filledCode(codeValue)
      ? `留空自动生成「${productCode}-${specDims.map((d) => variantAttrs[d.name] || '？').join('-')}」`
      : '已填入建议编号，可以改。留空则按编号规则生成。';

  return (
    <Modal
      title={editing ? `编辑 SKU · ${sku.skuCode}` : '新建 SKU'}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={editing ? '保存' : '创建'}
      confirmLoading={editing ? update.isPending : create.isPending}
      width={600}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="skuCode" label="SKU 编码" extra={editing ? undefined : codeHint}>
          <Input placeholder="如 A-1001（全库唯一）" disabled={editing} />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="productCode"
          label="所属商品（可选，多规格：同一商品下按规格分成多个 SKU）"
          extra={
            editing && sku.productCode
              ? '已挂的商品不能取消挂靠；换到别的商品要重新选规格组合'
              : undefined
          }
        >
          <Select
            allowClear={!editing || !sku.productCode}
            showSearch
            optionFilterProp="label"
            placeholder="不挂 = 独立 SKU"
            options={productOptions}
            onChange={onProductChange}
          />
        </Form.Item>
        {specDims.map((dim) => (
          <Form.Item
            key={dim.name}
            name={['variantAttrs', dim.name]}
            label={`规格 · ${dim.name}`}
            rules={[{ required: true, message: `请选择${dim.name}` }]}
          >
            <Select placeholder={`选择${dim.name}`} options={dim.values.map((v) => ({ value: v, label: v }))} />
          </Form.Item>
        ))}
        <Form.Item
          name="unit"
          label="基本单位（可选，库存与账面按它记，数量显示与打印会跟随，如 kg / 瓶 / 件）"
        >
          <Input placeholder="如 kg（散装称重建议填写）" style={{ width: '50%' }} />
        </Form.Item>
        <Form.Item
          label="包装单位（可选，开单时可按箱 / 包录入，系统折成基本单位入账）"
          extra={
            unitValue
              ? `换算率 = 1 个包装单位等于多少「${unitValue}」。改比例不影响已开的单据。`
              : '先填基本单位，才能定义包装单位'
          }
          style={{ marginBottom: 0 }}
        >
          <Form.List name="packages">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                    <Form.Item
                      name={[field.name, 'unit']}
                      rules={[{ required: true, message: '单位名' }]}
                      style={{ marginBottom: 4 }}
                    >
                      <Input placeholder="单位名，如 箱" style={{ width: 140 }} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'ratio']}
                      rules={[{ required: true, message: '换算率' }]}
                      style={{ marginBottom: 4 }}
                    >
                      <InputNumber min={0.001} precision={3} placeholder="= 多少基本单位" style={{ width: 180 }} />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(field.name)} />
                  </Space>
                ))}
                <Form.Item style={{ marginBottom: 16 }}>
                  <Button type="dashed" icon={<PlusOutlined />} onClick={() => add()}>
                    加一个包装单位
                  </Button>
                </Form.Item>
              </>
            )}
          </Form.List>
        </Form.Item>
        <Form.Item
          name="barcode"
          label={
            editing
              ? '条码（扫码枪识读用；同库唯一，清空不生效）'
              : '条码（可选，扫码枪识读用；同库唯一）'
          }
        >
          <Input placeholder="如 6901234567892（可用扫码枪扫入）" />
        </Form.Item>
        <Form.Item
          name="reorderPoint"
          label={
            editing
              ? '安全库存（可用量低于此值预警；留空/0 = 关闭预警）'
              : '安全库存（可选，可用量低于此值预警；留空 = 不预警）'
          }
        >
          <InputNumber style={{ width: '100%' }} min={0} precision={0} placeholder="如 50" />
        </Form.Item>
        {serialOn ? (
          <Form.Item
            name="serialTracked"
            label="按序列号管理"
            valuePropName="checked"
            extra="一件一个号。已经有库存的商品不能再改成按序列号管理。"
          >
            <Switch />
          </Form.Item>
        ) : null}
        {extensions.map((ext) => (
          <Form.Item key={ext.key} name={ext.key} label={ext.label} valuePropName={ext.type === 'boolean' ? 'checked' : 'value'}>
            {fieldControl(ext)}
          </Form.Item>
        ))}
      </Form>
    </Modal>
  );
}

/**
 * 包装单位归整：去空白、丢掉整行空着的；没填基本单位、与基本单位同名、重复、比例非正都报错。
 * 界面只做这层浅校验，语义守卫（数量精度、上限）留在工具层。
 */
function normalizePackages(raw: unknown, baseUnit: string): SkuPackage[] {
  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: SkuPackage[] = [];
  for (const row of rows) {
    const unit = typeof row?.unit === 'string' ? row.unit.trim() : '';
    const ratio = typeof row?.ratio === 'number' ? row.ratio : NaN;
    if (!unit && Number.isNaN(ratio)) continue; // 整行空着：当成没加
    if (!unit) throw new Error('有一行包装单位缺单位名');
    if (!(ratio > 0)) throw new Error(`包装单位「${unit}」的换算率必须是正数`);
    if (unit === baseUnit) throw new Error(`包装单位「${unit}」不能与基本单位同名`);
    if (out.some((p) => p.unit === unit)) throw new Error(`包装单位「${unit}」重复`);
    out.push({ unit, ratio });
  }
  if (out.length > 0 && !baseUnit) throw new Error('先填基本单位，再定义包装单位——换算率的分母是基本单位');
  return out;
}

/** type → 控件映射（v1：date 用纯文本输入，不引日期库） */
function fieldControl(ext: FieldExtension) {
  switch (ext.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} />;
    case 'boolean':
      return <Switch />;
    case 'json':
      return <Input.TextArea rows={2} placeholder='JSON 内容，如 {"shelf": "A-01"}' />;
    default: // string / date
      return <Input placeholder={ext.type === 'date' ? '如 2026-12-31' : undefined} />;
  }
}
