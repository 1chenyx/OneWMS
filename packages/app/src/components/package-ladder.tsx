import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Form, Input, InputNumber, Space, Typography } from 'antd';
import type { SkuPackage } from '../api/client';

/** 阶梯的一级：1 个 unit = n 个下一级（最后一级的下一级是基本单位） */
export interface PackStep {
  unit: string;
  n: number;
}

/** 常用包装单位（点击即加一级）与基本单位预设（输入框联想） */
export const PACK_PRESETS = ['箱', '包', '打', '托'] as const;
export const BASE_UNIT_PRESETS = ['件', '瓶', '个', '只', '盒', 'kg'] as const;

function trimNum(v: number): string {
  return String(Number(v.toFixed(3)));
}

/**
 * 阶梯 → 对基本单位的换算清单：行序从大到小，最后一级直接折基本单位，
 * 上面各级逐级累乘（1 箱 = 4 包、1 包 = 6 瓶 → 箱 = 24 瓶）。
 * 校验失败抛错（调用方在提交前 message.error）。
 */
export function ladderToPackages(steps: readonly PackStep[] | undefined, baseUnit: string): SkuPackage[] {
  const rows = (steps ?? []).filter((s) => (s?.unit ?? '').toString().trim() !== '' || s?.n != null);
  const base = baseUnit.trim();
  const seen = new Set<string>(base ? [base] : []);
  for (const row of rows) {
    const unit = (row?.unit ?? '').toString().trim();
    if (!unit) throw new Error('有一级包装没填单位名');
    if (!(row.n > 0)) throw new Error(`「${unit}」的换算数量必须是正数`);
    if (seen.has(unit)) {
      throw new Error(unit === base ? `包装「${unit}」与基本单位同名` : `包装「${unit}」重复`);
    }
    seen.add(unit);
  }
  if (rows.length > 0 && !base) throw new Error('先填基本单位，再定义包装单位——换算的分母是基本单位');
  const ratios = new Array<number>(rows.length);
  let carry = 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    carry = rows[i]!.n * carry;
    ratios[i] = carry;
  }
  return rows.map((row, i) => ({ unit: row.unit.toString().trim(), ratio: ratios[i]! }));
}

/** 换算清单 → 阶梯（编辑回填）：按对基本单位的比率从大到小排，逐级相除得「1 X = n 下一级」 */
export function packagesToLadder(packages: readonly SkuPackage[] | null | undefined): PackStep[] {
  const rows = [...(packages ?? [])].sort((a, b) => b.ratio - a.ratio);
  return rows.map((p, i) => ({
    unit: p.unit,
    n: i < rows.length - 1 ? p.ratio / rows[i + 1]!.ratio : p.ratio,
  }));
}

/**
 * 包装阶梯编辑器（商品的默认包装与 SKU 的单独设置共用）：
 * 每级只填「1 X = n 下一级」，分母自动跟随下一级的单位名（最后一级折基本单位），
 * 系统累乘出对基本单位的比率并在下方实时预览。录入比直接填「对基本单位的比率」
 * 更贴近口头习惯（「一箱四包、一包六瓶」），也少一次心算。
 */
export default function PackageLadder({
  name = 'packSteps',
  baseUnit,
}: {
  /** Form.List 字段名（默认 packSteps） */
  name?: string;
  /** 基本单位（换算分母）；实时值，跟输入框联动 */
  baseUnit: string;
}) {
  const steps = (Form.useWatch(name) ?? []) as PackStep[] | undefined;
  const base = (baseUnit ?? '').trim();
  let preview = '';
  try {
    const pkgs = ladderToPackages(steps, base);
    if (pkgs.length > 0 && base) preview = pkgs.map((p) => `1 ${p.unit} = ${trimNum(p.ratio)} ${base}`).join('；');
  } catch {
    preview = ''; // 输入进行中：预览先不出，提交时才拦
  }
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <>
          <Space wrap size={4} style={{ marginBottom: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              常用：
            </Typography.Text>
            {PACK_PRESETS.map((preset) => (
              <Button
                key={preset}
                size="small"
                type="dashed"
                onClick={() => {
                  const used = new Set((steps ?? []).map((s) => (s?.unit ?? '').toString().trim()));
                  if (used.has(preset)) return; // 已有这级：不重复加
                  add({ unit: preset, n: undefined });
                }}
              >
                + {preset}
              </Button>
            ))}
          </Space>
          {fields.map((field) => {
            // 分母 = 下一级的单位名；最后一级折基本单位
            const next = (steps ?? [])[field.name + 1];
            const denom = (next?.unit ?? '').toString().trim() || base || '基本单位';
            return (
              <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                <Typography.Text style={{ width: 8, textAlign: 'center' }}>1</Typography.Text>
                <Form.Item
                  name={[field.name, 'unit']}
                  rules={[{ required: true, message: '单位名' }]}
                  style={{ marginBottom: 4 }}
                >
                  <Input placeholder="单位名，如 箱" style={{ width: 130 }} />
                </Form.Item>
                <Typography.Text>=</Typography.Text>
                <Form.Item
                  name={[field.name, 'n']}
                  rules={[{ required: true, message: '数量' }]}
                  style={{ marginBottom: 4 }}
                >
                  <InputNumber min={0.001} precision={3} placeholder="数量" style={{ width: 110 }} />
                </Form.Item>
                <Typography.Text type="secondary" style={{ minWidth: 36 }}>
                  {denom}
                </Typography.Text>
                <MinusCircleOutlined onClick={() => remove(field.name)} />
              </Space>
            );
          })}
          <div>
            <Button type="dashed" icon={<PlusOutlined />} onClick={() => add()}>
              加一级包装
            </Button>
          </div>
          {preview ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              折合：{preview}
            </Typography.Text>
          ) : null}
        </>
      )}
    </Form.List>
  );
}
