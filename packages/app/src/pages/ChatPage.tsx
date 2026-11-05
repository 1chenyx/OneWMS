import { useEffect, useRef, useState } from 'react';
import { SendOutlined } from '@ant-design/icons';
import { Button, Card, Input, Segmented, Space, Spin, Typography } from 'antd';
import { api } from '../api/client';
import type { AgentDef } from '../api/client';
import { useChatSession } from '../chat/ChatProvider';
import { useAppNav } from '../app-nav';
import ToolInvocationCard from '../components/ToolInvocationCard';

/**
 * AI 对话面板（M12：SSE 流式 + 会话化；M16：多助手切换）：
 *  - 状态在 ChatProvider（App 级 context）——切页不丢对话；
 *  - 输入区上方 Segmented 切换助手（选项来自 GET /api/agents；「使用 AI」与
 *    「配置 AI」分离——定义改动走管理页 + 配置确认，聊天里只有切换权）；
 *    切换 = 换新会话 + 清空历史（流式中锁定）；
 *  - 流式渲染：工具卡先落「执行中」态、tool-result 回填，助手文本逐 delta 增长；
 *  - 工具调用过程可见（可审计）；成功的工具卡带后置动作按钮（步骤4）：
 *    profile.propose → 去配置确认、库存/单据操作 → 去对应管理页（带过滤）、
 *    临期查询 → 去效期看板（单 SKU 结果带过滤预填，M15）。
 */
export default function ChatPage() {
  const chat = useChatSession();
  const { navigate } = useAppNav();
  const [input, setInput] = useState('');
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // 助手清单（M16）：挂载拉取；失败静默——仅显示当前 agentId，切换器空态可接受
  useEffect(() => {
    let alive = true;
    api
      .agents()
      .then((catalog) => alive && setAgents(catalog.agents))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [chat.turns]);

  const send = () => {
    const text = input.trim();
    if (!text || chat.isStreaming) return;
    setInput('');
    void chat.send(text);
  };

  return (
    <Card
      style={{ width: '100%', maxWidth: 860, margin: '0 auto', flex: 1, display: 'flex', flexDirection: 'column' }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      title="AI 助手"
      extra={<Typography.Text type="secondary">自然语言出入库 / 改配置</Typography.Text>}
    >
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}>
        {chat.turns.length === 0 ? (
          <Typography.Paragraph type="secondary" style={{ padding: 24 }}>
            试试说：「建一个 SKU：A-1001 轴承」「A-1001 入库 50 个」「帮我把规格字段隐藏」。
            改配置类请求会生成待确认提议，由你最终拍板。
          </Typography.Paragraph>
        ) : null}
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {chat.turns.map((turn, idx) => (
            <div key={idx}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <Typography.Text style={{ background: '#e6f4ff', padding: '6px 12px', borderRadius: 8 }}>
                  {turn.userText}
                </Typography.Text>
              </div>
              {turn.invocations.map((inv) => (
                <div key={inv.callId} style={{ marginBottom: 8 }}>
                  <ToolInvocationCard
                    invocation={inv}
                    onAnswer={chat.answerAsk}
                    onNavigate={navigate}
                  />
                </div>
              ))}
              {turn.assistantText ? (
                <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {turn.assistantText}
                </Typography.Paragraph>
              ) : null}
              {turn.failed ? (
                <Typography.Paragraph type="danger" style={{ marginBottom: 0 }}>
                  {turn.failed}
                </Typography.Paragraph>
              ) : null}
            </div>
          ))}
          {chat.isStreaming ? <Spin tip="思考中…" /> : null}
        </Space>
      </div>
      <Space.Compact style={{ marginTop: 12 }} block>
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="输入指令，Enter 发送（Shift+Enter 换行）"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={chat.isStreaming}
        />
        <Button type="primary" icon={<SendOutlined />} onClick={send} loading={chat.isStreaming}>
          发送
        </Button>
      </Space.Compact>
      {/* 助手切换（M16）：流式中锁定；定义的管理入口在「助手管理」页（高权限分离） */}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Segmented
          value={chat.agentId}
          onChange={(v) => chat.setAgentId(v as string)}
          disabled={chat.isStreaming}
          options={agents.map((a) => ({ label: a.name, value: a.id, title: a.description }))}
        />
        <Typography.Link onClick={() => navigate('agents')}>管理助手</Typography.Link>
      </div>
    </Card>
  );
}
