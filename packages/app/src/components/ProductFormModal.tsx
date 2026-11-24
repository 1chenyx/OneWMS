import { useEffect } from 'react';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, AutoComplete, Button, Form, Input, Modal, Select, Space } from 'antd';
import { useCreateProduct, useUpdateProduct } from '../api/hooks';
import { ApiError } from '../api/client';
import type { Product, ProductSpecDim, SkuPackage } from '../api/client';
import { filledCode, useSeededField } from './use-seeded-code';
import PackageLadder, {
  BASE_UNIT_PRESETS,
  ladderToPackages,
  packagesToLadder,
} from './package-ladder';

/**
 * 商品表单（多规格 SPU）：新建 / 编辑复用，一体化录入。
 * productCode 是业务键，编辑态不出现（历史 SKU 按它挂靠）。
 * 基本单位 + 包装阶梯在商品上设一次，挂在下面的 SKU 不单独设置就自动沿用——
 * 「一箱四包、一包六瓶」逐级填，系统累乘出对基本单位的比率。
 * specDims 是「维度名 + 取值清单」的可增删列表，整体替换下发——
 * 删掉已挂 SKU 在用的维度/取值会被服务端拒（WMS_SPEC_DIM_IN_USE），
 * 界面上只做去空白与去重，语义守卫留在工具层。
 */
export default function ProductFormModal({
  open,
  onClose,
  product,
}: {
  open: boolean;
  onClose: () => void;
  /** 编辑目标；null = 新建 */
  product: Product | null;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const editing = product !== null;
  const unitValue = (Form.useWatch('unit', form) as string | undefined)?.trim() ?? '';

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (!product) return;
    form.setFieldsValue({
      name: product.name,
      specDims: product.specDims.map((d) => ({ name: d.name, values: [...d.values] })),
      ...(product.unit ? { unit: product.unit } : {}),
      packSteps: packagesToLadder(product.packages),
    });
  }, [open, form, product]);

  useSeededField(form, 'productCode', open && !editing ? 'product' : null);

  const submit = async (values: Record<string, unknown>) => {
    let specDims: ProductSpecDim[];
    let packages: SkuPackage[];
    const unit = (values.unit as string | undefined)?.trim() ?? '';
    try {
      specDims = normalizeDims(values.specDims);
      packages = ladderToPackages(values.packSteps as { unit: string; n: number }[] | undefined, unit);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      return;
    }
    try {
      if (editing) {
        await update.mutateAsync({
          productCode: product.productCode,
          // unit / packages 显式传（空串 / [] = 清空）；原样重发幂等，不甩开继承语义
          body: { name: values.name as string, specDims, unit, packages },
        });
        message.success(`商品 ${product.productCode} 已更新`);
      } else {
        const productCode = filledCode(values.productCode);
        const created = await create.mutateAsync({
          ...(productCode ? { productCode } : {}),
          name: values.name as string,
          ...(specDims.length ? { specDims } : {}),
          ...(unit ? { unit } : {}),
          ...(packages.length ? { packages } : {}),
        });
        message.success(`商品 ${created.productCode} 已创建`);
      }
      onClose();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `${editing ? '保存' : '创建'}失败：${String(e)}`);
    }
  };

  const pending = editing ? update.isPending : create.isPending;

  return (
    <Modal
      title={editing ? `编辑商品 · ${product.productCode}` : '新建商品'}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={editing ? '保存' : '创建'}
      confirmLoading={pending}
      width={620}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        {!editing ? (
          <Form.Item
            name="productCode"
            label="商品编码"
            extra="已填入建议编号，可以改。留空则按编号规则生成（如 PRD-0001）。"
          >
            <Input placeholder="如 T-SHIRT（全库唯一；生成的 SKU 编码会以它为前缀）" />
          </Form.Item>
        ) : null}
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="如 圆领T恤" />
        </Form.Item>

        <Form.Item
          name="unit"
          label="基本单位（可选）"
          extra="库存与账面按它记，如 瓶 / 件 / kg。挂在下面的 SKU 不单独设置就沿用这个。"
        >
          <AutoComplete
            placeholder="如 瓶（可输入自定义单位）"
            style={{ width: '50%' }}
            options={BASE_UNIT_PRESETS.map((u) => ({ value: u }))}
          />
        </Form.Item>
        <Form.Item
          label="包装换算（可选，开单时可直接按箱 / 包录入，系统折成基本单位入账）"
          extra={
            unitValue
              ? `从大到小逐级填「1 箱 = 4 包」，最后一级折成「${unitValue}」，系统累乘。挂在下面的 SKU 不单独设置就沿用。改比例不影响已开的单据。`
              : '先填基本单位，才能定义包装——换算的分母是基本单位。挂在下面的 SKU 不单独设置就沿用。'
          }
          style={{ marginBottom: 16 }}
        >
          <PackageLadder name="packSteps" baseUnit={unitValue} />
        </Form.Item>

        <Form.Item
          label="规格维度（可选，如 颜色 × 尺码——不是箱 / 包这类包装单位）"
          extra={
            editing
              ? '整体替换：删掉已挂 SKU 在用的维度或取值会被拒绝；加维度要先给已挂 SKU 补上取值。'
              : '不填 = 无维度（只作归组）。填了之后每个规格组合是一个 SKU，可在商品页按矩阵批量生成。'
          }
          style={{ marginBottom: 0 }}
        >
          <Form.List name="specDims">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                    <Form.Item
                      name={[field.name, 'name']}
                      rules={[{ required: true, message: '维度名' }]}
                      style={{ marginBottom: 4 }}
                    >
                      <Input placeholder="维度名，如 颜色" style={{ width: 140 }} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'values']}
                      rules={[{ required: true, message: '至少一个取值' }]}
                      style={{ marginBottom: 4 }}
                    >
                      <Select
                        mode="tags"
                        placeholder="取值回车确认，如 红 / 黑"
                        style={{ width: 320 }}
                        tokenSeparators={[',', '，', '/']}
                      />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(field.name)} />
                  </Space>
                ))}
                <Form.Item style={{ marginBottom: 16 }}>
                  <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ name: '', values: [] })}>
                    加一个维度
                  </Button>
                </Form.Item>
              </>
            )}
          </Form.List>
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 去空白、去重、丢掉空行。维度名重复时后者丢弃（服务端也按名字认维度）。 */
function normalizeDims(raw: unknown): ProductSpecDim[] {
  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const out: ProductSpecDim[] = [];
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    const values = Array.isArray(row?.values)
      ? [...new Set((row.values as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))]
      : [];
    if (!name && values.length === 0) continue; // 整行空着：当成没加
    if (!name) throw new Error('有一行只填了取值，缺维度名');
    if (values.length === 0) throw new Error(`维度「${name}」还没有取值`);
    if (out.some((d) => d.name === name)) continue;
    out.push({ name, values });
  }
  return out;
}
