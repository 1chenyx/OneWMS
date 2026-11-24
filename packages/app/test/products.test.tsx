import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import ProductsPage from '../src/pages/ProductsPage';
import type { Product, Sku } from '../src/api/client';

/**
 * 商品页（多规格 SPU）测试：mock 数据层 hooks，只验界面语义。
 *  - 列表：规格维度成 Tag、无维度显「无（单规格）」、挂靠 SKU 数、停用档标记与入口收敛；
 *  - 新建：编号位预填 + 维度编辑器（tags 取值）整体下发 specDims；
 *  - 展开行下钻该商品的规格 SKU（编码 + `名称 · 规格`）；
 *  - 规格矩阵：笛卡尔积摊开、已存在组合禁用并跳过、只建勾选的、部分失败不关弹窗；
 *  - 停用 / 恢复。
 */

const createProductMock = vi.fn();
const updateProductMock = vi.fn();
const archiveProductMock = vi.fn();
const unarchiveProductMock = vi.fn();
const createSkuMock = vi.fn();

/** 商品清单（分页壳：ProductsPage 传了 limit/offset）。用例内可改 status。 */
let productsFixture: Product[];

/** T-SHIRT 下已挂的规格 SKU（矩阵去重与展开行共用） */
const attachedFixture = [
  {
    id: 'k-1',
    skuCode: 'T-SHIRT-红-S',
    name: '圆领T恤',
    productCode: 'T-SHIRT',
    variantAttrs: { 颜色: '红', 尺码: 'S' },
    barcode: '6901234567892',
  },
] as unknown as Sku[];

beforeEach(() => {
  productsFixture = [
    {
      id: 'p-1',
      productCode: 'T-SHIRT',
      name: '圆领T恤',
      specDims: [
        { name: '颜色', values: ['红', '黑'] },
        { name: '尺码', values: ['S', 'M'] },
      ],
      unit: null,
      packages: null,
      status: 'active',
      skuCount: 1,
      extData: {},
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:30:00.000Z',
    },
    {
      id: 'p-2',
      productCode: 'BOLT',
      name: '螺栓',
      specDims: [],
      unit: null,
      packages: null,
      status: 'active',
      skuCount: 0,
      extData: {},
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:00:00.000Z',
    },
  ];
  // mutateAsync 的返回值会被接着用（.then / created.productCode），都得是已决 Promise
  createProductMock.mockResolvedValue({ productCode: 'PRD-0001' });
  updateProductMock.mockResolvedValue({});
  archiveProductMock.mockResolvedValue({});
  unarchiveProductMock.mockResolvedValue({});
  createSkuMock.mockResolvedValue({ skuCode: 'T-SHIRT-新' });
  // 调用记录按用例清零（断言 not.toHaveBeenCalled 不被上一例污染）
  createProductMock.mockClear();
  updateProductMock.mockClear();
  archiveProductMock.mockClear();
  unarchiveProductMock.mockClear();
  createSkuMock.mockClear();
});

