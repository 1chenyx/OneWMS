import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import ProposalDetail from '../src/components/ProposalDetail';
import ProposalsPage from '../src/pages/ProposalsPage';
import ChatPage from '../src/pages/ChatPage';
import { ApiError } from '../src/api/client';
import type { Proposal } from '@one/core';

/**
 * 页面/详情组件测试：mock 数据层 hooks（保留真实 ApiError 类供分支断言）。
 * 覆盖慢通道闭环的 UI 关键路径：查看报告 → 确认（成功 / 409 过期两分支）。
 */

const confirmMock = vi.fn();
const rejectMock = vi.fn();
const chatMock = vi.fn();

const proposalFixture = {
  proposalId: 'p-1',
  workspaceId: 'ws-test',
  proposedBy: 'ai:test-model',
  note: '隐藏规格字段',
  baseVersion: 1,
  status: 'pending',
  createdAt: '2026-10-30T00:00:00.000Z',
  summary: '1 项变更',
  patch: [{ op: 'replace', path: '/schema/entities/sku/extensions/1/visible', value: false }],
  report: {
    summary: '共 1 项变更：字段 1。',
    items: [
      { severity: 'info', kind: 'field', target: 'sku.spec', description: '字段「规格」将从界面隐藏（数据保留）' },
    ],
  },
} as unknown as Proposal;

vi.mock('../src/api/hooks', () => ({
  useProposalDetail: (id: string | null) => ({
    isLoading: false,
    error: null,
    data: id === 'p-1' ? proposalFixture : undefined,
  }),
  useConfirmProposal: () => ({ mutateAsync: confirmMock, isPending: false }),
  useRejectProposal: () => ({ mutateAsync: rejectMock, isPending: false }),
  useProposals: () => ({ isLoading: false, data: [proposalFixture] }),
  useChat: () => ({ mutateAsync: chatMock, isPending: false }),
}));

// 禁用两字按钮自动插空格（文本被 span 拆散）+ AntApp 提供上下文
const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

// AntD 的 popconfirm/message portal 挂在 body 上，跨测试会残留同名按钮——统一清场
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ProposalDetail：确认流程', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    rejectMock.mockReset();
  });

  it('渲染 patch 与影响报告；确认成功 → 提示新版本', async () => {
    confirmMock.mockResolvedValueOnce({ newVersion: 2, appliedOps: 1 });
    const user = userEvent.setup();
    render(wrap(<ProposalDetail proposalId="p-1" onDone={vi.fn()} />));

    expect(screen.getByText('隐藏规格字段')).toBeInTheDocument();
    expect(screen.getByText(/字段「规格」将从界面隐藏/)).toBeInTheDocument();
    expect(screen.getByText('/schema/entities/sku/extensions/1/visible')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认应用' })); // 主按钮 → 弹出二次确认
    await user.click(await screen.findByRole('button', { name: '应用' })); // popconfirm 确认
    expect(confirmMock).toHaveBeenCalledWith({ id: 'p-1' });
    expect(await screen.findByText(/已应用/)).toBeInTheDocument();
  });

  it('409 PROPOSAL_STALE → 提示重新提议', async () => {
    confirmMock.mockRejectedValueOnce(new ApiError('PROPOSAL_STALE', '配置已变化', 409));
    const user = userEvent.setup();
    render(wrap(<ProposalDetail proposalId="p-1" onDone={vi.fn()} />));

    await user.click(screen.getByRole('button', { name: '确认应用' }));
    await user.click(await screen.findByRole('button', { name: '应用' }));
    expect(await screen.findByText(/重新提议/)).toBeInTheDocument();
  });

  it('拒绝 → 调 reject 端点', async () => {
    rejectMock.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(wrap(<ProposalDetail proposalId="p-1" onDone={vi.fn()} />));

    await user.click(screen.getByRole('button', { name: '拒绝' }));
    await user.click(await screen.findByRole('button', { name: '确认拒绝' }));
    expect(rejectMock).toHaveBeenCalledWith('p-1');
    expect(await screen.findByText(/已拒绝/)).toBeInTheDocument();
  });
});

describe('页面 smoke', () => {
  it('ProposalsPage：列表 → 查看详情 → 报告可见', async () => {
    const user = userEvent.setup();
    render(wrap(<ProposalsPage />));
    expect(screen.getAllByText('隐藏规格字段').length).toBeGreaterThan(0); // 列表项 note

    await user.click(screen.getByText('查看详情'));
    expect(screen.getByText('提议详情')).toBeInTheDocument();
    expect(screen.getAllByText(/字段「规格」将从界面隐藏/).length).toBeGreaterThan(0);
  });

  it('ChatPage：发送 → 助手回复与工具卡片可见', async () => {
    chatMock.mockResolvedValueOnce({
      text: '已创建 SKU A-1。',
      steps: 2,
      invocations: [
        { toolId: 'wms.sku.create', args: { skuCode: 'A-1', name: '螺丝' }, ok: true, payload: { skuId: 'x' } },
      ],
    });
    const user = userEvent.setup();
    render(wrap(<ChatPage />));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('建一个 SKU');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText('已创建 SKU A-1。')).toBeInTheDocument();
    expect(screen.getByText('wms.sku.create')).toBeInTheDocument(); // 工具过程可见
  });
});
