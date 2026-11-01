import { useState } from 'react';
import {
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
  useSyncRun,
} from '../api/hooks';

/**
 * 设置页（M8）——M5 同步与 M7 迁移的用户面收口。
 * 定位：触发器 + 状态显示器（不引入新服务端状态——peers 每次随请求发送，
 * 服务端 env 是唯一持久位）。
 */

export default function SettingsPage() {
  return (
    <Tabs
      defaultActiveKey="node"
      items={[
        { key: 'node', icon: <NodeIndexOutlined />, label: '节点', children: <NodeTab /> },
        { key: 'sync', icon: <LinkOutlined />, label: '局域网同步', children: <SyncTab /> },
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