vi.mock('../src/api/hooks', () => ({
  useProducts: () => ({
    isLoading: false,
    data: { total: productsFixture.length, limit: 20, offset: 0, hasMore: false, rows: productsFixture },
  }),
  useProductSkus: (productCode?: string) => ({
    isLoading: false,
    data: productCode === 'T-SHIRT' ? attachedFixture : [],
  }),
  useCreateProduct: () => ({ mutateAsync: createProductMock, isPending: false }),
  useUpdateProduct: () => ({ mutateAsync: updateProductMock, isPending: false }),
  useArchiveProduct: () => ({ mutateAsync: archiveProductMock, isPending: false }),
  useUnarchiveProduct: () => ({ mutateAsync: unarchiveProductMock, isPending: false }),
  useCreateSku: () => ({ mutateAsync: createSkuMock, isPending: false }),
  // 编号位建议：新建商品时预填商品编码（useSeededField）
  useNextNumber: (place: string | null) => ({
    isLoading: false,
    data: place ? { place, value: 'PRD-0001', pattern: 'PRD-{seq:4}' } : undefined,
  }),
}));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <AntApp>{ui}</AntApp>
    </ConfigProvider>
  </QueryClientProvider>
);

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ProductsPage：商品清单', () => {
  it('维度成 Tag、无维度显「无（单规格）」、挂靠 SKU 数直出；无维度不给矩阵入口', () => {
    render(wrap(<ProductsPage />));

    expect(screen.getByText('规格维度')).toBeInTheDocument();
    const rowShirt = screen.getByText('T-SHIRT').closest('tr')!;
    expect(within(rowShirt).getByText('圆领T恤')).toBeInTheDocument();
    expect(within(rowShirt).getByText('颜色：红 / 黑')).toBeInTheDocument();
    expect(within(rowShirt).getByText('尺码：S / M')).toBeInTheDocument();
    expect(within(rowShirt).getByText('1')).toBeInTheDocument(); // skuCount
    expect(within(rowShirt).getByText('2026-11-20 09:30:00')).toBeInTheDocument();
    expect(within(rowShirt).getByRole('button', { name: /按规格生成 SKU/ })).toBeInTheDocument();

    const rowBolt = screen.getByText('BOLT').closest('tr')!;
    expect(within(rowBolt).getByText('无（单规格）')).toBeInTheDocument();
    expect(within(rowBolt).getAllByText('-').length).toBeGreaterThanOrEqual(1); // skuCount 0 → 不显 0
    expect(within(rowBolt).queryByRole('button', { name: /按规格生成 SKU/ })).not.toBeInTheDocument();
  });

  it('展开行下钻该商品挂的规格 SKU（编码 + 名称 · 规格 + 条码）', async () => {
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    expect(screen.queryByText('T-SHIRT-红-S')).not.toBeInTheDocument();
    const row = screen.getByText('T-SHIRT').closest('tr')!;
    await user.click(row.querySelector('.ant-table-row-expand-icon')!);

    expect(await screen.findByText('T-SHIRT-红-S')).toBeInTheDocument();
    expect(screen.getByText('圆领T恤 · 红 / S')).toBeInTheDocument(); // skuLabel
    expect(screen.getByText('6901234567892')).toBeInTheDocument();
  });

  it('停用走确认气泡，确认后调归档接口', async () => {
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(within(screen.getByText('T-SHIRT').closest('tr')!).getByRole('button', { name: '停用' }));
    expect(await screen.findByText(/SKU 不能再挂到它下面/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' })); // Popconfirm 默认 locale
    await waitFor(() => expect(archiveProductMock).toHaveBeenCalledWith('T-SHIRT'));
    expect(await screen.findByText('已停用 T-SHIRT')).toBeInTheDocument();
  });

  it('已停用档：标记 + 恢复按钮，矩阵入口收敛', async () => {
    productsFixture[0]!.status = 'archived';
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    const row = screen.getByText('T-SHIRT').closest('tr')!;
    expect(within(row).getByText('已停用')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /按规格生成 SKU/ })).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: '恢复' }));
    expect(await screen.findByText(/重新出现在商品列表/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(unarchiveProductMock).toHaveBeenCalledWith('T-SHIRT'));
    expect(await screen.findByText('已恢复 T-SHIRT')).toBeInTheDocument();
  });
});

describe('ProductFormModal：维度编辑器', () => {
  it('新建：预填编号位的码，维度名 + tags 取值整体下发 specDims', async () => {
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(screen.getByRole('button', { name: /新建商品/ }));
    expect(await screen.findByDisplayValue('PRD-0001')).toBeInTheDocument();

    await user.type(await screen.findByLabelText('名称'), '圆领T恤');
    await user.click(screen.getByRole('button', { name: /加一个维度/ }));
    await user.type(screen.getByPlaceholderText('维度名，如 颜色'), '颜色');
    // antd Select 的 placeholder 是 span（.ant-select-selection-placeholder），不在 input 上：
    // 按文案定位到 Select 容器，再取里面的 combobox input。jsdom 里 {Enter} 不会触发
    // rc-select 提交，输入中文本是失焦时才收成 token —— 逐个输入后 tab 失焦
    const values = within(screen.getByText('取值回车确认，如 红 / 黑').closest('.ant-select')!).getByRole('combobox');
    await user.click(values);
    await user.type(values, '红');
    await user.tab();
    await user.click(values);
    await user.type(values, '黑');
    await user.tab();

    await user.click(screen.getByRole('button', { name: '创建' })); // 新建态 okText
    await waitFor(() =>
      expect(createProductMock).toHaveBeenCalledWith({
        productCode: 'PRD-0001',
        name: '圆领T恤',
        specDims: [{ name: '颜色', values: ['红', '黑'] }],
      }),
    );
    expect(await screen.findByText('商品 PRD-0001 已创建')).toBeInTheDocument();
  });

  it('维度名只有空白（骗过必填）被 normalizeDims 拦下；删行后无维度就不下发 specDims', async () => {
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(screen.getByRole('button', { name: /新建商品/ }));
    await user.type(await screen.findByLabelText('名称'), '螺栓');
    await user.click(screen.getByRole('button', { name: /加一个维度/ }));
    await user.type(screen.getByPlaceholderText('维度名，如 颜色'), ' ');
    const values = within(screen.getByText('取值回车确认，如 红 / 黑').closest('.ant-select')!).getByRole('combobox');
    await user.click(values);
    await user.type(values, '红');
    await user.tab(); // 失焦收成 token，values = ['红']

    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('有一行只填了取值，缺维度名')).toBeInTheDocument();
    expect(createProductMock).not.toHaveBeenCalled();

    await user.click(document.querySelector('.anticon-minus-circle')!); // 删掉残缺行
    await user.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createProductMock).toHaveBeenCalledWith({ productCode: 'PRD-0001', name: '螺栓' }));
  });
});

