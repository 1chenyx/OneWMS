import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Input,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  CloudUploadOutlined,
  DownloadOutlined,
  KeyOutlined,
  LinkOutlined,
  NodeIndexOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { api, ApiError } from '../api/client';
import {
  useGenerateKey,
  useImportKey,
  useKeyStatus,
  useMigrationImport,
  useNodeHello,
  useRelayRun,
  useSyncRun,
} from '../api/hooks';

/**
 * 设置页（M8）——M5 同步与 M7 密钥/中继/迁移的用户面收口。
 * 定位：触发器 + 状态显示器（不引入新服务端状态——peers/relay 每次随请求发送，
 * 服务端 env 是唯一持久位）。密钥明文只在生成/导出时一次性展示，常态展示指纹。
 */

export default function SettingsPage() {
  return (
    <Tabs
      defaultActiveKey="node"
      items={[
        { key: 'node', icon: <NodeIndexOutlined />, label: '节点', children: <NodeTab /> },
        { key: 'sync', icon: <LinkOutlined />, label: '局域网同步', children: <SyncTab /> },
        { key: 'relay', icon: <CloudUploadOutlined />, label: '云中继', children: <RelayTab /> },
        { key: 'keys', icon: <KeyOutlined />, label: '工作区密钥', children: <KeyTab /> },
        { key: 'migration', icon: <SyncOutlined />, label: '迁移', children: <MigrationTab /> },
      ]}
    />
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

/** ③ 云中继：手动跑一轮密文回合（push 我有它无 + pull 它有我无） */
function RelayTab() {
  const { message } = AntApp.useApp();
  const [relayUrl, setRelayUrl] = useState('');
  const run = useRelayRun();

  const doRun = async () => {
    const relay = relayUrl.trim();
    if (!relay) {
      message.warning('请先填写中继地址');
      return;
    }
    try {
      const r = await run.mutateAsync(relay);
      message.success(`中继回合完成：接受 ${r.accepted} 条`);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `中继回合失败：${String(e)}`);
    }
  };

  return (
    <Card title="云中继（端到端加密邮箱）">
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          placeholder="中继地址，如 http://relay.example.com:3900"
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          onPressEnter={doRun}
        />
        <Button type="primary" loading={run.isPending} onClick={doRun}>
          立即回合
        </Button>
      </Space.Compact>
      {run.data && (
        <Descriptions title="回合结果" bordered size="small" column={2}>
          <Descriptions.Item label="推送到中继">{run.data.pushed} 条</Descriptions.Item>
          <Descriptions.Item label="推送接受/跳过/冲突">
            {run.data.pushAccepted} / {run.data.pushSkipped} / {run.data.pushConflicted}
          </Descriptions.Item>
          <Descriptions.Item label="从中继拉取">{run.data.pulled} 条</Descriptions.Item>
          <Descriptions.Item label="本地接受/跳过">
            {run.data.accepted} / {run.data.skipped}
          </Descriptions.Item>
          <Descriptions.Item label="投影重建">{run.data.replayed ? '是' : '否'}</Descriptions.Item>
        </Descriptions>
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        中继只见密文（工作区密钥加密，中继无需被信任）；未配置密钥时回合会被拒绝（先到「工作区密钥」页生成或导入）。
      </Typography.Paragraph>
    </Card>
  );
}

/** ④ 工作区密钥：生成/导入/导出（人工交换的边界参数，不经事件不同步） */
function KeyTab() {
  const { message } = AntApp.useApp();
  const { data: status, isLoading } = useKeyStatus();
  const generate = useGenerateKey();
  const importKey = useImportKey();
  const [revealed, setRevealed] = useState<string | null>(null); // 明文一次性展示
  const [importText, setImportText] = useState('');

  const doGenerate = async () => {
    try {
      const key = await generate.mutateAsync();
      setRevealed(key.key);
      message.success('密钥已生成——请立即复制保存，此明文不再主动展示');
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `生成失败：${String(e)}`);
    }
  };

  const doExport = async () => {
    try {
      const key = await api.exportKey();
      setRevealed(key.key);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `导出失败：${String(e)}`);
    }
  };

  const doImport = async () => {
    const key = importText.trim();
    if (!key) {
      message.warning('请粘贴 64 位 hex 密钥');
      return;
    }
    try {
      await importKey.mutateAsync(key);
      message.success('密钥已导入');
      setImportText('');
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : `导入失败：${String(e)}`);
    }
  };

  if (isLoading) return <Card loading />;

  return (
    <Card title="工作区密钥（E2E 加密边界）">
      {status?.exists ? (
        <Descriptions bordered size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="指纹">{status.fingerprint}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{status.createdAt}</Descriptions.Item>
        </Descriptions>
      ) : (
        <Alert
          type="info"
          showIcon
          message="本工作区尚未生成密钥"
          description="密钥用于云中继的端到端加密。生成后请把明文经可信渠道交给其他节点（导入），中继全程不经手密钥。"
          style={{ marginBottom: 12 }}
        />
      )}
      {revealed && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="密钥明文（仅此一次展示，请立即复制）"
          description={<Typography.Text copyable code>{revealed}</Typography.Text>}
        />
      )}
      <Space style={{ marginBottom: 24 }}>
        <Button type="primary" loading={generate.isPending} onClick={doGenerate} disabled={status?.exists}>
          生成密钥
        </Button>
        <Button icon={<DownloadOutlined />} onClick={doExport} disabled={!status?.exists}>
          导出明文
        </Button>
      </Space>

      <Typography.Title level={5}>导入已有密钥（加入已有加密工作区）</Typography.Title>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          placeholder="粘贴 64 位 hex 密钥（来自源节点导出）"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          onPressEnter={doImport}
        />
        <Button loading={importKey.isPending} onClick={doImport} disabled={status?.exists}>
          导入
        </Button>
      </Space.Compact>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
        已有密钥的工作区不可换钥（换钥使存量密文不可解）——确需换 = 新工作区。
      </Typography.Paragraph>
    </Card>
  );
}

/** ⑤ 迁移：导出迁移包（明文 JSON，本地可信域）/ 导入并全量重放 */
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
