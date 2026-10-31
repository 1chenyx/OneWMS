import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import SettingsPage from '../src/pages/SettingsPage';
import { ApiError } from '../src/api/client';

/**
 * 设置页测试（M8）：mock 数据层 hooks（保留真实 ApiError 类供分支断言）。
 * 覆盖五分区中的四个关键路径（中继与同步同构，不重复测）：
 *  - 节点名片：hello 数据渲染；
 *  - 同步：peers 输入解析（中英文逗号/换行分隔）+ 回合结果渲染；
 *  - 密钥：生成（明文一次性展示）、导入 409 提示、已有密钥态（生成/导入禁用 + 指纹）；
 *  - 迁移：选文件 → 导入 → 结果提示。
 */

const syncRunMock = vi.fn();
const relayRunMock = vi.fn();
const generateMock = vi.fn();
const importKeyMock = vi.fn();
const migrationImportMock = vi.fn();

const nodeHelloFixture = {
  nodeId: 'node-abc-123',
  workspaceId: 'ws-test',
  profileVersion: 3,
  watermarks: { 'node-abc-123': 10, 'ai:test-model': 2 },
  eventCount: 12,
};

/** 可变 fixture：每个用例渲染前赋值（mock 函数体惰性取值） */
let keyStatusFixture: { exists: boolean; fingerprint?: string; createdAt?: string } = { exists: false };
let syncRunResult: { results: unknown[] } | undefined = undefined;

vi.mock('../src/api/hooks', () => ({
  useNodeHello: () => ({ isLoading: false, data: nodeHelloFixture }),
  useSyncRun: () => ({ mutateAsync: syncRunMock, isPending: false, data: syncRunResult }),
  useRelayRun: () => ({ mutateAsync: relayRunMock, isPending: false, data: undefined }),
  useKeyStatus: () => ({ isLoading: false, data: keyStatusFixture }),
  useGenerateKey: () => ({ mutateAsync: generateMock, isPending: false }),
  useImportKey: () => ({ mutateAsync: importKeyMock, isPending: false }),
  useMigrationImport: () => ({ mutateAsync: migrationImportMock, isPending: false }),
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
  relayRunMock.mockReset();
  generateMock.mockReset();
  importKeyMock.mockReset();
  migrationImportMock.mockReset();
  keyStatusFixture = { exists: false };
  syncRunResult = undefined;
});

describe('节点名片：hello 数据渲染', () => {
  it('节点 ID / 工作区 / 配置版本 / 事件总数 / 写入通道数可见', () => {
    render(wrap(<SettingsPage />));
    expect(screen.getByText('node-abc-123')).toBeInTheDocument();
    expect(screen.getByText('ws-test')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('2 个')).toBeInTheDocument(); // 水位表 2 个写入通道
  });
});

describe('局域网同步', () => {
  it('peers 输入解析：中英文逗号混合 + 空白 → 数组随请求发送', async () => {
    syncRunMock.mockResolvedValueOnce({ results: [] });
    const user = userEvent.setup();
    render(wrap(<SettingsPage />));
    await user.click(screen.getByText('局域网同步')); // 切 tab

    await user.type(
      screen.getByPlaceholderText(/对端地址/),
      ' http://a:3000 ，http://b:3000,,http://c:3000',
    );
    await user.click(screen.getByRole('button', { name: '立即同步' }));
    expect(syncRunMock).toHaveBeenCalledWith(['http://a:3000', 'http://b:3000', 'http://c:3000']);
  });

  it('回合结果渲染：peer 标签 + 拉取/接受统计 + 错误消息', async () => {
    syncRunResult = {
      results: [
        { peer: 'http://192.168.1.20:3000', status: 'synced', pulled: 3, accepted: 3, skipped: 0, replayed: true },
        { peer: 'http://192.168.1.21:3000', status: 'error', pulled: 0, accepted: 0, skipped: 0, replayed: false, message: 'connect ECONNREFUSED' },
      ],
    };
    const user = userEvent.setup();
    render(wrap(<SettingsPage />));
    await user.click(screen.getByText('局域网同步'));

    expect(screen.getByText('http://192.168.1.20:3000')).toBeInTheDocument(); // peer 作为行标签
    expect(screen.getByText('拉取 3 条 / 接受 3 / 跳过 0 / 已重建投影')).toBeInTheDocument();
    expect(screen.getByText('synced')).toBeInTheDocument(); // 状态 tag
    expect(screen.getByText('connect ECONNREFUSED')).toBeInTheDocument(); // 错误分支可见
  });
});

describe('工作区密钥', () => {
  it('生成 → 明文一次性展示（warning Alert）', async () => {
    generateMock.mockResolvedValueOnce({
      key: 'feedbeef'.repeat(8),
      fingerprint: 'FP1234AB',
      createdAt: '2026-10-30T08:00:00.000Z',
    });
    const user = userEvent.setup();
    render(wrap(<SettingsPage />));
    await user.click(screen.getByText('工作区密钥'));

    expect(screen.getByText('本工作区尚未生成密钥')).toBeInTheDocument(); // 无密钥态
    await user.click(screen.getByRole('button', { name: '生成密钥' }));

    expect(await screen.findByText('feedbeef'.repeat(8))).toBeInTheDocument(); // 明文可见
    expect(screen.getByText('密钥明文（仅此一次展示，请立即复制）')).toBeInTheDocument();
  });

  it('导入 409（已有密钥）→ 错误提示', async () => {
    importKeyMock.mockRejectedValueOnce(new ApiError('KEY_EXISTS', '工作区已有密钥，不可换钥', 409));
    const user = userEvent.setup();
    render(wrap(<SettingsPage />));
    await user.click(screen.getByText('工作区密钥'));

    await user.type(screen.getByPlaceholderText(/粘贴 64 位 hex 密钥/), 'cafe'.repeat(16));
    await user.click(screen.getByRole('button', { name: '导入' }));
    // 用完整 message 文本断言（页面静态说明也含「不可换钥」字样，避免误匹配）
    expect(await screen.findByText('工作区已有密钥，不可换钥')).toBeInTheDocument();
    expect(importKeyMock).toHaveBeenCalledWith('cafe'.repeat(16));
  });

  it('已有密钥态：指纹展示 + 生成/导入禁用（换钥 = 存量密文不可解）', async () => {
    keyStatusFixture = { exists: true, fingerprint: 'FP9999XY', createdAt: '2026-10-01T00:00:00.000Z' };
    const user = userEvent.setup();
    render(wrap(<SettingsPage />));
    await user.click(screen.getByText('工作区密钥'));

    expect(screen.getByText('FP9999XY')).toBeInTheDocument(); // 常态展示指纹而非明文
    expect(screen.getByRole('button', { name: '生成密钥' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导入' })).toBeDisabled();
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
    await user.click(screen.getByText('迁移'));

    // jsdom 下 antd Upload 的隐藏 input 用 fireEvent.change 直接触发（beforeUpload 返回 false → 只入 fileList）
    const fileInput = container.querySelector('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(await screen.findByText('onewms-migration.json')).toBeInTheDocument(); // 文件入列（Upload 列表）
    await user.click(screen.getByRole('button', { name: '导入' }));

    expect(migrationImportMock).toHaveBeenCalledWith(bundle); // 文件内容解析后发送
    expect(await screen.findByText('导入完成：接受 5 条 / 跳过 2 条')).toBeInTheDocument(); // 结果提示
  });
});
