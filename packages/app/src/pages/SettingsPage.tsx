import { useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd';
import type { ModuleConfig, ProfileSnapshot } from '@one/core';
import {
  DownloadOutlined,
  LinkOutlined,
  NodeIndexOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import {
  useMigrationImport,
  useNodeHello,
  useProfileSnapshot,
  useProposeProfile,
  useConfirmProposal,
  useSyncRun,
} from '../api/hooks';
import PageHeader from '../components/PageHeader';

/**
 * 设置页（M8/M21）——同步/迁移的用户面收口 + 流程与模块配置。
 * 定位：触发器 + 状态显示器（不引入新服务端状态——peers 每次随请求发送，
 * 服务端 env 是唯一持久位）。
 */

export default function SettingsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader title="设置" subtitle="节点身份、局域网同步、数据迁移与流程模块配置" />
      <Tabs
        defaultActiveKey="node"
        items={[
          { key: 'node', icon: <NodeIndexOutlined />, label: '节点', children: <NodeTab /> },
          { key: 'sync', icon: <LinkOutlined />, label: '局域网同步', children: <SyncTab /> },
          { key: 'migration', icon: <SyncOutlined />, label: '迁移', children: <MigrationTab /> },
          { key: 'flow', icon: <NodeIndexOutlined />, label: '流程与模块', children: <FlowModulesPanel /> },
        ]}
      />
    </div>
  );
}

/** ① 节点名片（只读——/api/sync/hello 既是握手端点也是节点自省） */
function NodeTab() {
  const { data: hello, isLoading } = useNodeHello();
  if (isLoading || !hello) return <Card loading />;
  return (
    <Card title="本节点">
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="节点 ID">{hello.nodeId}</Descriptions.Item>
        <Descriptions.Item label="工作区">{hello.workspaceId}</Descriptions.Item>
        <Descriptions.Item label="配置版本">v{hello.profileVersion}</Descriptions.Item>
        <Descriptions.Item label="事件总数">{hello.eventCount}</Descriptions.Item>
        <Descriptions.Item label="写入通道">{Object.keys(hello.watermarks).length} 个</Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        节点 ID 与工作区 ID 是同步组身份——两节点要同步，工作区 ID 必须一致（同步组不一致会被拒绝）。
      </Typography.Paragraph>
    </Card>
  );
}

