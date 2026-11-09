import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { ApiError } from '../src/api/request';
import SettingsPage from '../src/pages/SettingsPage';

/**
 * 设置页测试（M8）：mock 数据层 hooks。
 * 覆盖关键路径：
 *  - 设备页：hello 数据渲染 + 局域网地址二维码 + 已配对节点（添加/移除/立即同步）；
 *  - 数据页：备份清单与恢复，以及导出导入。两段在同一页。
 */

const syncRunMock = vi.fn();
const addPeerMock = vi.fn();
const removePeerMock = vi.fn();
const migrationImportMock = vi.fn();
const backupCreateMock = vi.fn();
const backupRestoreMock = vi.fn();
const backupRemoveMock = vi.fn();

const nodeHelloFixture = {
  nodeId: 'node-abc-123',
  workspaceId: 'ws-test',
  profileVersion: 3,
  watermarks: { 'node-abc-123': 10, 'ai:test-model': 2 },
  eventCount: 12,
};

const lanAddressFixture = {
  nodeId: 'node-abc-123',
  workspaceId: 'ws-test',
  ip: '192.168.1.20',
  port: 3000,
  url: 'http://192.168.1.20:3000',
};

/** 已配对节点清单默认形态（用例内可整体替换） */
const peersFixture = {
  persisted: true,
  path: 'data/peers.json',
  peers: [
    { url: 'http://192.168.1.21:3000', nodeId: 'node-def-456', addedAt: '2026-11-06T15:34:18.000Z' },
  ],
};

/** 备份清单默认形态（用例内可整体替换） */
const backupListFixture = {
  enabled: true,
  intervalMs: 86_400_000,
  keep: 7,
  lastBackupAt: '2026-11-06T15:34:18.000Z',
  backups: [
    { name: 'onewms-backup-20261106-153418-e128.json', createdAt: '2026-11-06T15:34:18.000Z', eventCount: 128, sizeBytes: 2048 },
    { name: 'onewms-backup-20261105-153418-e96.json', createdAt: '2026-11-05T15:34:18.000Z', eventCount: 96, sizeBytes: 1536 },
  ],
};

/** 可变 fixture：每个用例渲染前赋值（mock 函数体惰性取值） */
let syncRunResult: { results: unknown[] } | undefined = undefined;
let peersResult: unknown = peersFixture;
let lanAddressResult: unknown = lanAddressFixture;
let backupListResult: unknown = backupListFixture;

vi.mock('../src/api/hooks', () => ({
  useNodeHello: () => ({ isLoading: false, data: nodeHelloFixture }),
  useLanAddress: () => ({ isLoading: false, data: lanAddressResult }),
  useSyncPeers: () => ({ isLoading: false, data: peersResult }),
  useAddSyncPeer: () => ({ mutateAsync: addPeerMock, isPending: false }),
  useRemoveSyncPeer: () => ({ mutateAsync: removePeerMock, isPending: false }),
  useSyncRun: () => ({ mutateAsync: syncRunMock, isPending: false, data: syncRunResult }),
  useMigrationImport: () => ({ mutateAsync: migrationImportMock, isPending: false }),
  useBackups: () => ({ isLoading: false, data: backupListResult }),
  useCreateBackup: () => ({ mutateAsync: backupCreateMock, isPending: false }),
  useRestoreBackup: () => ({ mutateAsync: backupRestoreMock, isPending: false }),
  useDeleteBackup: () => ({ mutateAsync: backupRemoveMock, isPending: false }),
}));

// 禁用两字按钮自动插空格 + AntApp 提供 message 上下文
const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

// message portal 挂在 body 上，跨测试残留——统一清场
// （SettingsPage 用 App.useMessage 实例，notice 容器随组件树卸载，无全局单例尾巴）
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  syncRunMock.mockReset();
  addPeerMock.mockReset();
  removePeerMock.mockReset();
  migrationImportMock.mockReset();
  backupCreateMock.mockReset();
  backupRestoreMock.mockReset();
  backupRemoveMock.mockReset();
  syncRunResult = undefined;
  peersResult = peersFixture;
  lanAddressResult = lanAddressFixture;
  backupListResult = backupListFixture;
});

