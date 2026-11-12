import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import ChatPage from '../src/pages/ChatPage';
import { CHAT_OPEN_THREAD_KEY, ChatProvider } from '../src/chat/ChatProvider';
import { AppNavProvider } from '../src/app-nav';
import type { ChatStreamEvent, ChatThreadDetail, ChatThreadSummary } from '../src/api/client';

/**
 * 对话存档：新对话先收进历史，历史列表能搜、能接着打开。
 * 服务端用 mock，不打真实接口。
 */

const streamMock = vi.fn();
const listThreadsMock = vi.fn(async (): Promise<ChatThreadSummary[]> => []);
const saveThreadMock = vi.fn(
  async (id: string, body: { agentId: string; turns: { userText?: string }[] }): Promise<ChatThreadSummary> => ({
    id,
    agentId: body.agentId,
    title: body.turns[0]?.userText?.slice(0, 40) || '新对话',
    createdAt: 1,
    updatedAt: Date.now(),
  }),
);
const resumeThreadMock = vi.fn(async (_id: string): Promise<ChatThreadDetail> => {
  throw new Error('no thread');
});
const deleteThreadMock = vi.fn(async (_id: string) => undefined);
const clearThreadsMock = vi.fn(async (_exceptId?: string) => undefined);

vi.mock('../src/api/hooks', () => ({
  useProposals: () => ({ isLoading: false, data: [], refetch: vi.fn() }),
  useAiConfig: () => ({ isLoading: false, data: { configured: true, source: 'file', profiles: [] } }),
}));

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    streamChatMessage: (...args: unknown[]) => streamMock(...args),
    listChatThreads: () => listThreadsMock(),
    saveChatThread: (id: string, body: { agentId: string; turns: { userText?: string }[] }) => saveThreadMock(id, body),
    resumeChatThread: (id: string) => resumeThreadMock(id),
    deleteChatThread: (id: string) => deleteThreadMock(id),
    clearChatThreads: (exceptId?: string) => clearThreadsMock(exceptId),
    api: {
      ...actual.api,
      agents: () =>
        Promise.resolve({
          agents: [
            { id: 'general', name: '通用助手', description: '', systemPrompt: '', tools: [] },
            { id: 'readonly', name: '只读助手', description: '', systemPrompt: '', tools: [] },
          ],
          tools: [],
        }),
    },
  };
});

const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>
      <AppNavProvider>{ui}</AppNavProvider>
    </AntApp>
  </ConfigProvider>
);

const oldThread: ChatThreadDetail = {
  id: 't-old',
  agentId: 'general',
  title: '查一下库存',
  createdAt: 1,
  updatedAt: 2,
  turns: [{ userText: '查一下库存', invocations: [], assistantText: '还有 5 个', done: true }],
};

const otherThread: ChatThreadDetail = {
  id: 't-other',
  agentId: 'readonly',
  title: '建一个轴承',
  createdAt: 1,
  updatedAt: 3,
  turns: [{ userText: '建一个轴承', invocations: [], assistantText: '已经建好', done: true }],
};

function summaryOf(thread: ChatThreadDetail): ChatThreadSummary {
  const { turns: _turns, ...summary } = thread;
  return summary;
}

beforeEach(() => {
  localStorage.removeItem(CHAT_OPEN_THREAD_KEY);
  streamMock.mockReset();
  listThreadsMock.mockReset();
  listThreadsMock.mockResolvedValue([]);
  saveThreadMock.mockClear();
  resumeThreadMock.mockReset();
  resumeThreadMock.mockRejectedValue(new Error('no thread'));
  deleteThreadMock.mockClear();
  clearThreadsMock.mockClear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.removeItem(CHAT_OPEN_THREAD_KEY);
});

