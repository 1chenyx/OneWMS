import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Popconfirm,
  QRCode,
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
  SaveOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import type { BackupEntry, SyncPeerRecord } from '../api/client';
import {
  useAddSyncPeer,
  useBackups,
  useCreateBackup,
  useDeleteBackup,
  useLanAddress,
  useMigrationImport,
  useNodeHello,
  useProfileSnapshot,
  useProposeProfile,
  useConfirmProposal,
  useRemoveSyncPeer,
  useRestoreBackup,
  useSyncPeers,
  useSyncRun,
} from '../api/hooks';
import PageHeader from '../components/PageHeader';

/**
 * 设置页（M8/M21）——同步/迁移/备份的用户面收口 + 流程与模块配置。
 * 定位：触发器 + 状态显示器（节点清单与备份清单都由服务端持久化，页面只读写它）。
 */

export default function SettingsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minHeight: 0 }}>
      <PageHeader title="设置" subtitle="节点身份、局域网同步、数据备份与迁移、流程模块配置" />
      <Tabs
        defaultActiveKey="node"
        items={[
          { key: 'node', icon: <NodeIndexOutlined />, label: '节点', children: <NodeTab /> },
          { key: 'sync', icon: <LinkOutlined />, label: '局域网同步', children: <SyncTab /> },
          { key: 'backup', icon: <SaveOutlined />, label: '备份', children: <BackupTab /> },
          { key: 'migration', icon: <SyncOutlined />, label: '迁移', children: <MigrationTab /> },
          { key: 'flow', icon: <NodeIndexOutlined />, label: '流程与模块', children: <FlowModulesPanel /> },
        ]}
      />
    </div>
  );
}

/** ① 节点名片（只读——/api/sync/hello 既是握手端点也是节点自省）+ 供对端扫码的局域网地址 */
function NodeTab() {
  const { data: hello, isLoading } = useNodeHello();
  const { data: lan, isLoading: lanLoading } = useLanAddress();
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

      <Typography.Title level={5}>让另一台设备连到这台</Typography.Title>
      {lanLoading ? (
        <Typography.Text type="secondary">正在获取本机局域网地址…</Typography.Text>
      ) : lan?.url ? (
        <Space direction="vertical" align="start">
          {/* 码里就是纯地址：手机相机扫到能直接打开本机页面，扫码枪扫到能直接填进对方的
              「添加节点」输入框。工作区是否同一个由服务端握手把关（不一致会给人话原因）。 */}
          <QRCode value={lan.url} aria-label={`本节点局域网地址二维码 ${lan.url}`} />
          <Typography.Text copyable code>
            {lan.url}
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            两台设备要连同一个 Wi-Fi / 网线局域网。在对方的 OneWMS 里打开「设置 → 局域网同步」，
            把上面这个地址填进「添加节点」（仓库里的扫码枪扫这个码也能直接填进去）。
          </Typography.Paragraph>
        </Space>
      ) : (
        <Alert
          type="warning"
          showIcon
          message="没拿到本机局域网地址"
          description="这台设备可能没连局域网（或只有内网回环），另一台设备连不过来。确认已连上 Wi-Fi / 网线后刷新本页。"
        />
      )}
    </Card>
  );
}