describe('节点名片：hello 数据渲染', () => {
  it('节点 ID / 工作区 / 配置版本 / 事件总数 / 写入通道数可见', () => {
    render(wrap(<SettingsPage />));
    expect(screen.getByText('node-abc-123')).toBeInTheDocument();
    expect(screen.getByText('ws-test')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('2 个')).toBeInTheDocument(); // 水位表 2 个写入通道
    expect(screen.getByRole('tab', { name: /设备$/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /数据$/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '节点' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '局域网同步' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '备份' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '迁移' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '流程与模块' })).not.toBeInTheDocument();
  });

  it('局域网地址可见 + 二维码绑定该地址（另一台设备照着填就能配对）', () => {
    render(wrap(<SettingsPage />));
    expect(screen.getByText('http://192.168.1.20:3000')).toBeInTheDocument();
    // jsdom 没有 canvas 2d 上下文（QRCodeCanvas 拿不到 ctx 就跳过绘制），只断言码存在且值绑对
    expect(screen.getByRole('img', { name: /本节点局域网地址二维码/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /192\.168\.1\.20:3000/ })).toBeInTheDocument();
  });

  it('拿不到局域网地址（无网卡/未监听）→ 给出人话说明，不显示空码', () => {
    lanAddressResult = { nodeId: 'node-abc-123', workspaceId: 'ws-test', ip: null, port: null, url: null };
    render(wrap(<SettingsPage />));
    expect(screen.getByText('没拿到本机局域网地址')).toBeInTheDocument();
    expect(screen.getByText(/另一台设备连不过来/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /局域网地址二维码/ })).not.toBeInTheDocument();
  });
});

