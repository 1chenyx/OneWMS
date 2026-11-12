import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import { CHAT_OPEN_THREAD_KEY, ChatProvider } from '../src/chat/ChatProvider';
import ChatDock from '../src/components/ChatDock';
import ChatPage from '../src/pages/ChatPage';

vi.mock('../src/api/hooks', () => ({
  useProposals: () => ({ isLoading: false, data: [], refetch: vi.fn() }),
  useAiConfig: () => ({ isLoading: false, data: { configured: true, source: 'file', profiles: [] } }),
}));

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
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

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.removeItem(CHAT_OPEN_THREAD_KEY);
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

    expect(screen.getByTestId('page')).toHaveTextContent('skus');
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
    expect(screen.getByRole('button', { name: '收起 AI 对话' })).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('button', { name: '关闭 AI 对话' }));
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
});
