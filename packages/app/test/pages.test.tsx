import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import ProposalDetail from '../src/components/ProposalDetail';
import ProposalsPage from '../src/pages/ProposalsPage';
import ChatPage from '../src/pages/ChatPage';
import { ChatProvider } from '../src/chat/ChatProvider';
import { AppNavProvider } from '../src/app-nav';
import { ApiError } from '../src/api/client';
import type { ChatStreamEvent } from '../src/api/client';
import type { Proposal } from '@one/core';

/**
 * 页面/详情组件测试：mock 数据层 hooks（保留真实 ApiError 类供分支断言）。
 * 覆盖慢通道闭环的 UI 关键路径：查看报告 → 确认（成功 / 409 过期两分支）。
 * ChatPage 走真实 ChatProvider + mock streamChatMessage（SSE 事件脚本化）。
 */

const confirmMock = vi.fn();
const rejectMock = vi.fn();
const streamMock = vi.fn();
const answerMock = vi.fn();

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
}));

// SSE 消费 mock：保留模块其余导出（ApiError 等），只替换流式入口
vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    streamChatMessage: (sessionId: string, message: string, onEvent: (ev: ChatStreamEvent) => void) =>
      streamMock(sessionId, message, onEvent),
    answerChatAsk: (sessionId: string, callId: string, answer: string | null) =>
      answerMock(sessionId, callId, answer),
  };
});

// 禁用两字按钮自动插空格（文本被 span 拆散）+ AntApp 提供上下文
// + AppNavProvider（ChatPage 消费 useAppNav 注入工具卡后置动作）
const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>
      <AppNavProvider>{ui}</AppNavProvider>
    </AntApp>
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
});

describe('ChatPage：SSE 流式', () => {
  beforeEach(() => {
    streamMock.mockReset();
    answerMock.mockReset();
  });

  it('发送 → 工具卡（执行中→成功回填）与流式助手回复可见', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, onEvent: (ev: ChatStreamEvent) => void) => {
        onEvent({ type: 'tool-call', callId: 'c1', toolId: 'wms.sku.create', args: { skuCode: 'A-1', name: '螺丝' } });
        onEvent({ type: 'tool-result', callId: 'c1', toolId: 'wms.sku.create', ok: true, payload: { skuId: 'x' } });
        onEvent({ type: 'text-delta', text: '已创建 SKU ' });
        onEvent({ type: 'text-delta', text: 'A-1。' });
        onEvent({ type: 'turn-done', steps: 2 });
      },
    );
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('建一个 SKU');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText('已创建 SKU A-1。')).toBeInTheDocument();
    expect(screen.getByText('wms.sku.create')).toBeInTheDocument(); // 工具过程可见
    expect(screen.getByText('成功')).toBeInTheDocument(); // tool-result 回填终态
    expect(streamMock).toHaveBeenCalledWith(expect.any(String), '建一个 SKU', expect.any(Function));
  });

  it('未配置 AI（503）→ 友好错误提示落卡片', async () => {
    streamMock.mockRejectedValueOnce(new ApiError('AI_NOT_CONFIGURED', '未配置 AI', 503));
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('你好');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText(/未配置 AI 服务/)).toBeInTheDocument();
  });

  it('error 事件（模型层错误）→ 失败提示可见', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, onEvent: (ev: ChatStreamEvent) => void) => {
        onEvent({ type: 'error', message: 'LLM_CONNECTION_REFUSED: 连接失败' });
      },
    );
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('查库存');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText(/LLM_CONNECTION_REFUSED/)).toBeInTheDocument();
  });

  it('ui.ask 挂起 → 回答提交 → tool-result 回填问答回显', async () => {
    // 模拟真实协议：tool-result 在 answer 端点返回后才到（gate 由 answerMock 放行）
    let releaseAsk!: () => void;
    const gate = new Promise<void>((r) => (releaseAsk = r));
    answerMock.mockImplementationOnce(async () => {
      releaseAsk();
    });
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, onEvent: (ev: ChatStreamEvent) => void) => {
        onEvent({ type: 'ask', callId: 'c1', question: '要入多少个？' });
        await gate; // server 挂起等待 answer 端点
        onEvent({ type: 'tool-result', callId: 'c1', toolId: 'ui.ask', ok: true, payload: { answer: '20 个' } });
        onEvent({ type: 'text-delta', text: '好的，入库 20 个完成。' });
        onEvent({ type: 'turn-done', steps: 2 });
      },
    );

    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('入库 A-1');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    // 挂起问卡出现 → 输入回答提交
    const askInput = await screen.findByPlaceholderText('输入回答，Enter 提交');
    expect(screen.getByText('要入多少个？')).toBeInTheDocument();
    expect(screen.getByText('等待回答')).toBeInTheDocument();
    await user.click(askInput);
    await user.keyboard('20 个');
    await user.click(screen.getByRole('button', { name: '提交' }));

    expect(answerMock).toHaveBeenCalledWith(expect.any(String), 'c1', '20 个');
    expect(await screen.findByText('已回答')).toBeInTheDocument();
    expect(screen.getByText('用户回答：20 个')).toBeInTheDocument();
    expect(await screen.findByText('好的，入库 20 个完成。')).toBeInTheDocument();
  });

  it('ui.ask 跳过 → declined 回填「未回答」', async () => {
    let releaseAsk!: () => void;
    const gate = new Promise<void>((r) => (releaseAsk = r));
    answerMock.mockImplementationOnce(async () => {
      releaseAsk();
    });
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, onEvent: (ev: ChatStreamEvent) => void) => {
        onEvent({ type: 'ask', callId: 'c1', question: '批次是？' });
        await gate;
        onEvent({ type: 'tool-result', callId: 'c1', toolId: 'ui.ask', ok: true, payload: { declined: true } });
        onEvent({ type: 'text-delta', text: '好的，按默认批次处理。' });
        onEvent({ type: 'turn-done', steps: 2 });
      },
    );

    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('入库 A-1');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    await screen.findByPlaceholderText('输入回答，Enter 提交');
    await user.click(screen.getByRole('button', { name: '跳过' }));

    expect(answerMock).toHaveBeenCalledWith(expect.any(String), 'c1', null);
    expect(await screen.findByText('用户未回答（跳过或超时）')).toBeInTheDocument();
    expect(await screen.findByText('好的，按默认批次处理。')).toBeInTheDocument();
  });

  it('profile.propose 成功 → 工具卡出现「去确认提议」后置动作按钮（M12 步骤4）', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, onEvent: (ev: ChatStreamEvent) => void) => {
        onEvent({ type: 'tool-call', callId: 'c1', toolId: 'profile.propose', args: {} });
        onEvent({
          type: 'tool-result',
          callId: 'c1',
          toolId: 'profile.propose',
          ok: true,
          payload: { proposalId: 'p-1', pendingConfirm: true },
        });
        onEvent({ type: 'text-delta', text: '已生成提议，等你确认。' });
        onEvent({ type: 'turn-done', steps: 2 });
      },
    );
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('隐藏规格字段');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText('已生成提议，等你确认。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去确认提议 →' })).toBeInTheDocument(); // 后置动作
  });
});