describe('设备页：局域网配对', () => {
  /** 设备页是默认页，本机身份和配对清单一起挂上 */
  const openDevices = async (user: ReturnType<typeof userEvent.setup>) => {
    render(wrap(<SettingsPage />));
    await user.click(screen.getByRole('tab', { name: /设备$/ }));
  };

  it('已配对节点清单渲染：地址 / 对端节点 ID / 配对时间 / 持久化说明', async () => {
    const user = userEvent.setup();
    await openDevices(user);

    expect(screen.getByText('http://192.168.1.21:3000')).toBeInTheDocument();
    expect(screen.getByText('node-def-456')).toBeInTheDocument();
    // 本机地址和配对清单在同一页
    expect(screen.getByText('http://192.168.1.20:3000')).toBeInTheDocument();
    expect(screen.getByText('node-abc-123')).toBeInTheDocument();
    expect(screen.getByText(/peers\.json 里，重启仍在/)).toBeInTheDocument();
    expect(screen.queryByText('当前宿主的配对不会保存')).not.toBeInTheDocument();
  });

  it('内存库宿主：提示配对不会保存', async () => {
    peersResult = { persisted: false, path: null, peers: [] };
    const user = userEvent.setup();
    await openDevices(user);

    expect(screen.getByText('当前宿主的配对不会保存')).toBeInTheDocument();
    expect(screen.getByText('还没有配对节点——把对方的地址填进上面的「添加节点」')).toBeInTheDocument();
  });

  it('添加节点：地址随请求发送 + 成功提示带回本次同步条数', async () => {
    addPeerMock.mockResolvedValueOnce({
      peer: { url: 'http://192.168.1.21:3000', nodeId: 'node-def-456', addedAt: '2026-11-06T15:34:18.000Z' },
      round: { peer: 'http://192.168.1.21:3000', status: 'synced', pulled: 4, accepted: 4, skipped: 0, replayed: true },
      peers: [],
    });
    const user = userEvent.setup();
    await openDevices(user);

    await user.type(screen.getByPlaceholderText(/对端地址/), '  http://192.168.1.21:3000  ');
    await user.click(screen.getByRole('button', { name: '添加节点' }));

    expect(addPeerMock).toHaveBeenCalledWith('http://192.168.1.21:3000'); // 首尾空白已去掉
    expect(await screen.findByText('已配对 http://192.168.1.21:3000：本次同步拉取 4 条 / 接受 4 条')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/对端地址/)).toHaveValue(''); // 成功后清空，便于继续添加
  });

  it('添加节点失败：工作区不一致的人话原因直接显示给用户', async () => {
    addPeerMock.mockRejectedValueOnce(
      new ApiError(
        'SYNC_PEER_MISMATCH',
        '两个节点不属于同一个仓库（本地工作区 ws-a，对端 ws-b）。要同步必须用同一个工作区 ID 启动',
        422,
      ),
    );
    const user = userEvent.setup();
    await openDevices(user);

    await user.type(screen.getByPlaceholderText(/对端地址/), 'http://192.168.1.21:3000');
    await user.click(screen.getByRole('button', { name: '添加节点' }));

    expect(await screen.findByText(/两个节点不属于同一个仓库（本地工作区 ws-a，对端 ws-b）/)).toBeInTheDocument();
  });

  it('添加节点：地址为空 → 提示先填，不发请求', async () => {
    const user = userEvent.setup();
    await openDevices(user);

    await user.click(screen.getByRole('button', { name: '添加节点' }));
    expect(await screen.findByText(/请先填写对端地址/)).toBeInTheDocument();
    expect(addPeerMock).not.toHaveBeenCalled();
  });

  it('移除节点：Popconfirm 确认后按地址调 DELETE', async () => {
    removePeerMock.mockResolvedValueOnce({ removed: true, peers: [] });
    const user = userEvent.setup();
    await openDevices(user);

    await user.click(screen.getByRole('button', { name: '移除' }));
    expect(await screen.findByText(/只是不再和它同步，两边已有的数据都不受影响/)).toBeInTheDocument();
    const buttons = await screen.findAllByRole('button', { name: '移除' });
    await user.click(buttons[buttons.length - 1]!); // 气泡里的确认键

    expect(removePeerMock).toHaveBeenCalledWith('http://192.168.1.21:3000');
    expect(await screen.findByText('已移除')).toBeInTheDocument();
  });

  it('立即同步：不带 peers（服务端自己合并清单与环境变量）', async () => {
    syncRunMock.mockResolvedValueOnce({ results: [] });
    const user = userEvent.setup();
    await openDevices(user);

    await user.click(screen.getByRole('button', { name: /立即同步/ })); // 带图标 → 可及名含图标 aria-label
    expect(syncRunMock).toHaveBeenCalledWith();
    expect(await screen.findByText('同步完成：0 个节点')).toBeInTheDocument();
  });

  it('回合结果渲染：peer 标签 + 拉取/接受统计 + 错误消息', async () => {
    // 地址避开本机地址和已配对地址（同一页上同文案会撞）
    syncRunResult = {
      results: [
        { peer: 'http://192.168.1.30:3000', status: 'synced', pulled: 3, accepted: 3, skipped: 0, replayed: true },
        { peer: 'http://192.168.1.31:3000', status: 'error', pulled: 0, accepted: 0, skipped: 0, replayed: false, message: 'connect ECONNREFUSED' },
      ],
    };
    const user = userEvent.setup();
    await openDevices(user);

    expect(screen.getByText('http://192.168.1.30:3000')).toBeInTheDocument(); // peer 作为行标签
    expect(screen.getByText('拉取 3 条 / 接受 3 / 跳过 0 / 已重建投影')).toBeInTheDocument();
    expect(screen.getByText('synced')).toBeInTheDocument(); // 状态 tag
    expect(screen.getByText('connect ECONNREFUSED')).toBeInTheDocument(); // 错误分支可见
  });
});