describe('AI 对话历史', () => {
  it('发送后写入历史，新对话清空画面', async () => {
    streamMock.mockImplementationOnce(async (_sid: string, _msg: string, _agent: string, onEvent: (ev: ChatStreamEvent) => void) => {
      onEvent({ type: 'text-delta', text: '好的。' });
      onEvent({ type: 'turn-done', steps: 1 });
    });
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled();
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('查库存');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    expect(await screen.findByText('好的。')).toBeInTheDocument();

    await waitFor(() => expect(saveThreadMock).toHaveBeenCalled());
    const saved = saveThreadMock.mock.calls.at(-1);
    expect(saved?.[1].turns.at(-1)).toMatchObject({ userText: '查库存', assistantText: '好的。', done: true });

    await user.click(screen.getByRole('button', { name: '新对话' }));
    expect(screen.queryByText('查库存')).not.toBeInTheDocument();
    expect(screen.getByText(/试试说/)).toBeInTheDocument();
    expect(localStorage.getItem(CHAT_OPEN_THREAD_KEY)).toBe('');
  });

  it('刷新后打开上次那一段；历史里能搜索并接着打开另一段', async () => {
    localStorage.setItem(CHAT_OPEN_THREAD_KEY, 't-old');
    listThreadsMock.mockResolvedValue([summaryOf(otherThread), summaryOf(oldThread)]);
    resumeThreadMock.mockImplementation(async (id: string) => (id === 't-other' ? otherThread : oldThread));
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    expect(await screen.findByText('查一下库存')).toBeInTheDocument();
    expect(screen.getByText('还有 5 个')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '历史' }));
    expect(await screen.findByRole('button', { name: /^建一个轴承/ })).toBeInTheDocument();
    expect(screen.getByText(/通用助手 ·/)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: '搜索历史对话' }), '轴承');
    expect(screen.queryByRole('button', { name: /^查一下库存/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^建一个轴承/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^建一个轴承/ }));
    expect(await screen.findByText('已经建好')).toBeInTheDocument();
    expect(screen.queryByText('还有 5 个')).not.toBeInTheDocument();
    expect(resumeThreadMock).toHaveBeenCalledWith('t-other');
  });

  it('记下的是空白新对话时，不把最近一段自动铺开', async () => {
    localStorage.setItem(CHAT_OPEN_THREAD_KEY, '');
    listThreadsMock.mockResolvedValue([summaryOf(oldThread)]);
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));

    await waitFor(() => expect(listThreadsMock).toHaveBeenCalled());
    expect(screen.getByText(/试试说/)).toBeInTheDocument();
    expect(screen.queryByText('查一下库存')).not.toBeInTheDocument();
    expect(resumeThreadMock).not.toHaveBeenCalled();
  });

  it('没有记下打开哪一段时，打开最近的一段', async () => {
    listThreadsMock.mockResolvedValue([summaryOf(oldThread)]);
    resumeThreadMock.mockResolvedValue(oldThread);
    render(
      wrap(
        <ChatProvider>
          <ChatPage />
        </ChatProvider>,
      ),
    );
    expect(await screen.findByText('还有 5 个')).toBeInTheDocument();
    expect(resumeThreadMock).toHaveBeenCalledWith('t-old');
  });

  it('可以删掉历史里的一条', async () => {
    localStorage.setItem(CHAT_OPEN_THREAD_KEY, 't-old');
    listThreadsMock.mockResolvedValue([summaryOf(otherThread), summaryOf(oldThread)]);
    resumeThreadMock.mockResolvedValue(oldThread);
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));
    expect(await screen.findByText('还有 5 个')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '历史' }));
    await user.click(await screen.findByRole('button', { name: '删除 建一个轴承' }));
    await user.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => expect(deleteThreadMock).toHaveBeenCalledWith('t-other'));
    expect(screen.queryByRole('button', { name: /^建一个轴承/ })).not.toBeInTheDocument();
    expect(screen.getByText('还有 5 个')).toBeInTheDocument();
  });

  it('清空历史时留下正在看的这一段', async () => {
    localStorage.setItem(CHAT_OPEN_THREAD_KEY, 't-old');
    listThreadsMock.mockResolvedValue([summaryOf(otherThread), summaryOf(oldThread)]);
    resumeThreadMock.mockResolvedValue(oldThread);
    const user = userEvent.setup();
    render(wrap(<ChatProvider><ChatPage /></ChatProvider>));
    expect(await screen.findByText('还有 5 个')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '历史' }));
    await user.click(await screen.findByRole('button', { name: '清空历史' }));
    await user.click(await screen.findByRole('button', { name: '清空' }));
    await waitFor(() => expect(clearThreadsMock).toHaveBeenCalledWith('t-old'));
    expect(screen.getByText('还有 5 个')).toBeInTheDocument();
  });
});
