import { useState } from 'react';
import { DeleteOutlined, HistoryOutlined, PlusOutlined, PlusSquareOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Input, Popconfirm, Popover, Space, Typography } from 'antd';
import { MAX_CHAT_WINDOWS, useChatScope } from './ChatProvider';

/**
 * 新对话和历史。整页放在标题右侧；浮窗放在面板顶上，和收起分开。
 * 历史按标题筛选。点开一段可以接着聊。清空时正在看的这一段留下。
 */

function formatThreadTime(ts: number): string {
  const date = new Date(ts);
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

export default function ChatThreadActions({
  variant,
  agents,
}: {
  variant: 'page' | 'dock';
  agents: readonly { id: string; name: string }[];
}) {
  const chat = useChatScope();
  const { modal } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dock = variant === 'dock';
  const keyword = query.trim().toLowerCase();
  const shown = keyword ? chat.threads.filter((item) => item.title.toLowerCase().includes(keyword)) : chat.threads;
  const canClear = chat.threads.some((item) => item.id !== chat.threadId);

  const confirmClear = () => {
    modal.confirm({
      title: '清空全部历史对话？',
      content: '正在进行的这一段会留下。',
      okText: '清空',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => chat.clearThreads(),
    });
  };

  const history = (
    <div style={{ width: 300 }}>
      <Input
        allowClear
        size="small"
        placeholder="搜索标题"
        aria-label="搜索历史对话"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 8 }}>
        {shown.length === 0 ? (
          <Typography.Text type="secondary">{keyword ? '没有匹配的对话' : '还没有历史对话'}</Typography.Text>
        ) : (
          shown.map((thread) => {
            const agentName = agents.find((agent) => agent.id === thread.agentId)?.name ?? '助手';
            const current = thread.id === chat.threadId;
            return (
              <div key={thread.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    void chat.openThread(thread.id);
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    border: 'none',
                    background: current ? '#f4f4f5' : 'transparent',
                    boxShadow: current ? 'inset 3px 0 0 #e6b325' : 'none',
                    borderRadius: 8,
                    padding: '8px',
                    cursor: 'pointer',
                    font: 'inherit',
                    color: 'inherit',
                  }}
                >
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                    {thread.title}
                  </div>
                  <div style={{ fontSize: 12, color: '#737373', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {agentName} · {formatThreadTime(thread.updatedAt)}
                  </div>
                </button>
                <Popconfirm
                  title="删除这段对话？"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => chat.deleteThread(thread.id)}
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label={`删除 ${thread.title}`}
                    icon={<DeleteOutlined aria-hidden />}
                    disabled={chat.windows.some((win) => win.threadId === thread.id && win.streaming)}
                  />
                </Popconfirm>
              </div>
            );
          })
        )}
      </div>
      <div style={{ borderTop: '1px solid #f0f0f0', marginTop: 8, paddingTop: 4, textAlign: 'right' }}>
        <Button type="link" size="small" danger disabled={!canClear || chat.anyStreaming} onClick={confirmClear}>
          清空历史
        </Button>
      </div>
    </div>
  );

  const historyButton = (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void chat.refreshThreads();
        else setQuery('');
      }}
      placement="bottomRight"
      content={history}
    >
      <Button
        type={dock ? 'text' : 'default'}
        size={dock ? 'small' : 'middle'}
        aria-label="历史"
        title="历史"
        icon={<HistoryOutlined aria-hidden />}
        style={dock ? { flex: 'none' } : undefined}
      >
        历史
      </Button>
    </Popover>
  );

  const fresh = (
    <Button
      type={dock ? 'text' : 'default'}
      size={dock ? 'small' : 'middle'}
      aria-label="新对话"
      title="新对话"
      icon={<PlusOutlined aria-hidden />}
      disabled={chat.isStreaming || chat.turns.length === 0}
      onClick={() => chat.newChat()}
      style={dock ? { flex: 'none' } : undefined}
    >
      新对话
    </Button>
  );

  const another = (
    <Button
      type={dock ? 'text' : 'default'}
      size={dock ? 'small' : 'middle'}
      aria-label="新窗口"
      title="新窗口"
      icon={<PlusSquareOutlined aria-hidden />}
      disabled={chat.windowCount >= MAX_CHAT_WINDOWS}
      onClick={() => chat.openWindow()}
      style={dock ? { flex: 'none' } : undefined}
    >
      新窗口
    </Button>
  );

  if (dock) {
    return (
      <>
        {historyButton}
        {fresh}
        {another}
      </>
    );
  }
  return (
    <Space>
      {historyButton}
      {fresh}
      {another}
    </Space>
  );
}