describe('ProductFormModal：基本单位 + 包装阶梯', () => {
  it('阶梯逐级填（1 箱 = 4 包、1 包 = 6 瓶），预览折合，packages 累乘随档案下发；没基本单位先拦', async () => {
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(screen.getByRole('button', { name: /新建商品/ }));
    await user.type(await screen.findByLabelText('名称'), '可乐');

    // 常用芯片加「箱」，再加一级手填「包」；没填基本单位时先拦
    await user.click(screen.getByRole('button', { name: '+ 箱' }));
    await user.click(screen.getByRole('button', { name: /加一级包装/ }));
    await user.type(screen.getAllByPlaceholderText('单位名，如 箱')[1]!, '包');
    await user.type(screen.getAllByPlaceholderText('数量')[0]!, '4');
    await user.type(screen.getAllByPlaceholderText('数量')[1]!, '6');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText(/先填基本单位，再定义包装单位/)).toBeInTheDocument();
    expect(createProductMock).not.toHaveBeenCalled();

    // 补基本单位：分母与折合预览跟着变，再提交
    await user.type(screen.getByLabelText(/^基本单位/), '瓶');
    expect(await screen.findByText('折合：1 箱 = 24 瓶；1 包 = 6 瓶')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(createProductMock).toHaveBeenCalledWith({
        productCode: 'PRD-0001',
        name: '可乐',
        unit: '瓶',
        packages: [
          { unit: '箱', ratio: 24 },
          { unit: '包', ratio: 6 },
        ],
      }),
    );
  });

  it('编辑回填：packages 反解成阶梯（箱 4 → 包 6），保存原样重发', async () => {
    productsFixture[0]!.unit = '瓶';
    productsFixture[0]!.packages = [
      { unit: '箱', ratio: 24 },
      { unit: '包', ratio: 6 },
    ];
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(within(screen.getByText('T-SHIRT').closest('tr')!).getByRole('button', { name: /编辑/ }));
    expect(await screen.findByText('编辑商品 · T-SHIRT')).toBeInTheDocument();
    expect(screen.getByLabelText(/^基本单位/)).toHaveValue('瓶');
    expect(screen.getAllByPlaceholderText('单位名，如 箱').map((el) => (el as HTMLInputElement).value)).toEqual(['箱', '包']);
    // 阶梯反解：1 箱 = 4 包（24/6），1 包 = 6 瓶
    expect(screen.getAllByPlaceholderText('数量').map((el) => Number((el as HTMLInputElement).value))).toEqual([4, 6]);

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(updateProductMock).toHaveBeenCalledWith({
        productCode: 'T-SHIRT',
        body: {
          name: '圆领T恤',
          specDims: [
            { name: '颜色', values: ['红', '黑'] },
            { name: '尺码', values: ['S', 'M'] },
          ],
          unit: '瓶',
          packages: [
            { unit: '箱', ratio: 24 },
            { unit: '包', ratio: 6 },
          ],
        },
      }),
    );
  });
});

