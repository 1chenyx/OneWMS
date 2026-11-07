import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import ProposalDetail from '../src/components/ProposalDetail';
import ChatPage from '../src/pages/ChatPage';
import { ChatProvider } from '../src/chat/ChatProvider';
import { AppNavProvider, useAppNav } from '../src/app-nav';
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
const agentsMock = vi.fn();
// 默认已配置（不弹引导卡）；未配置引导用例内覆盖返回值
const aiConfigMock = vi.fn(() => ({ isLoading: false, data: { configured: true, source: 'file' } }));

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
  useAiConfig: () => aiConfigMock(),
}));

// SSE 消费 mock：保留模块其余导出（ApiError 等），替换流式入口 + api.agents
// （agents 是 api 对象的方法——需覆盖 api 而非顶层导出）
vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    streamChatMessage: (
      sessionId: string,
      message: string,
      agentId: string,
      onEvent: (ev: ChatStreamEvent) => void,
      attachments?: unknown,
    ) => streamMock(sessionId, message, agentId, onEvent, attachments),
    answerChatAsk: (sessionId: string, callId: string, answer: string | null) =>
      answerMock(sessionId, callId, answer),
    api: { ...actual.api, agents: () => agentsMock() },
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

describe('ChatPage：SSE 流式', () => {
  beforeEach(() => {
    streamMock.mockReset();
    answerMock.mockReset();
    // 默认目录：内置三件套（Segmented 选项来源；个别用例可覆盖）
    agentsMock.mockResolvedValue({
      agents: [
        { id: 'general', name: '通用助手', description: '', systemPrompt: '', tools: [] },
        { id: 'readonly', name: '只读助手', description: '', systemPrompt: '', tools: [] },
      ],
      tools: [],
    });
  });

  it('发送 → 工具卡（执行中→成功回填）与流式助手回复可见', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
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
    expect(screen.getByRole('button', { name: /创建了商品 A-1 螺丝/ })).toBeInTheDocument();
    expect(screen.queryByText('wms.sku.create')).not.toBeInTheDocument();
    expect(screen.queryByText(/skuCode/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /创建了商品 A-1 螺丝/ }));
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(streamMock).toHaveBeenCalledWith(expect.any(String), '建一个 SKU', 'general', expect.any(Function), undefined);
  });

  it('多条工具调用收成一句，展开后才看到每一条', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
        onEvent({ type: 'tool-call', callId: 'c1', toolId: 'wms.sku.create', args: { skuCode: 'A-1', name: '螺丝' } });
        onEvent({ type: 'tool-result', callId: 'c1', toolId: 'wms.sku.create', ok: true, payload: { skuCode: 'A-1' } });
        onEvent({ type: 'tool-call', callId: 'c2', toolId: 'wms.order.create', args: { direction: 'in' }, });
        onEvent({
          type: 'tool-result',
          callId: 'c2',
          toolId: 'wms.order.create',
          ok: true,
          payload: { orderNo: 'IN-1', state: 'created' },
        });
        onEvent({ type: 'turn-done', steps: 2 });
      },
    );
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('按表处理');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    const summary = await screen.findByRole('button', { name: /做了 2 项/ });
    expect(screen.queryByText('创建了商品 A-1 螺丝')).not.toBeInTheDocument();
    expect(screen.queryByText(/\{/)).not.toBeInTheDocument();
    await user.click(summary);
    expect(screen.getByText('创建了商品 A-1 螺丝')).toBeInTheDocument();
    expect(screen.getByText('开了入库单 IN-1')).toBeInTheDocument();
  });

  it('导入 CSV 后连同说明一起发送', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
        onEvent({ type: 'text-delta', text: '看到了 1 行。' });
        onEvent({ type: 'turn-done', steps: 1 });
      },
    );
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));
    const csv = new File(['编码,名称,数量\nA-1,螺丝,10\n'], '入库.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('导入文件'), csv);
    expect(await screen.findByText(/入库.csv · 1 行/)).toBeInTheDocument();
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('按这张表入库');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    expect(await screen.findByText('看到了 1 行。')).toBeInTheDocument();
    const payload = streamMock.mock.calls[0]?.[4] as Array<{ name: string; kind: string; headers: string[]; rows: string[][] }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      name: '入库.csv',
      kind: 'table',
      headers: ['编码', '名称', '数量'],
      rows: [['A-1', '螺丝', '10']],
    });
  });

  it('助手切换（M16）：Segmented 选项来自目录 → 切换清空历史 → 消息携带新 agentId', async () => {
    const sids: string[] = [];
    streamMock.mockImplementation(
      async (sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
        sids.push(sid);
        onEvent({ type: 'text-delta', text: '好的。' });
        onEvent({ type: 'turn-done', steps: 1 });
      },
    );
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    // 切换器渲染目录选项
    expect(await screen.findByText('通用助手')).toBeInTheDocument();
    expect(screen.getByText('只读助手')).toBeInTheDocument();

    // general 一轮对话
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('查库存');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    expect(await screen.findByText('好的。')).toBeInTheDocument();

    // 切到只读助手：历史清空（换会话）；新消息携带 readonly + 新 sessionId
    await user.click(screen.getByText('只读助手'));
    expect(screen.queryByText('查库存')).not.toBeInTheDocument(); // 旧 turn 已清
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('再查一次');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    expect(await screen.findByText('好的。')).toBeInTheDocument();

    expect(streamMock).toHaveBeenNthCalledWith(1, sids[0], '查库存', 'general', expect.any(Function), undefined);
    expect(streamMock).toHaveBeenNthCalledWith(2, sids[1], '再查一次', 'readonly', expect.any(Function), undefined);
    expect(sids[0]).not.toBe(sids[1]); // 切换 = 换新会话（历史按助手隔离）
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

  it('AGENT_NOT_FOUND（404）→ 助手不存在提示（M16：定义可能已被修改）', async () => {
    streamMock.mockRejectedValueOnce(new ApiError('AGENT_NOT_FOUND', '助手不存在', 404));
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('你好');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText(/该助手不存在/)).toBeInTheDocument();
  });

  it('error 事件（模型层错误）→ 失败提示可见', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
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
      async (_sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
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
      async (_sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
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

  it('profile.propose 成功 → 顶部待确认面板出现提议，对话页内直接确认（配置确认页已并入）', async () => {
    streamMock.mockImplementationOnce(
      async (_sid: string, _msg: string, _agentId: string, onEvent: (ev: ChatStreamEvent) => void) => {
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
    confirmMock.mockReset();
    confirmMock.mockResolvedValueOnce({ newVersion: 2, appliedOps: 1 });
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('隐藏规格字段');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText('已生成提议，等你确认。')).toBeInTheDocument();
    // 后置跳转按钮已移除：确认收敛在本页面板，不再跳配置确认页
    expect(screen.queryByRole('button', { name: /去确认提议/ })).not.toBeInTheDocument();
    // 顶部待确认面板：提议可见 → 展开详情 → 确认应用
    expect(screen.getByText('待确认提议')).toBeInTheDocument();
    expect(screen.getAllByText('隐藏规格字段').length).toBeGreaterThan(0); // 面板列表项 note
    await user.click(screen.getByText('查看详情'));
    expect(screen.getByText('/schema/entities/sku/extensions/1/visible')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认应用' }));
    await user.click(await screen.findByRole('button', { name: '应用' })); // popconfirm 确认
    expect(confirmMock).toHaveBeenCalledWith({ id: 'p-1' });
    expect(await screen.findByText(/已应用/)).toBeInTheDocument();
  });
});

describe('ChatPage：AI 未配置引导', () => {
  /** 探针：显示当前导航页，验证「去配置」的跳转结果 */
  const NavProbe = () => {
    const { page } = useAppNav();
    return <span data-testid="nav-probe">{page}</span>;
  };

  beforeEach(() => {
    aiConfigMock.mockImplementation(() => ({ isLoading: false, data: { configured: false, source: 'none' } }));
  });
  afterEach(() => {
    // 恢复默认（已配置）——避免泄漏进其他 describe 的用例
    aiConfigMock.mockImplementation(() => ({ isLoading: false, data: { configured: true, source: 'file' } }));
  });

  it('未配置 → 顶部引导卡可见，点「去配置」跳转 AI 模型页', async () => {
    const user = userEvent.setup();
    render(wrap(<><NavProbe /><ChatProvider><ChatPage /></ChatProvider></>));

    expect(await screen.findByText('尚未配置 AI 服务')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '去配置' }));
    expect(screen.getByTestId('nav-probe')).toHaveTextContent('ai-config');
  });

  it('已配置 → 不渲染引导卡', async () => {
    aiConfigMock.mockImplementation(() => ({ isLoading: false, data: { configured: true, source: 'file' } }));
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    expect(await screen.findByText(/试试说/)).toBeInTheDocument();
    expect(screen.queryByText('尚未配置 AI 服务')).not.toBeInTheDocument();
  });

  it('发送失败 AI_NOT_CONFIGURED → 红字旁「去配置」链接可跳转', async () => {
    streamMock.mockRejectedValueOnce(new ApiError('AI_NOT_CONFIGURED', '未配置 AI', 503));
    const user = userEvent.setup();
    render(wrap(<><NavProbe /><ChatProvider><ChatPage /></ChatProvider></>));

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('你好');
    await user.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText(/未配置 AI 服务——/)).toBeInTheDocument();
    await user.click(screen.getByText('去配置', { selector: 'a' })); // 红字旁链接（非引导卡按钮）
    expect(screen.getByTestId('nav-probe')).toHaveTextContent('ai-config');
  });
});
