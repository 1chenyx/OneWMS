import { useState } from 'react';
import { Button, Input, Space, Typography } from 'antd';

/**
 * ui.ask 交互卡（M12 步骤3）：模型挂起向用户提问 → 回答 / 跳过。
 * 提交后本地锁定输入（已发送态），终态由 tool-result 事件回填
 * ToolInvocationCard 切换为问答回显——回答本身经 answer 端点注入原 SSE 流。
 */
export default function AskCard({
  callId,
  question,
  onAnswer,
}: {
  callId: string;
  question: string;
  onAnswer: (callId: string, answer: string | null) => void;
}) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const submit = () => {
    const trimmed = text.trim();
    if (submitted || !trimmed) return;
    setSubmitted(true);
    onAnswer(callId, trimmed);
  };

  return (
    <div>
      <Typography.Paragraph style={{ marginBottom: 8 }}>{question}</Typography.Paragraph>
      <Space.Compact block>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPressEnter={submit}
          placeholder="输入回答，Enter 提交"
          disabled={submitted}
        />
        <Button type="primary" onClick={submit} disabled={submitted || !text.trim()}>
          提交
        </Button>
        <Button
          onClick={() => {
            if (submitted) return;
            setSubmitted(true);
            onAnswer(callId, null);
          }}
          disabled={submitted}
        >
          跳过
        </Button>
      </Space.Compact>
    </div>
  );
}
