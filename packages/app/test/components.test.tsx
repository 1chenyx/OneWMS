import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from 'antd';
import ImpactReportView from '../src/components/ImpactReportView';
import ToolInvocationCard from '../src/components/ToolInvocationCard';
import type { ImpactReport } from '@one/core';

// vitest 未开 globals：RTL 自动清理不生效——手动清场（否则前用例的 Tag 跨测试残留，
// 「执行中」用例会被上个「被拒」用例的 DOM 误伤）
afterEach(cleanup);

/** 报告条目由后端生成中文 description——前端只排版，直出即所见 */
const report: ImpactReport = {
  summary: '共 2 项变更：字段 1，流程 1。',
  items: [
    { severity: 'info', kind: 'field', target: 'sku.spec', description: '字段「规格」将从界面隐藏（数据保留）' },
    { severity: 'warning', kind: 'workflow', target: 'inbound', description: '转移 created→received 的 when 条件全部为条件式，存在死锁风险' },
  ],
} as ImpactReport;

describe('ImpactReportView', () => {
  it('summary + 条目 description 直出，warning/info 分级渲染', () => {
    render(<ImpactReportView report={report} />);
    expect(screen.getByText('共 2 项变更：字段 1，流程 1。')).toBeInTheDocument();
    expect(screen.getByText(/字段「规格」将从界面隐藏/)).toBeInTheDocument();
    expect(screen.getByText(/死锁风险/)).toBeInTheDocument();
    // warning/info 分级渲染（两条 Alert，其一为 warning 语义色）
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.some((a) => a.className.includes('ant-alert-warning'))).toBe(true);
    expect(alerts.some((a) => a.className.includes('ant-alert-info'))).toBe(true);
  });
});

describe('ToolInvocationCard', () => {
  it('成功调用：绿色标记 + 工具名 + 参数', () => {
    render(
      <ToolInvocationCard
        invocation={{ callId: 'c1', toolId: 'wms.sku.create', args: { skuCode: 'A-1' }, ok: true, payload: { skuId: 'x' } }}
      />,
    );
    expect(screen.getByText('wms.sku.create')).toBeInTheDocument();
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText(/skuCode/)).toBeInTheDocument();
  });

  it('被拒调用：红色标记 + 错误原因可见（护栏透明）', () => {
    render(
      <ToolInvocationCard
        invocation={{
          callId: 'c2',
          toolId: 'wms.inventory.adjust',
          args: { skuCode: 'A-1', delta: -999 },
          ok: false,
          payload: { error: 'InsufficientStockError: 库存不足' },
        }}
      />,
    );
    expect(screen.getByText('被拒')).toBeInTheDocument();
    expect(screen.getByText(/库存不足/)).toBeInTheDocument();
  });

  it('执行中（tool-call 已落卡、结果未回填）：灰色标记', () => {
    render(
      <ToolInvocationCard
        invocation={{ callId: 'c3', toolId: 'wms.sku.create', args: { skuCode: 'A-1' } }}
      />,
    );
    expect(screen.getByText('执行中')).toBeInTheDocument();
    expect(screen.queryByText('被拒')).not.toBeInTheDocument(); // 未终态不误报失败
  });
});

