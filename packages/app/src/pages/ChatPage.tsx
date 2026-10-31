import { useRef, useState } from 'react';
import { SendOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Input, Space, Spin, Typography } from 'antd';
import { useChat } from '../api/hooks';
import { ApiError } from '../api/client';
import ToolInvocationCard from '../components/ToolInvocationCard';

/** 一轮对话的展示单元：用户消息 → 工具过程卡片们 → 助手最终回复 */
interface ChatTurn {
  userText: string;
  invocations: { toolId: string; args: Record<string, unknown>; ok: boolean; payload: unknown }[];
  assistantText?: string;
  failed?: string;
}

/**
 * AI 对话面板（快通道 + 慢通道入口）：
 * - 对话历史仅前端内存（v1 单轮任务式，刷新即弃）；
 * - 工具调用过程可见（可审计）；profile.propose 的结果会引导去「配置确认」页。
 */
export default function ChatPage() {
  const { message } = AntApp.useApp();
  const chat = useChat();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || chat.isPending) return;
    setInput('');
    try {
      const r = await chat.mutateAsync(text);
      setTurns((prev) => [...prev, { userText: text, invocations: r.invocations, assistantText: r.text }]);
      // AI 提交了配置提议 → 引导去确认页（慢通道闭环）
      if (r.invocations.some((i) => i.toolId === 'profile.propose' && i.ok)) {
        message.info('AI 已提交配置提议，请到「配置确认」页查看影响报告并确认。');
      }
    } catch (e) {
      const errMsg =
        e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED'
          ? '未配置 AI 服务（需要在服务端设置 ONE_AI_MODEL 等环境变量）。'
          : `请求失败：${e instanceof Error ? e.message : String(e)}`;
      setTurns((prev) => [...prev, { userText: text, invocations: [], failed: errMsg }]);
    }
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }));
  };

  return (
    <Card
      style={{ width: '100%', maxWidth: 860, margin: '0 auto', flex: 1, display: 'flex', flexDirection: 'column' }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      title="AI 助手"
      extra={<Typography.Text type="secondary">自然语言出入库 / 改配置</Typography.Text>}
    >
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', paddingRight: 8 }}>
        {turns.length === 0 ? (
          <Typography.Paragraph type="secondary" style={{ padding: 24 }}>
            试试说：「建一个 SKU：A-1001 轴承」「A-1001 入库 50 个」「帮我把规格字段隐藏」。
            改配置类请求会生成待确认提议，由你最终拍板。
          </Typography.Paragraph>
        ) : null}
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {turns.map((turn, idx) => (
            <div key={idx}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <Typography.Text style={{ background: '#e6f4ff', padding: '6px 12px', borderRadius: 8 }}>
                  {turn.userText}
                </Typography.Text>
              </div>
              {turn.invocations.map((inv, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <ToolInvocationCard invocation={inv} />
                </div>
              ))}
              {turn.assistantText ? (
                <Typography.Paragraph style={{ marginBottom: 0 }}>{turn.assistantText}</Typography.Paragraph>
              ) : null}
              {turn.failed ? (
                <Typography.Paragraph type="danger" style={{ marginBottom: 0 }}>
                  {turn.failed}
                </Typography.Paragraph>
              ) : null}
            </div>
          ))}
          {chat.isPending ? <Spin tip="思考中…" /> : null}
        </Space>
      </div>
      <Space.Compact style={{ marginTop: 12 }} block>
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="输入指令，Enter 发送（Shift+Enter 换行）"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={chat.isPending}
        />
        <Button type="primary" icon={<SendOutlined />} onClick={send} loading={chat.isPending}>
          发送
        </Button>
      </Space.Compact>
    </Card>
  );
}