describe('VariantMatrixModal：笛卡尔积批量建 SKU', () => {
  it('摊开 2×2 组合、已存在的禁用勾选，只建剩下的 3 个并关弹窗', async () => {
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(screen.getByRole('button', { name: /按规格生成 SKU/ }));
    const dialog = await screen.findByRole('dialog', { name: /按规格生成 SKU · T-SHIRT/ });
    expect(within(dialog).getByText(/共 4 个组合，已存在 1 个/)).toBeInTheDocument();
    // 已建的那格显示现有编码，其余显示待生成的编码
    expect(within(dialog).getByText('T-SHIRT-红-S')).toBeInTheDocument();
    expect(within(dialog).getByText('T-SHIRT-红-M（待生成）')).toBeInTheDocument();
    expect(within(dialog).getByText('T-SHIRT-黑-M（待生成）')).toBeInTheDocument();
    expect(document.querySelectorAll('.ant-table-tbody input[type="checkbox"]:disabled').length).toBe(1);
    expect(within(dialog).getByRole('button', { name: '生成 3 个' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '生成 3 个' }));
    await waitFor(() => expect(createSkuMock).toHaveBeenCalledTimes(3));
    expect(createSkuMock.mock.calls.map((c) => c[0])).toEqual([
      { name: '圆领T恤', productCode: 'T-SHIRT', variantAttrs: { 颜色: '红', 尺码: 'M' } },
      { name: '圆领T恤', productCode: 'T-SHIRT', variantAttrs: { 颜色: '黑', 尺码: 'S' } },
      { name: '圆领T恤', productCode: 'T-SHIRT', variantAttrs: { 颜色: '黑', 尺码: 'M' } },
    ]);
    expect(await screen.findByText('已生成 3 个规格 SKU')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /按规格生成 SKU · T-SHIRT/ })).not.toBeInTheDocument(),
    );
  });

  it('部分组合被服务端拒时：报出失败的规格，其余建成就关弹窗', async () => {
    createSkuMock.mockRejectedValueOnce(new Error('WMS_VARIANT_COMBO_EXISTS')); // 首个组合（红 / M）被拒
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(screen.getByRole('button', { name: /按规格生成 SKU/ }));
    const dialog = await screen.findByRole('dialog', { name: /按规格生成 SKU · T-SHIRT/ });
    await user.click(within(dialog).getByRole('button', { name: '生成 3 个' }));

    expect(await screen.findByText(/1 个没建成 · 红 \/ M：Error: WMS_VARIANT_COMBO_EXISTS/)).toBeInTheDocument();
    expect(await screen.findByText('已生成 2 个规格 SKU')).toBeInTheDocument();
    // 实现语义：建成任意一个（done > 0）就关弹窗，失败明细留在 message 里
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /按规格生成 SKU · T-SHIRT/ })).not.toBeInTheDocument(),
    );
  });

  it('按规则填条码（前缀 + 起始 + 步长）填满勾选项，生成时随各 SKU 下发', async () => {
    const user = userEvent.setup();
    render(wrap(<ProductsPage />));

    await user.click(screen.getByRole('button', { name: /按规格生成 SKU/ }));
    const dialog = await screen.findByRole('dialog', { name: /按规格生成 SKU · T-SHIRT/ });
    await user.type(within(dialog).getByLabelText('条码前缀'), 'T');
    // 起始号默认 1001、步长默认 1：直接填入勾选项
    await user.click(within(dialog).getByRole('button', { name: '填入勾选项' }));
    expect(
      within(dialog)
        .getAllByPlaceholderText('可扫入 / 填')
        .map((el) => (el as HTMLInputElement).value),
    ).toEqual(['T1001', 'T1002', 'T1003']);

    await user.click(within(dialog).getByRole('button', { name: '生成 3 个' }));
    await waitFor(() => expect(createSkuMock).toHaveBeenCalledTimes(3));
    expect(createSkuMock.mock.calls.map((c) => c[0])).toEqual([
      { name: '圆领T恤', productCode: 'T-SHIRT', variantAttrs: { 颜色: '红', 尺码: 'M' }, barcode: 'T1001' },
      { name: '圆领T恤', productCode: 'T-SHIRT', variantAttrs: { 颜色: '黑', 尺码: 'S' }, barcode: 'T1002' },
      { name: '圆领T恤', productCode: 'T-SHIRT', variantAttrs: { 颜色: '黑', 尺码: 'M' }, barcode: 'T1003' },
    ]);
  });
});
