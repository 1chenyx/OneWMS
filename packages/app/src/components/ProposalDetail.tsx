import { App as AntApp, Button, Descriptions, Popconfirm, Space, Spin, Table, Tag, Typography } from 'antd';
import type { PatchOp } from '@one/core';
import { useConfirmProposal, useProposalDetail, useRejectProposal } from '../api/hooks';
import { ApiError } from '../api/client';
import ImpactReportView from './ImpactReportView';

/**
 * 提议详情：note/patch 摘要 + 影响报告 + 确认/拒绝（§4.1 人工确认权）。
 * 确认后的错误按 code 分支提示：409 STALE = 报告已过期（配置变了，请重新提议）。
 */
export default function ProposalDetail({ proposalId, onDone }: { proposalId: string; onDone: () => void }) {
  const { message } = AntApp.useApp();
  const detail = useProposalDetail(proposalId);
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();

  if (detail.isLoading) return <Spin />;
  if (detail.error) return <div>加载失败：{String((detail.error as Error).message)}</div>;
  const proposal = detail.data!;

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
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="提议人">
          <Typography.Text code>{proposal.proposedBy}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="基于版本">v{proposal.baseVersion}</Descriptions.Item>
        <Descriptions.Item label="说明" span={2}>
          {proposal.note ?? '（无说明）'}
        </Descriptions.Item>
      </Descriptions>

      <div>
        <Typography.Title level={5}>变更内容（JSON Patch）</Typography.Title>
        <Table<PatchOp>
          size="small"
          rowKey={(op) => `${op.op}:${op.path}`}
          pagination={false}
          dataSource={proposal.patch}
          columns={[
            {
              title: '操作',
              dataIndex: 'op',
              width: 90,
              render: (op: string) => (
                <Tag
                  color={op === 'remove' ? 'red' : op === 'add' ? 'green' : 'blue'}
                  bordered={false}
                >
                  {op}
                </Tag>
              ),
            },
            { title: '路径', dataIndex: 'path', render: (p: string) => <Typography.Text code>{p}</Typography.Text> },
            {
              title: '值',
              dataIndex: 'value',
              render: (v: unknown) => (
                <Typography.Text code style={{ fontSize: 12 }}>
                  {JSON.stringify(v)}
                </Typography.Text>
              ),
            },
          ]}
        />
      </div>

      <div>
        <Typography.Title level={5}>影响报告</Typography.Title>
        <ImpactReportView report={proposal.report} />
      </div>

      <Space>
        <Popconfirm
          title="确认应用这份配置变更？"
          description="应用后立即生效（热应用，可追溯）。"
          okText="应用"
          cancelText="再想想"
          onConfirm={doConfirm}
        >
          <Button type="primary" loading={confirm.isPending}>
            确认应用
          </Button>
        </Popconfirm>
        <Popconfirm title="拒绝这份提议？" okText="确认拒绝" cancelText="取消" onConfirm={doReject}>
          <Button danger loading={reject.isPending}>
            拒绝
          </Button>
        </Popconfirm>
      </Space>
    </Space>
  );
}
