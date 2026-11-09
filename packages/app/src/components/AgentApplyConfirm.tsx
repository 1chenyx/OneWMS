import { Button, List, Space, Typography } from 'antd';

/**
 * 助手管理自己的确认。只说明哪些助手要改成什么样。
 * 对话页的配置确认是另一套，不从这里进。
 */
export default function AgentApplyConfirm({
  lines,
  applying,
  discarding,
  onApply,
  onDiscard,
  onLater,
}: {
  lines: string[];
  applying: boolean;
  discarding: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onLater: () => void;
}) {
  const busy = applying || discarding;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Typography.Text type="secondary">这次要改的助手</Typography.Text>
        <List
          dataSource={lines.length > 0 ? lines : ['和当前生效的助手一样。']}
          split={false}
          renderItem={(line) => (
            <List.Item style={{ padding: '6px 0', border: 'none' }}>
              <Typography.Text style={{ fontSize: 16 }}>{line}</Typography.Text>
            </List.Item>
          )}
        />
      </div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        确认后立刻生效。放弃则保持现在的助手不变。
      </Typography.Paragraph>
      <Space wrap>
        <Button type="primary" loading={applying} disabled={busy && !applying} onClick={onApply}>
          确认应用
        </Button>
        <Button danger loading={discarding} disabled={busy && !discarding} onClick={onDiscard}>
          放弃
        </Button>
        <Button disabled={busy} onClick={onLater}>
          先放着
        </Button>
      </Space>
    </Space>
  );
}
