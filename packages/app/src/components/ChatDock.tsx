import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseOutlined, RobotOutlined } from '@ant-design/icons';
import { Badge, Button, ConfigProvider, Tooltip } from 'antd';
import { useAppNav } from '../app-nav';
import { useChatSession } from '../chat/ChatProvider';
import ChatPage from '../pages/ChatPage';
import { face } from '../theme';

/**
 * 右侧圆形助手。除「AI 对话」整页以外，每个页面都能打开同一份对话。
 * 会话在 ChatProvider 里，关掉浮窗或切页都还在。
 * 已经在对话页时不挂浮窗，避免同一个会话出现两个输入框。
 */
export default function ChatDock() {
  const { page } = useAppNav();
  const chat = useChatSession();
  const [open, setOpen] = useState(false);

  if (page === 'chat' || typeof document === 'undefined') return null;

  const launcher = (
    <Button
      className="chat-dock-launcher"
      shape="circle"
      aria-label={open ? '收起 AI 对话' : '打开 AI 对话'}
      aria-expanded={open}
      aria-controls="chat-dock-panel"
      icon={open ? <CloseOutlined /> : <RobotOutlined />}
      onClick={() => setOpen((value) => !value)}
      style={{ width: 56, height: 56, fontSize: 18 }}
    />
  );

  return createPortal(
    // 浮窗压在页面和抽屉上面。里面的下拉、确认框用更高的弹出层，避免被浮窗挡住。
    <ConfigProvider theme={{ token: { zIndexPopupBase: 2000 } }}>
      <div
        className="chat-dock"
        style={{
          position: 'fixed',
          right: 24,
          bottom: 24,
          zIndex: 1100,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 12,
        }}
      >
        {open ? (
          <section
            id="chat-dock-panel"
            role="dialog"
            aria-label="AI 对话"
            style={{
              width: 'min(400px, calc(100vw - 48px))',
              height: 'min(640px, calc(100vh - 116px))',
              background: face.card,
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.06)',
              border: `1px solid ${face.line}`,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '12px 12px 12px 16px',
                borderBottom: `1px solid ${face.line}`,
                flex: 'none',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500, lineHeight: 1.3 }}>AI 对话</div>
                <div style={{ fontSize: 12, color: face.text2 }}>自然语言出入库 / 改配置</div>
              </div>
              <Button type="text" aria-label="关闭 AI 对话" icon={<CloseOutlined />} onClick={() => setOpen(false)} />
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: 12, display: 'flex' }}>
              <ChatPage variant="dock" />
            </div>
          </section>
        ) : null}
        <Tooltip title={open ? undefined : 'AI 对话'} placement="left">
          {chat.isStreaming && !open ? (
            <Badge dot color={face.amberInk} offset={[-6, 6]}>
              {launcher}
            </Badge>
          ) : (
            launcher
          )}
        </Tooltip>
      </div>
    </ConfigProvider>,
    document.body,
  );
}
