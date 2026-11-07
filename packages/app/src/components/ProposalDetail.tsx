import { Alert, App as AntApp, Button, List, Space, Spin, Typography } from 'antd';
import { useConfirmProposal, useProposalDetail, useRejectProposal } from '../api/hooks';
import { ApiError } from '../api/client';

/**
 * 配置确认正文：人话说明这次改成什么样、有什么影响。
 * 弹窗本身就是拍板，不再套一层二次确认。
 * 确认后的错误按 code 分支提示：409 STALE = 报告已过期（配置变了，请重新提议）。
 */
export default function ProposalDetail({
  proposalId,
  onDone,
  onLater,
}: {
  proposalId: string;
  onDone: () => void;
  /** 先不拍板，提议仍留着 */
  onLater?: () => void;
}) {
  const { message } = AntApp.useApp();
  const detail = useProposalDetail(proposalId);
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();

  if (detail.isLoading) return <Spin />;
  if (detail.error) return <div>加载失败：{String((detail.error as Error).message)}</div>;
  const proposal = detail.data!;
  const warnings = proposal.report.items.filter((item) => item.severity === 'warning');

  const doConfirm = async () => {
    try {
      // by 不传：服务端补全确认者（带节点后缀，前端无需知晓 nodeId）
      const r = await confirm.mutateAsync({ id: proposalId });
      message.success(`已应用（配置版本 v${r.newVersion}，${r.appliedOps} 项变更）`);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PROPOSAL_STALE') {
        message.warning('提议已过期：生成报告后配置发生了变化，请让 AI 重新提议。');
        onDone();
      } else if (e instanceof ApiError) {
        message.error(`应用失败（${e.code}）：${e.message}`);
      }
    }
  };

  const doReject = async () => {
    await reject.mutateAsync(proposalId);
    message.info('已拒绝该提议（未产生任何变更）。');
    onDone();
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Typography.Text type="secondary">这次要改</Typography.Text>
        <Typography.Paragraph style={{ margin: '4px 0 0', fontSize: 16 }}>
          {proposal.note ?? proposal.report.summary}
        </Typography.Paragraph>
        <Typography.Text type="secondary">基于当前配置 v{proposal.baseVersion}</Typography.Text>
      </div>

      <div>
        <Typography.Text strong>将改成</Typography.Text>
        <List
          dataSource={proposal.report.items}
          locale={{ emptyText: '报告里没有具体改动' }}
          split={false}
          renderItem={(item) => (
            <List.Item style={{ padding: '6px 0', border: 'none' }}>
              <Alert
                style={{ width: '100%' }}
                type={item.severity === 'warning' ? 'warning' : 'info'}
                showIcon
                message={item.description}
              />
            </List.Item>
          )}
        />
      </div>

      <div>
        <Typography.Text strong>影响</Typography.Text>
        <Typography.Paragraph style={{ margin: '4px 0 8px' }}>{proposal.report.summary}</Typography.Paragraph>
        {warnings.length > 0 ? (
          <Alert type="warning" showIcon message={`有 ${warnings.length} 项需要注意。确认后立刻生效。`} />
        ) : (
          <Alert type="success" showIcon message="没有额外风险。确认后立刻生效，这次变更可以追溯。" />
        )}
      </div>

      <Space wrap>
        <Button type="primary" loading={confirm.isPending} onClick={() => void doConfirm()}>
          确认应用
        </Button>
        <Button danger loading={reject.isPending} onClick={() => void doReject()}>
          拒绝
        </Button>
        {onLater ? <Button onClick={onLater}>先放着</Button> : null}
      </Space>
    </Space>
  );
}