describe('备份', () => {
  /** 切到数据页（antd Tabs 惰性渲染——不点进去备份和导出都不挂载） */
  const openDataTab = async (user: ReturnType<typeof userEvent.setup>) => {
    render(wrap(<SettingsPage />));
    await user.click(screen.getByRole('tab', { name: /数据$/ }));
  };

  it('清单渲染：文件名/事件数/大小 + 最新标记 + 策略文案', async () => {
    const user = userEvent.setup();
    await openDataTab(user);

    expect(screen.getByText('onewms-backup-20261106-153418-e128.json')).toBeInTheDocument();
    expect(screen.getByText('onewms-backup-20261105-153418-e96.json')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
    expect(screen.getAllByText('最新')).toHaveLength(1); // 只有第一行（新到旧）
    expect(
      screen.getByText(/每 24 小时自动备份一次，滚动保留最新 7 份/),
    ).toBeInTheDocument();
  });

  it('立即备份：调 POST 并提示新文件名', async () => {
    backupCreateMock.mockResolvedValueOnce({ name: 'onewms-backup-20261106-160000-e128.json' });
    const user = userEvent.setup();
    await openDataTab(user);

    await user.click(screen.getByRole('button', { name: /立即备份/ })); // 带图标 → 可及名含图标 aria-label
    expect(backupCreateMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已备份：onewms-backup-20261106-160000-e128.json')).toBeInTheDocument();
  });

  it('恢复：二次确认后调 restore（带文件名），提示接受/跳过与 AI 配置', async () => {
    backupRestoreMock.mockResolvedValueOnce({ accepted: 5, skipped: 128, replayed: true, aiConfigRestored: true });
    const user = userEvent.setup();
    await openDataTab(user);

    const restores = screen.getAllByRole('button', { name: '恢复' });
    await user.click(restores[0]!);
    // 确认弹窗说清了「幂等 + 不删当前数据」——0 基础用户敢点的关键
    expect(await screen.findByText(/重复的事件自动跳过，不会产生重账/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认恢复' }));

    expect(backupRestoreMock).toHaveBeenCalledWith('onewms-backup-20261106-153418-e128.json');
    expect(await screen.findByText('恢复完成：新增 5 条 / 跳过 128 条 / AI 配置已一并恢复')).toBeInTheDocument();
  });

  it('删除：Popconfirm 确认后调 remove', async () => {
    backupRemoveMock.mockResolvedValueOnce({ backups: [] });
    const user = userEvent.setup();
    await openDataTab(user);

    await user.click(screen.getAllByRole('button', { name: '删除' })[0]!);
    const confirmButtons = await screen.findAllByRole('button', { name: '删除' });
    await user.click(confirmButtons[confirmButtons.length - 1]!); // 气泡里的确认键

    expect(backupRemoveMock).toHaveBeenCalledWith('onewms-backup-20261106-153418-e128.json');
    expect(await screen.findByText('已删除')).toBeInTheDocument();
  });

  it('宿主无落盘位：显示禁用原因，「立即备份」置灰', async () => {
    backupListResult = {
      enabled: false,
      intervalMs: 86_400_000,
      keep: 7,
      lastBackupAt: null,
      backups: [],
      reason: '当前宿主没有可写的数据目录（内存库），自动备份已关闭',
    };
    const user = userEvent.setup();
    await openDataTab(user);

    expect(screen.getByText('自动备份已关闭')).toBeInTheDocument();
    expect(screen.getByText(/当前宿主没有可写的数据目录/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /立即备份/ })).toBeDisabled();
    expect(screen.getByText('当前宿主不支持备份')).toBeInTheDocument(); // 空表文案
  });
});

describe('迁移', () => {
  it('选择迁移包文件 → 导入 → 事件解析后随请求发送 + 结果提示', async () => {
    migrationImportMock.mockResolvedValueOnce({ accepted: 5, skipped: 2, replayed: true, missingManifests: [] });
    const bundle = { workspaceId: 'ws-test', events: [] };
    const file = new File([JSON.stringify(bundle)], 'onewms-migration.json', { type: 'application/json' });
    // jsdom 未实现 Blob.text()（真实浏览器原生支持）——在测试实例上补齐
    (file as File & { text: () => Promise<string> }).text = () => Promise.resolve(JSON.stringify(bundle));

    const user = userEvent.setup();
    const { container } = render(wrap(<SettingsPage />));
    await user.click(screen.getByRole('tab', { name: /数据$/ }));
    // 备份清单和导出在同一页，不用再切一次
    expect(screen.getByText('onewms-backup-20261106-153418-e128.json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导出一份/ })).toBeInTheDocument();

    // jsdom 下 antd Upload 的隐藏 input 用 fireEvent.change 直接触发（beforeUpload 返回 false → 只入 fileList）
    const fileInput = container.querySelector('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(await screen.findByText('onewms-migration.json')).toBeInTheDocument(); // 文件入列（Upload 列表）
    await user.click(screen.getByRole('button', { name: '导入' }));

    expect(migrationImportMock).toHaveBeenCalledWith(bundle); // 文件内容解析后发送
    expect(await screen.findByText('导入完成：接受 5 条 / 跳过 2 条')).toBeInTheDocument(); // 结果提示
  });
});