describe('ToolInvocationCard：查询结果表格渲染（M12 步骤2）', () => {
  it('inventory.query 形态一（库位平铺）：批次与效期列可见，无效期补占位', () => {
    render(
      <ToolInvocationCard
        invocation={{
          callId: 'c1',
          toolId: 'wms.inventory.query',
          args: { locationCode: 'A-01' },
          ok: true,
          payload: [
            { skuCode: 'A-1', name: '螺丝', batchNo: 'B-1', batchExpiryDate: '2027-01-01', quantity: 5 },
            { skuCode: 'A-2', name: '螺母', batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 8 },
          ],
        }}
      />,
    );
    expect(screen.getByText('螺丝')).toBeInTheDocument();
    expect(screen.getByText('B-1')).toBeInTheDocument();
    expect(screen.getByText('2027-01-01')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument(); // 虚拟批次无有效期
  });

  it('inventory.query 形态二（单 SKU 分组）：总量 + 库位行 + 批次明细', () => {
    render(
      <ToolInvocationCard
        invocation={{
          callId: 'c2',
          toolId: 'wms.inventory.query',
          args: { skuCode: 'A-1' },
          ok: true,
          payload: {
            skuCode: 'A-1',
            name: '螺丝',
            total: 15,
            byLocation: [
              {
                locationCode: 'A-01',
                locationName: '货架一',
                quantity: 10,
                batches: [{ batchNo: 'B-1', batchExpiryDate: '2027-01-01', quantity: 10 }],
              },
              {
                locationCode: 'DEFAULT',
                locationName: '默认库位',
                quantity: 5,
                batches: [{ batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 5 }],
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText('15')).toBeInTheDocument(); // 总量
    expect(screen.getByText('货架一')).toBeInTheDocument();
    expect(screen.getByText('B-1（效期 2027-01-01） × 10')).toBeInTheDocument();
    expect(screen.getByText('DEFAULT × 5')).toBeInTheDocument();
  });

  it('inventory.query 形态三（全部分组清单）：多 SKU 总量表', () => {
    render(
      <ToolInvocationCard
        invocation={{
          callId: 'c3',
          toolId: 'wms.inventory.query',
          args: {},
          ok: true,
          payload: [
            { skuCode: 'A-1', name: '螺丝', total: 15, byLocation: [] },
            { skuCode: 'A-2', name: '螺母', total: 8, byLocation: [] },
          ],
        }}
      />,
    );
    expect(screen.getByText('螺丝')).toBeInTheDocument();
    expect(screen.getByText('螺母')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('inventory.expiring：剩余天数文案（过期/今天到期/N 天）', () => {
    render(
      <ToolInvocationCard
        invocation={{
          callId: 'c4',
          toolId: 'wms.inventory.expiring',
          args: { days: 30 },
          ok: true,
          payload: [
            { skuCode: 'A-1', locationCode: 'A-01', batchNo: 'B-1', batchExpiryDate: '2026-01-01', daysLeft: -3, quantity: 5 },
            { skuCode: 'A-2', locationCode: 'A-01', batchNo: 'B-2', batchExpiryDate: '2026-10-31', daysLeft: 0, quantity: 2 },
            { skuCode: 'A-3', locationCode: 'DEFAULT', batchNo: 'B-3', batchExpiryDate: '2026-11-05', daysLeft: 5, quantity: 7 },
          ],
        }}
      />,
    );
    expect(screen.getByText('过期 3 天')).toBeInTheDocument();
    expect(screen.getByText('今天到期')).toBeInTheDocument();
    expect(screen.getByText('5 天')).toBeInTheDocument();
  });

  it('location.list：库位编码 / 名称 / 创建日期（截到日）', () => {
    render(
      <ToolInvocationCard
        invocation={{
          callId: 'c5',
          toolId: 'wms.location.list',
          args: {},
          ok: true,
          payload: [{ locationCode: 'A-01', name: '货架一', createdAt: '2026-01-02T03:04:05.000Z' }],
        }}
      />,
    );
    expect(screen.getByText('货架一')).toBeInTheDocument();
    expect(screen.getByText('2026-01-02')).toBeInTheDocument();
    expect(screen.queryByText('2026-01-02T03:04:05.000Z')).not.toBeInTheDocument();
  });

  it('非查询工具：兜底 JSON 直出', () => {
    render(
      <ToolInvocationCard
        invocation={{
          callId: 'c6',
          toolId: 'wms.sku.create',
          args: {},
          ok: true,
          payload: { skuId: 'u-1', skuCode: 'A-9' },
        }}
      />,
    );
    expect(screen.getByText(/"skuCode":"A-9"/)).toBeInTheDocument();
  });

  it('结果超 50 行：截断为前 50 行 + 总数提示', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      skuCode: `A-${i + 1}`,
      name: 'x',
      batchNo: 'DEFAULT',
      batchExpiryDate: null,
      quantity: 1,
    }));
    render(
      <ToolInvocationCard
        invocation={{ callId: 'c7', toolId: 'wms.inventory.query', args: {}, ok: true, payload: rows }}
      />,
    );
    expect(screen.getByText('共 60 行，仅显示前 50 行')).toBeInTheDocument();
    expect(screen.getByText('A-50')).toBeInTheDocument();
    expect(screen.queryByText('A-60')).not.toBeInTheDocument();
  });
});

describe('ToolInvocationCard：ui.ask 挂起/回填（M12 步骤3）', () => {
  // 两字按钮禁用自动插空格（文本被 span 拆散，按名查询会失配）
  const wrap = (ui: React.ReactNode) => <ConfigProvider button={{ autoInsertSpace: false }}>{ui}</ConfigProvider>;

  it('挂起态：问题可见 + 回答输入提交文本', async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(
      wrap(
        <ToolInvocationCard
          invocation={{ callId: 'c1', toolId: 'ui.ask', args: { question: '要入多少个？' } }}
          onAnswer={onAnswer}
        />,
      ),
    );
    expect(screen.getByText('要入多少个？')).toBeInTheDocument();
    expect(screen.getByText('等待回答')).toBeInTheDocument();

    await user.click(screen.getByPlaceholderText('输入回答，Enter 提交'));
    await user.keyboard('20 个');
    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(onAnswer).toHaveBeenCalledWith('c1', '20 个');
  });

  it('挂起态：跳过 → onAnswer(callId, null)', async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(
      wrap(
        <ToolInvocationCard
          invocation={{ callId: 'c2', toolId: 'ui.ask', args: { question: '批次？' } }}
          onAnswer={onAnswer}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: '跳过' }));
    expect(onAnswer).toHaveBeenCalledWith('c2', null);
  });

  it('已回答：问题 + 用户回答原文回显', () => {
    render(
      wrap(
        <ToolInvocationCard
          invocation={{
            callId: 'c3',
            toolId: 'ui.ask',
            args: { question: '要入多少个？' },
            ok: true,
            payload: { answer: '20 个' },
          }}
        />,
      ),
    );
    expect(screen.getByText('已回答')).toBeInTheDocument();
    expect(screen.getByText('要入多少个？')).toBeInTheDocument();
    expect(screen.getByText('用户回答：20 个')).toBeInTheDocument();
  });

  it('未回答（跳过/超时）：declined 提示可见', () => {
    render(
      wrap(
        <ToolInvocationCard
          invocation={{
            callId: 'c4',
            toolId: 'ui.ask',
            args: { question: '批次？' },
            ok: true,
            payload: { declined: true },
          }}
        />,
      ),
    );
    expect(screen.getByText('未回答')).toBeInTheDocument();
    expect(screen.getByText('用户未回答（跳过或超时）')).toBeInTheDocument();
  });
});

describe('ToolInvocationCard：后置动作按钮（M12 步骤4）', () => {
  const wrap = (ui: React.ReactNode) => <ConfigProvider button={{ autoInsertSpace: false }}>{ui}</ConfigProvider>;

  it('profile.propose 成功 → 「去确认提议」跳配置确认页（无过滤）', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(
      wrap(
        <ToolInvocationCard
          invocation={{
            callId: 'c1',
            toolId: 'profile.propose',
            args: {},
            ok: true,
            payload: { proposalId: 'p-1', pendingConfirm: true },
          }}
          onNavigate={onNavigate}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: '去确认提议 →' }));
    expect(onNavigate).toHaveBeenCalledWith('proposals', undefined);
  });

  it('order.create 成功 → 带单号过滤跳单据页', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(
      wrap(
        <ToolInvocationCard
          invocation={{
            callId: 'c2',
            toolId: 'wms.order.create',
            args: { direction: 'in', lines: [] },
            ok: true,
            payload: { orderId: 'o-1', orderNo: 'IN-20261031-1', state: 'created' },
          }}
          onNavigate={onNavigate}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: '去单据查看 →' }));
    expect(onNavigate).toHaveBeenCalledWith('orders', { orderNo: 'IN-20261031-1' });
  });

  it('inventory.adjust 成功 → 带 SKU 过滤跳库存页；inventory.query 单 SKU 分组同样出按钮', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      wrap(
        <ToolInvocationCard
          invocation={{
            callId: 'c3',
            toolId: 'wms.inventory.adjust',
            args: { skuCode: 'A-1', delta: 20 },
            ok: true,
            payload: { skuCode: 'A-1', quantity: 20 },
          }}
          onNavigate={onNavigate}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: '去库存页查看 →' }));
    expect(onNavigate).toHaveBeenCalledWith('inventory', { skuCode: 'A-1' });

    rerender(
      wrap(
        <ToolInvocationCard
          invocation={{
            callId: 'c4',
            toolId: 'wms.inventory.query',
            args: { skuCode: 'A-1' },
            ok: true,
            payload: { skuCode: 'A-1', name: '螺丝', total: 20, byLocation: [] },
          }}
          onNavigate={onNavigate}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: '去库存页查看 →' }));
    expect(onNavigate).toHaveBeenLastCalledWith('inventory', { skuCode: 'A-1' });
  });

  it('inventory.query 平铺/全量清单形态 → 无后置动作（结果已在卡内成表）', () => {
    render(
      wrap(
        <ToolInvocationCard
          invocation={{
            callId: 'c5',
            toolId: 'wms.inventory.query',
            args: { locationCode: 'A-01' },
            ok: true,
            payload: [{ skuCode: 'A-1', name: '螺丝', batchNo: 'DEFAULT', batchExpiryDate: null, quantity: 5 }],
          }}
          onNavigate={vi.fn()}
        />,
      ),
    );
    expect(screen.queryByRole('button', { name: /去库存页查看/ })).not.toBeInTheDocument();
  });

  it('失败/执行中/未传 onNavigate → 无后置动作按钮', () => {
    const failed = { callId: 'c6', toolId: 'wms.order.create', args: {}, ok: false, payload: { error: 'x' } };
    const pending = { callId: 'c7', toolId: 'wms.order.create', args: {} };
    const okNoNav = {
      callId: 'c8',
      toolId: 'wms.order.create',
      args: {},
      ok: true,
      payload: { orderId: 'o', orderNo: 'IN-1', state: 'created' },
    };
    const { rerender } = render(wrap(<ToolInvocationCard invocation={failed} onNavigate={vi.fn()} />));
    expect(screen.queryByRole('button', { name: /去单据查看/ })).not.toBeInTheDocument();

    rerender(wrap(<ToolInvocationCard invocation={pending} onNavigate={vi.fn()} />));
    expect(screen.queryByRole('button', { name: /去单据查看/ })).not.toBeInTheDocument();

    rerender(wrap(<ToolInvocationCard invocation={okNoNav} />)); // 无 onNavigate
    expect(screen.queryByRole('button', { name: /去单据查看/ })).not.toBeInTheDocument();
  });
});
