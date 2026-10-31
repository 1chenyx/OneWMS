import { useState } from 'react';
import { Badge, Card, Empty, List, Space, Typography } from 'antd';
import { useProposals } from '../api/hooks';
import ProposalDetail from '../components/ProposalDetail';

/**
 * 配置确认页（慢通道闭环的人工侧，§4.1）：
 * pending 提议列表 + 详情展开。列表为空 = 没有待确认的变更。
 */
export default function ProposalsPage() {
  const { data: proposals, isLoading } = useProposals();
  const [activeId, setActiveId] = useState<string | null>(null);

  if (isLoading) return <Card loading />;

  if (!proposals || proposals.length === 0) {
    return (
      <Card>
        <Empty description="暂无待确认的配置提议">
          <Typography.Text type="secondary">
            在 AI 对话里说「隐藏某个字段」「调整流程」，AI 会生成提议出现在这里。
          </Typography.Text>
        </Empty>
      </Card>
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }} align="start">
      <Card style={{ width: '100%' }} title={<Badge count={proposals.length}>待确认提议</Badge>}>
        <List
          dataSource={proposals}
          renderItem={(p) => (
            <List.Item
              actions={[
                <a key="open" onClick={() => setActiveId(p.proposalId === activeId ? null : p.proposalId)}>
                  {p.proposalId === activeId ? '收起' : '查看详情'}
                </a>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text code>{p.proposedBy}</Typography.Text>
                    <Typography.Text type="secondary">基于 v{p.baseVersion}</Typography.Text>
                  </Space>
                }
                description={p.note ?? p.summary}
              />
            </List.Item>
          )}
        />
      </Card>
      {activeId ? (
        <Card style={{ width: '100%' }} title="提议详情">
          <ProposalDetail proposalId={activeId} onDone={() => setActiveId(null)} />
        </Card>
      ) : null}
    </Space>
  );
}
