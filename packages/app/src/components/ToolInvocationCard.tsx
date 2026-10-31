import { Card, Descriptions, Tag, Typography } from 'antd';
import type { ChatInvocation } from '../api/client';

/**
 * 工具调用过程卡片：让「AI 经工具总线操作」对用户可见可审计（§9.3 透明度）。
 * 成/败分色 + 参数与结果摘要（折叠态保持简洁，展开看细节）。
 */
export default function ToolInvocationCard({ invocation }: { invocation: ChatInvocation }) {
  const errorText =
    !invocation.ok && invocation.payload && typeof invocation.payload === 'object'
      ? String((invocation.payload as { error?: unknown }).error ?? '')
      : '';
  return (
    <Card
      size="small"
      style={{ maxWidth: 640 }}
      title={
        <>
          <Tag color={invocation.ok ? 'green' : 'red'} bordered={false}>
            {invocation.ok ? '成功' : '被拒'}
          </Tag>
          <Typography.Text code>{invocation.toolId}</Typography.Text>
        </>
      }
    >
      <Descriptions column={1} size="small">
        <Descriptions.Item label="参数">
          <Typography.Text code style={{ fontSize: 12 }}>
            {JSON.stringify(invocation.args)}
          </Typography.Text>
        </Descriptions.Item>
        {!invocation.ok && errorText ? (
          <Descriptions.Item label="原因">
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {errorText}
            </Typography.Text>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
    </Card>
  );
}