/** ② 局域网同步：手动跑一轮拉取（对等节点直连，明文可信段） */
function SyncTab() {
  const { message } = AntApp.useApp(); // App 上下文实例（notice 容器随组件树卸载，不用全局静态 message）
  const [peersText, setPeersText] = useState('');
  const run = useSyncRun();

  const doRun = async () => {
    const peers = peersText.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
    if (peers.length === 0) {
      message.warning('请先填写对端地址（逗号或换行分隔）');
      return;
    }
    try {
      const { results } = await run.mutateAsync(peers);
      message.success(`同步完成：${results.length} 个节点`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `同步失败：${String(e)}`);
    }
  };

  return (
    <Card title="局域网同步（拉模型回合）">
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          placeholder="对端地址，如 http://192.168.1.20:3000（多个用逗号分隔）"
          value={peersText}
          onChange={(e) => setPeersText(e.target.value)}
          onPressEnter={doRun}
        />
        <Button type="primary" loading={run.isPending} onClick={doRun}>
          立即同步
        </Button>
      </Space.Compact>
      {run.data && (
        <Descriptions title="回合结果" column={1} bordered size="small">
          {run.data.results.map((r, i) => (
            <Descriptions.Item key={i} label={r.peer}>
              <Space>
                <Tag color={r.status === 'synced' ? 'green' : r.status === 'no-op' ? 'blue' : 'red'}>
                  {r.status}
                </Tag>
                <span>
                  拉取 {r.pulled} 条 / 接受 {r.accepted} / 跳过 {r.skipped}
                  {r.replayed ? ' / 已重建投影' : ''}
                </span>
                {r.message && <Typography.Text type="danger">{r.message}</Typography.Text>}
              </Space>
            </Descriptions.Item>
          ))}
        </Descriptions>
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        同步 = 全量事件交换 + 投影重建（本地优先，无服务器依赖）；地址不持久化，服务端 ONE_SYNC_PEERS 是默认值。
      </Typography.Paragraph>
    </Card>
  );
}

/** ③ 迁移：导出迁移包（明文 JSON，本地可信域）/ 导入并全量重放 */
function MigrationTab() {
  const { message } = AntApp.useApp();
  const importBundle = useMigrationImport();
  const [fileList, setFileList] = useState<UploadFile[]>([]);

  const doExport = async () => {
    try {
      const bundle = await api.migrationExport();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `onewms-migration-${(bundle as { workspaceId?: string }).workspaceId ?? 'workspace'}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('迁移包已导出（含全部事件，明文文件请妥善保管）');
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `导出失败：${String(e)}`);
    }
  };

  const doImport = async () => {
    const file = fileList[0]?.originFileObj;
    if (!file) {
      message.warning('请先选择迁移包文件');
      return;
    }
    try {
      const bundle = JSON.parse(await file.text());
      const r = await importBundle.mutateAsync(bundle);
      message.success(`导入完成：接受 ${r.accepted} 条 / 跳过 ${r.skipped} 条`);
      setFileList([]);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `导入失败：${String(e)}`);
    }
  };

  return (
    <Card title="迁移（整工作区搬家）">
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div>
          <Typography.Paragraph>
            导出 = 全部事件按全序打包（Profile 与库存等投影是事件的派生，导入重放后自动恢复）。
          </Typography.Paragraph>
          <Button type="primary" icon={<DownloadOutlined />} onClick={doExport}>
            导出迁移包
          </Button>
        </div>
        <div>
          <Typography.Paragraph>导入 = 事件幂等落账（重复导入零新事件）+ 投影全量重建。</Typography.Paragraph>
          <Space>
            <Upload
              accept=".json"
              maxCount={1}
              fileList={fileList}
              beforeUpload={() => false}
              onChange={({ fileList: fl }) => setFileList(fl)}
            >
              <Button icon={<UploadOutlined />}>选择迁移包文件</Button>
            </Upload>
            <Button type="primary" loading={importBundle.isPending} onClick={doImport}>
              导入
            </Button>
          </Space>
        </div>
      </Space>
    </Card>
  );
}

/** ④ 流程与模块（M21）——「流程可配置」的运营入口
 *  模块启停走慢通道三段：propose（影响报告）→ 人工确认 → 生效；与 AI 的
 *  配置提议同一队列（确认权在用户，永不委托）。流程视图只读：状态（含模块
 *  贡献徽标）+ 转移表（when 条件列）。 */
function FlowModulesPanel() {
  const { message, modal } = AntApp.useApp();
  const snapshot = useProfileSnapshot();
  const propose = useProposeProfile();
  const confirm = useConfirmProposal();
  const [pending, setPending] = useState<{
    id: string;
    summary: string;
    items: { severity: string; description: string }[];
  } | null>(null);

  const modules = Object.entries(snapshot.data?.modules ?? {});
  const bizModules = modules.filter(([id]) => id.startsWith('module.'));
  const sysModules = modules.filter(([id]) => id.startsWith('core.'));

  const toggleModule = (moduleId: string, enabled: boolean) => {
    propose.mutate(
      {
        patch: [{ op: 'replace', path: `/modules/${moduleId}/enabled`, value: enabled }],
        note: `设置页：${enabled ? '启用' : '停用'} ${moduleId}`,
      },
      {
        onSuccess: (r) => {
          setPending({ id: r.proposalId, summary: r.report.summary, items: r.report.items });
        },
        onError: (e) => message.error(e instanceof ApiError ? e.message : `提议失败：${String(e)}`),
      },
    );
  };

  const doConfirm = () => {
    if (!pending) return;
    confirm.mutate(
      { id: pending.id },
      {
        onSuccess: (r) => {
          message.success(`配置已生效（v${r.newVersion}，${r.appliedOps} 项变更）`);
          setPending(null);
        },
        onError: (e) => message.error(e instanceof ApiError ? e.message : `确认失败：${String(e)}`),
      },
    );
  };

  const moduleColumns: ColumnsType<[string, ModuleConfig]> = [
    { title: '模块', key: 'id', render: (_, r) => <Typography.Text code>{r[0]}</Typography.Text> },
    { title: '版本', key: 'version', width: 90, render: (_, r) => `v${r[1].version ?? '-'}` },
    {
      title: '启用',
      key: 'enabled',
      width: 110,
      render: (_, r) => (
        <Switch
          checked={r[1].enabled}
          loading={propose.isPending}
          onChange={(v) =>
            modal.confirm({
              title: `${v ? '启用' : '停用'} ${r[0]}？`,
              content: v
                ? '启用后其贡献的流程步骤立即生效。'
                : '停用后其贡献的流程转移被掐掉（历史数据不受影响）。',
              onOk: () => toggleModule(r[0], v),
            })
          }
        />
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          业务模块
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          启停走慢通道（提议 → 影响报告 → 确认生效），与 AI 的配置提议同一队列——确认权在用户。
          module.putaway 停用 = 入库流程回到「收货即完成」老流程，历史单据不受影响。
        </Typography.Paragraph>
        <Table
          rowKey={(r) => r[0]}
          size="small"
          columns={moduleColumns}
          dataSource={bizModules}
          pagination={false}
          locale={{ emptyText: '暂无业务模块' }}
        />
      </div>
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          系统模块（只读）
        </Typography.Title>
        <Table
          rowKey={(r) => r[0]}
          size="small"
          columns={moduleColumns.slice(0, 2)}
          dataSource={sysModules}
          pagination={false}
        />
      </div>
      <WorkflowCard snapshot={snapshot.data} workflowKey="inbound" title="入库流程（inbound）" />
      <WorkflowCard snapshot={snapshot.data} workflowKey="outbound" title="出库流程（outbound）" />

      <Modal
        title="确认应用配置变更？"
        open={pending !== null}
        onCancel={() => setPending(null)}
        onOk={doConfirm}
        confirmLoading={confirm.isPending}
        okText="确认生效"
      >
        <Typography.Paragraph>{pending?.summary}</Typography.Paragraph>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {(pending?.items ?? []).map((it, i) => (
            <li key={i}>
              <Tag color={it.severity === 'warning' ? 'orange' : 'blue'} style={{ marginRight: 6 }}>
                {it.severity === 'warning' ? '注意' : '变更'}
              </Tag>
              {it.description}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

/** 流程只读视图：状态（含模块贡献徽标）+ 转移表（from → to，when 条件列） */
function WorkflowCard({
  snapshot,
  workflowKey,
  title,
}: {
  snapshot: ProfileSnapshot | undefined;
  workflowKey: 'inbound' | 'outbound';
  title: string;
}) {
  const wf = snapshot?.workflows[workflowKey];
  if (!wf) return null;
  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <div style={{ marginBottom: 12 }}>
        {wf.states.map((s) => (
          <Tag key={s.id} color={s.id === 'created' ? 'default' : 'processing'}>
            {s.label ?? s.id}
            {s.providedBy ? (
              <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                （{s.providedBy}）
              </Typography.Text>
            ) : null}
          </Tag>
        ))}
      </div>
      <Table
        rowKey={(t) => `${t.from}->${t.to}`}
        size="small"
        pagination={false}
        dataSource={wf.transitions}
        columns={[
          { title: '从', dataIndex: 'from', width: 120 },
          { title: '到', dataIndex: 'to', width: 120 },
          {
            title: '条件（when）',
            dataIndex: 'when',
            render: (v: string | undefined) =>
              v ? <Typography.Text code>{v}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>,
          },
        ]}
      />
    </div>
  );
}
