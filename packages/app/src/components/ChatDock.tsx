import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { RobotOutlined } from '@ant-design/icons';
import { Badge, Button, ConfigProvider, Tooltip } from 'antd';
import { useAppNav } from '../app-nav';
import { useChatSession } from '../chat/ChatProvider';
import ChatPage from '../pages/ChatPage';
import { face } from '../theme';

/**
 * 右侧圆形助手。除「AI 对话」整页以外，每个页面都能打开对话。
 * 会话在 ChatProvider 里，收起浮窗或切页都还在。
 * 一次只摆一块面板，多段对话在面板里用页签切换，避免横着铺满页面。
 * 按住标题可以拖开。已经在对话页时不挂浮窗。
 */

const DOCK_INSET = 24;
const DOCK_MARGIN = 8;

function clampDockOffset(x: number, y: number, panel: HTMLElement | null): { x: number; y: number } {
  const rect = panel?.getBoundingClientRect();
  const panelW = rect && rect.width > 0 ? rect.width : 420;
  const panelH = rect && rect.height > 0 ? rect.height : 560;
  const minX = DOCK_MARGIN - window.innerWidth + DOCK_INSET + panelW;
  const maxX = DOCK_INSET - DOCK_MARGIN;
  const minY = DOCK_MARGIN - window.innerHeight + DOCK_INSET + panelH;
  const maxY = DOCK_INSET - DOCK_MARGIN;
  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  };
}

export default function ChatDock() {
  const { page } = useAppNav();
  const chat = useChatSession();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  const panelRef = useRef<HTMLElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);

  useEffect(() => () => stopDrag.current?.(), []);

  if (page === 'chat' || typeof document === 'undefined') return null;

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, input, textarea')) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = offsetRef.current.x;
    const originY = offsetRef.current.y;
    const move = (ev: PointerEvent) => {
      const next = clampDockOffset(originX + ev.clientX - startX, originY + ev.clientY - startY, panelRef.current);
      offsetRef.current = next;
      setOffset(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      stopDrag.current = null;
    };
    stopDrag.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const launcher = (
    <Button
      className="chat-dock-launcher"
      shape="circle"
      aria-label="打开 AI 对话"
      aria-expanded={false}
      aria-controls="chat-dock-panel"
      icon={<RobotOutlined />}
      onClick={() => setOpen(true)}
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
          right: DOCK_INSET,
          bottom: DOCK_INSET,
          zIndex: 1100,
        }}
      >
        {open ? (
          <section
            ref={panelRef}
            id="chat-dock-panel"
            role="dialog"
            aria-label="AI 对话"
            style={{
              position: 'fixed',
              right: DOCK_INSET - offset.x,
              bottom: DOCK_INSET - offset.y,
              width: 'min(420px, calc(100vw - 16px))',
              height: 'min(560px, calc(100vh - 16px))',
              background: face.card,
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.06)',
              border: `1px solid ${face.line}`,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <ChatPage
              variant="dock"
              windowId={chat.activeWindowId}
              showStrip
              onCollapse={() => setOpen(false)}
              onDragHandlePointerDown={startDrag}
            />
          </section>
        ) : (
          <Tooltip title="AI 对话" placement="left">
            {chat.anyStreaming && !open ? (
              <Badge dot color={face.amberInk} offset={[-6, 6]}>
                {launcher}
              </Badge>
            ) : (
              launcher
            )}
          </Tooltip>
        )}
      </div>
    </ConfigProvider>,
    document.body,
  );
}