/** ② 局域网同步：已配对节点清单（服务端持久化，重启仍在）+ 添加 / 移除 / 手动跑一轮 */
function SyncTab() {
  const { message } = AntApp.useApp(); // App 上下文实例（notice 容器随组件树卸载，不用全局静态 message）
  const [urlText, setUrlText] = useState('');
  const { data, isLoading } = useSyncPeers();
  const add = useAddSyncPeer();
  const remove = useRemoveSyncPeer();
  const run = useSyncRun();

  const doAdd = async () => {
    const url = urlText.trim();
    if (!url) {
      message.warning('请先填写对端地址（在对方的「设置 → 节点」页上能看到）');
      return;
    }
    try {
      // 服务端会先握手校验（连不上 / 不是同一个仓库都会在落盘前被拦下并给中文原因），
      // 通过后立刻跑一轮同步——用户当场看到对方的数据进来。
      const r = await add.mutateAsync(url);
      setUrlText('');
      message.success(`已配对 ${url}：本次同步拉取 ${r.round.pulled} 条 / 接受 ${r.round.accepted} 条`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `添加节点失败：${String(e)}`);
    }
  };

  const doRun = async () => {
    try {
      const { results } = await run.mutateAsync();
      message.success(`同步完成：${results.length} 个节点`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `同步失败：${String(e)}`);
    }
  };

  const columns: ColumnsType<SyncPeerRecord> = [
    { title: '地址', dataIndex: 'url', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    {
      title: '对端节点 ID',
      dataIndex: 'nodeId',
      width: 220,
      render: (v: string | undefined) => v ?? <Typography.Text type="secondary">未握手</Typography.Text>,
    },
    {
      title: '配对时间',
      dataIndex: 'addedAt',
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: '操作',
      key: 'ops',
      width: 100,
      render: (_, r) => (
        <Popconfirm
          title="移除这个节点？"
          description="只是不再和它同步，两边已有的数据都不受影响。"
          okText="移除"
          okButtonProps={{ danger: true }}
          onConfirm={async () => {
            try {
              await remove.mutateAsync(r.url);
              message.success('已移除');
            } catch (e) {
              message.error(e instanceof ApiError ? e.message : `移除失败：${String(e)}`);
            }
          }}
        >
          <Button size="small" danger>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card
      title="局域网同步（拉模型回合）"
      extra={
        <Button type="primary" icon={<SyncOutlined />} loading={run.isPending} onClick={doRun}>
          立即同步
        </Button>
      }
    >
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          placeholder="对端地址，如 http://192.168.1.20:3000（在对方的「设置 → 节点」页上）"
          value={urlText}
          onChange={(e) => setUrlText(e.target.value)}
          onPressEnter={doAdd}
        />
        <Button type="primary" loading={add.isPending} onClick={doAdd}>
          添加节点
        </Button>
      </Space.Compact>
      <Table
        rowKey="url"
        size="small"
        loading={isLoading}
        columns={columns}
        dataSource={data?.peers ?? []}
        pagination={false}
        locale={{ emptyText: '还没有配对节点——把对方的地址填进上面的「添加节点」' }}
      />
      {data && !data.persisted && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="当前宿主的配对不会保存"
          description="服务端用的是内存库，没有可写的数据目录，重启后需要重新添加节点。"
        />
      )}
      {run.data && (
        <Descriptions title="回合结果" column={1} bordered size="small" style={{ marginTop: 12 }}>
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
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        同步 = 全量事件交换 + 投影重建（本地优先，无服务器依赖）。配对清单保存在服务端数据目录的
        peers.json 里，重启仍在；服务端 ONE_SYNC_PEERS 里的地址每次也会一并参与同步。
      </Typography.Paragraph>
    </Card>
  );
}

/** 字节数 → 人话（备份文件可能上百 KB 到几 MB） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 间隔毫秒 → 人话（整点优先，冒烟测试用的几秒间隔也要能读） */
function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}

/** ③ 备份：定时滚动（服务端自动写）+ 手动备份 / 恢复 / 删除
 *  给 0 基础用户的定心丸：不用记「导出迁移包」这个动作，出错能一键回到某个时刻。 */
function BackupTab() {
  const { message, modal } = AntApp.useApp();
  const { data, isLoading } = useBackups();
  const create = useCreateBackup();
  const restore = useRestoreBackup();
  const remove = useDeleteBackup();

  const doCreate = async () => {
    try {
      const r = await create.mutateAsync();
      message.success(`已备份：${r.name}`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `备份失败：${String(e)}`);
    }
  };

  const doRestore = (entry: BackupEntry) => {
    modal.confirm({
      title: `恢复到 ${new Date(entry.createdAt).toLocaleString()}？`,
      content:
        '恢复会把这份备份里的全部事件重新入账并重建数据（重复的事件自动跳过，不会产生重账）。' +
        '当前数据不会被删除，但如果这份备份比较旧，界面上看到的就是那个时刻的状态。',
      okText: '确认恢复',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const r = await restore.mutateAsync(entry.name);
          message.success(
            `恢复完成：新增 ${r.accepted} 条 / 跳过 ${r.skipped} 条${r.aiConfigRestored ? ' / AI 配置已一并恢复' : ''}`,
          );
        } catch (e) {
          message.error(e instanceof ApiError ? e.message : `恢复失败：${String(e)}`);
        }
      },
    });
  };

  const columns: ColumnsType<BackupEntry> = [
    {
      title: '备份时间',
      dataIndex: 'createdAt',
      render: (v: string, _entry, i) => (
        <Space size={6}>
          <span>{new Date(v).toLocaleString()}</span>
          {i === 0 && <Tag color="green">最新</Tag>}
        </Space>
      ),
    },
    { title: '事件数', dataIndex: 'eventCount', width: 100 },
    { title: '大小', dataIndex: 'sizeBytes', width: 110, render: (v: number) => formatSize(v) },
    { title: '文件名', dataIndex: 'name', ellipsis: true, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      render: (_, r) => (
        <Space>
          <Button size="small" loading={restore.isPending} onClick={() => doRestore(r)}>
            恢复
          </Button>
          <Popconfirm
            title="删除这份备份？"
            description="删除后无法再恢复到这个时刻。"
            okText="删除"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await remove.mutateAsync(r.name);
                message.success('已删除');
              } catch (e) {
                message.error(e instanceof ApiError ? e.message : `删除失败：${String(e)}`);
              }
            }}
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="自动备份"
      extra={
        <Button type="primary" icon={<SaveOutlined />} loading={create.isPending} disabled={!data?.enabled} onClick={doCreate}>
          立即备份
        </Button>
      }
    >
      {data && !data.enabled && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="自动备份已关闭" description={data.reason} />
      )}
      {data?.enabled && (
        <Typography.Paragraph type="secondary">
          {data.intervalMs === 0
            ? `自动备份已关闭（只能手动备份），保留最新 ${data.keep} 份。`
            : `每 ${formatInterval(data.intervalMs)}自动备份一次，滚动保留最新 ${data.keep} 份。`}
          最近一次：{data.lastBackupAt ? new Date(data.lastBackupAt).toLocaleString() : '还没有备份'}。
          备份内容 = 全部业务数据 + AI 模型配置，文件在服务端数据目录里，可以整个拷走另存。
        </Typography.Paragraph>
      )}
      <Table
        rowKey="name"
        size="small"
        loading={isLoading}
        columns={columns}
        dataSource={data?.backups ?? []}
        pagination={false}
        locale={{ emptyText: data?.enabled ? '还没有备份——点右上角「立即备份」' : '当前宿主不支持备份' }}
      />
    </Card>
  );
}

/** ④ 迁移：导出迁移包（明文 JSON，本地可信域）/ 导入并全量重放 */
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

/** ⑤ 流程与模块（M21）——「流程可配置」的运营入口
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
          停用 module.putaway 回到「收货即完成」。停用 module.reversal 后，已收货和已发货不能再取消。停用 module.partial 后，收货和发货按订单数量整单入账，不能改少。停用 module.reservation 后，新的拣货不再占用可用量，库存仍在发货时扣减；已经占用的数量保留到发货或取消。停用 module.return 后，不能再按原单号开新的退货单；已经开出的退货单和历史记录保留，仍可按普通单据继续流转。停用 module.asn 后，不能再开到货预报；已经预报的单仍可收货或取消，直接入库不受影响。停用 module.replenish 后，不能再按缺口生成补货单；低库存预警仍在；已经开出的补货入库单仍可按普通入库收货。历史单据不受影响。
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
          {
            title: '库存效应',
            dataIndex: 'effect',
            width: 110,
            render: (v: string | undefined) =>
              v ? <Typography.Text code>{v}</Typography.Text> : <Typography.Text type="secondary">约定</Typography.Text>,
          },
        ]}
      />
    </div>
  );
}
