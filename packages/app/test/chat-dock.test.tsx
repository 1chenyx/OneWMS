import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import { CHAT_CONTEXT_KEY, CHAT_OPEN_THREAD_KEY, CHAT_WINDOWS_KEY, ChatProvider } from '../src/chat/ChatProvider';
import ChatDock from '../src/components/ChatDock';
import ChatPage from '../src/pages/ChatPage';
import type { ChatStreamEvent } from '../src/api/client';

vi.mock('../src/api/hooks', () => ({
  useProposals: () => ({ isLoading: false, data: [], refetch: vi.fn() }),
  useAiConfig: () => ({ isLoading: false, data: { configured: true, source: 'file', profiles: [] } }),
}));

const streamMock = vi.fn();

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    streamChatMessage: (...args: unknown[]) => streamMock(...args),
    listChatThreads: async () => [],
    saveChatThread: async (id: string, body: { agentId: string }) => ({
      id,
      agentId: body.agentId,
      title: '新对话',
      createdAt: 1,
      updatedAt: 1,
    }),
    resumeChatThread: async () => {
      throw new Error('no thread');
    },
    deleteChatThread: async () => undefined,
    clearChatThreads: async () => undefined,
    api: {
      ...actual.api,
      agents: () => Promise.resolve({ agents: [] }),
    },
  };
});

beforeEach(() => {
  localStorage.removeItem(CHAT_OPEN_THREAD_KEY);
  localStorage.removeItem(CHAT_WINDOWS_KEY);
  localStorage.removeItem(CHAT_CONTEXT_KEY);
  streamMock.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.removeItem(CHAT_OPEN_THREAD_KEY);
  localStorage.removeItem(CHAT_WINDOWS_KEY);
  localStorage.removeItem(CHAT_CONTEXT_KEY);
});

function Harness() {
  const { page, navigate } = useAppNav();
  return (
    <>
      <span data-testid="page">{page}</span>
      <button type="button" onClick={() => navigate('inventory')}>
        去库存
      </button>
      <button type="button" onClick={() => navigate('chat')}>
        去对话页
      </button>
      <ChatProvider>
        {page === 'chat' ? <ChatPage /> : <div>当前业务页</div>}
        <ChatDock />
      </ChatProvider>
    </>
  );
}

describe('右侧 AI 浮窗', () => {
  it('任意业务页都能打开同一份对话，对话整页不再叠一个浮窗', async () => {
    const user = userEvent.setup();
    render(
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          <AppNavProvider>
            <Harness />
          </AppNavProvider>
        </AntApp>
      </ConfigProvider>,
    );

    expect(screen.getByTestId('page')).toHaveTextContent('dashboard');
    const dock = document.querySelector('.chat-dock') as HTMLElement;
    expect(dock.style.position).toBe('fixed');
    expect(dock.style.right).toBe('24px');

    const open = screen.getByRole('button', { name: '打开 AI 对话' });
    expect(open.classList.contains('ant-btn-circle')).toBe(true);
    expect(open.style.width).toBe('56px');
    expect(open.style.height).toBe('56px');
    expect(screen.queryByRole('dialog', { name: 'AI 对话' })).not.toBeInTheDocument();

    await user.click(open);
    const dialog = screen.getByRole('dialog', { name: 'AI 对话' });
    expect(dialog).toHaveTextContent('试试说');
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '2');
    const dockBox = screen.getByLabelText('对话输入');
    const dockBar = dockBox.querySelector('.composer-bar') as HTMLElement;
    expect(dockBox.contains(screen.getByRole('button', { name: '发送' }))).toBe(true);
    expect(dockBar.style.flexWrap).toBe('nowrap');
    const dockSlots = [...dockBar.querySelectorAll('.composer-slot')] as HTMLElement[];
    expect(dockSlots[0]?.style.flexGrow).toBe('1');
    expect(dockSlots[0]?.style.minWidth).toBe('0');
    expect(dockSlots[1]?.style.flexGrow).toBe('1.4');
    expect(dockSlots[1]?.style.minWidth).toBe('0');
    expect(dockBar.contains(screen.getByRole('button', { name: '历史' }))).toBe(false);
    expect(dockBar.contains(screen.getByRole('button', { name: '新对话' }))).toBe(false);
    expect(dockBar.contains(screen.getByRole('button', { name: '新窗口' }))).toBe(false);
    expect(dialog.contains(screen.getByRole('button', { name: '历史' }))).toBe(true);
    const collapse = screen.getByRole('button', { name: '收起 AI 对话' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    const point = (type: string, x: number, y: number) =>
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    const title = screen.getByText('AI 对话');
    title.dispatchEvent(point('pointerdown', 200, 200));
    await act(async () => {
      window.dispatchEvent(point('pointermove', 140, 160));
      window.dispatchEvent(point('pointerup', 140, 160));
    });
    expect(dialog.style.right).toBe('84px');
    expect(dialog.style.bottom).toBe('64px');

    await user.click(collapse);
    expect(screen.queryByRole('dialog', { name: 'AI 对话' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 AI 对话' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '去库存' }));
    expect(screen.getByRole('button', { name: '打开 AI 对话' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '去对话页' }));
    expect(screen.queryByRole('button', { name: '打开 AI 对话' })).not.toBeInTheDocument();
    expect(document.querySelector('.chat-dock')).toBeNull();
    expect(screen.getByRole('heading', { name: 'AI 对话' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '3');
    const pageBox = screen.getByLabelText('对话输入');
    expect(pageBox.contains(screen.getByRole('button', { name: '发送' }))).toBe(true);
    expect((pageBox.querySelector('.composer-bar') as HTMLElement).style.flexWrap).toBe('nowrap');
    expect((pageBox.querySelector('.composer-slot') as HTMLElement).style.flexGrow).toBe('0');
  });

  it('一段还在回复时可以再开一个窗口，两段各说各的', async () => {
    streamMock.mockImplementation((...args: unknown[]) => {
      const message = args[1];
      const onEvent = args[3] as (ev: ChatStreamEvent) => void;
      const signal = args[7] as AbortSignal | undefined;
      if (message === '另一件事') {
        onEvent({ type: 'text-delta', text: '第二窗好了' });
        onEvent({ type: 'turn-done', steps: 1 });
        return Promise.resolve();
      }
      onEvent({ type: 'text-delta', text: '写到一半' });
      return new Promise<void>((_resolve, reject) => {
        const abort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const user = userEvent.setup();
    render(
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          <AppNavProvider>
            <ChatProvider>
              <ChatDock />
            </ChatProvider>
          </AppNavProvider>
        </AntApp>
      </ConfigProvider>,
    );
    await user.click(screen.getByRole('button', { name: '打开 AI 对话' }));
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('查库存');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('写到一半')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新窗口' }));
    expect(screen.getAllByRole('dialog', { name: 'AI 对话' })).toHaveLength(1);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(screen.queryByText('写到一半')).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: '对话窗口' })).toBeInTheDocument();

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('另一件事');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('第二窗好了')).toBeInTheDocument();
    expect(screen.queryByText('写到一半')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '切换到 查库存' }));
    expect(await screen.findByText('写到一半')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
    expect(screen.queryByText('第二窗好了')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(await screen.findByText('已停止')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '切换到 另一件事' }));
    expect(await screen.findByText('第二窗好了')).toBeInTheDocument();
    expect(screen.queryByText('写到一半')).not.toBeInTheDocument();
  });
});
