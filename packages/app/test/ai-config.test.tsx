import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import AiConfigPage from '../src/pages/AiConfigPage';

/**
 * AI 模型配置页测试（M17）：mock 数据层 hooks。
 * 覆盖：状态卡三分支渲染（未配置 / 已配置）/ 表单校验 / 保存与提交体 /
 * 测试连接结果渲染 / 关闭 AI 二次确认 / 切换接入方式（ollama 免密钥、baseUrl 选填）。
 */

const saveMock = vi.fn();
const clearMock = vi.fn();
const testMock = vi.fn();

/** 可变 fixture：每个用例渲染前赋值（mock 函数体惰性取值） */
let statusFixture: {
  configured: boolean;
  source: 'file' | 'env' | 'none';
  config?: { kind: 'openai-compatible' | 'ollama'; model: string; baseUrl: string; apiKeySet: boolean };
} = { configured: false, source: 'none' };

vi.mock('../src/api/hooks', () => ({
  useAiConfig: () => ({ isLoading: false, data: statusFixture }),
  useSaveAiConfig: () => ({ mutateAsync: saveMock, isPending: false }),
  useClearAiConfig: () => ({ mutateAsync: clearMock, isPending: false }),
  useTestAiConfig: () => ({ mutateAsync: testMock, isPending: false }),
}));

// 禁用两字按钮自动插空格 + AntApp 提供 message 上下文
const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

// message/popconfirm portal 挂在 body 上，跨测试残留——统一清场
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  saveMock.mockReset();
  clearMock.mockReset();
  testMock.mockReset();
  statusFixture = { configured: false, source: 'none' };
});

describe('状态卡渲染', () => {
  it('未配置 → 状态 Tag 与「—」来源；无「关闭 AI」按钮', () => {
    render(wrap(<AiConfigPage />));
    expect(screen.getByText(/未配置（AI 入口将不可用/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument(); // 来源 none
    expect(screen.queryByRole('button', { name: '关闭 AI' })).not.toBeInTheDocument();
  });

  it('已配置（页面配置）→ 模型 / Base URL / 密钥已设置可见；表单回填', () => {
    statusFixture = {
      configured: true,
      source: 'file',
      config: {
        kind: 'openai-compatible',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeySet: true,
      },
    };
    render(wrap(<AiConfigPage />));
    expect(screen.getByText('已配置，可用')).toBeInTheDocument();
    expect(screen.getByText('页面配置')).toBeInTheDocument();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
    expect(screen.getByText('已设置（不回显）')).toBeInTheDocument();
    expect(screen.getByDisplayValue('deepseek-chat')).toBeInTheDocument(); // 表单回填
    expect(screen.getByDisplayValue('https://api.deepseek.com/v1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭 AI' })).toBeInTheDocument();
  });
});

describe('表单校验与保存', () => {
  it('必填校验：模型空 / 云 API 缺 Base URL → 报错且不提交', async () => {
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    await user.click(screen.getByRole('button', { name: /保存并生效/ }));
    expect(await screen.findByText('请填写模型名')).toBeInTheDocument();
    expect(screen.getByText('云 API 必须填写 Base URL')).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('填写完整 → 保存提交体正确；成功提示与表单密钥清空', async () => {
    saveMock.mockResolvedValueOnce({
      configured: true,
      source: 'file',
      config: { kind: 'openai-compatible', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKeySet: true },
    });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));

    await user.type(screen.getByPlaceholderText(/deepseek-chat/), 'deepseek-chat');
    await user.type(screen.getByPlaceholderText(/api\.deepseek\.com/), 'https://api.deepseek.com/v1');
    await user.type(screen.getByPlaceholderText('sk-...'), 'sk-test');
    await user.click(screen.getByRole('button', { name: /保存并生效/ }));

    expect(saveMock).toHaveBeenCalledWith({
      kind: 'openai-compatible',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
    });
    expect(await screen.findByText(/已保存并生效（deepseek-chat）/)).toBeInTheDocument();
  });

  it('切换到本地 Ollama → 密钥字段隐藏、Base URL 选填；保存体不含密钥', async () => {
    saveMock.mockResolvedValueOnce({
      configured: true,
      source: 'file',
      config: { kind: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1', apiKeySet: false },
    });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));

    // 「本地 Ollama」同时出现在速填按钮与 Radio 标签——按 radio 角色精确定位
    await user.click(screen.getByRole('radio', { name: '本地 Ollama' }));
    expect(screen.queryByPlaceholderText('sk-...')).not.toBeInTheDocument(); // 密钥字段隐藏
    expect(screen.queryByPlaceholderText('留空保持已保存的密钥')).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/ollama list/), 'qwen3:8b');
    await user.click(screen.getByRole('button', { name: /保存并生效/ }));

    // ollama：baseUrl 留空合法（服务端补本机缺省）
    expect(saveMock).toHaveBeenCalledWith({ kind: 'ollama', model: 'qwen3:8b' });
  });
});

describe('测试连接', () => {
  it('成功 → 耗时与模型回显', async () => {
    testMock.mockResolvedValueOnce({ ok: true, model: 'deepseek-chat', latencyMs: 123, reply: 'pong' });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));

    await user.type(screen.getByPlaceholderText(/deepseek-chat/), 'deepseek-chat');
    await user.type(screen.getByPlaceholderText(/api\.deepseek\.com/), 'https://api.deepseek.com/v1');
    await user.click(screen.getByRole('button', { name: /测试连接/ }));

    expect(await screen.findByText('连接成功（123 ms）')).toBeInTheDocument();
    expect(screen.getByText(/回复：pong/)).toBeInTheDocument();
  });

  it('失败 → 失败原文回传（排障线索）', async () => {
    testMock.mockResolvedValueOnce({ ok: false, model: 'x', message: '401 Unauthorized' });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));

    await user.type(screen.getByPlaceholderText(/deepseek-chat/), 'x');
    await user.type(screen.getByPlaceholderText(/api\.deepseek\.com/), 'https://api.example.com/v1');
    await user.click(screen.getByRole('button', { name: /测试连接/ }));

    expect(await screen.findByText('连接失败')).toBeInTheDocument();
    expect(screen.getByText('401 Unauthorized')).toBeInTheDocument();
  });
});

describe('关闭 AI', () => {
  it('已配置时可见 → 二次确认后调用删除端点', async () => {
    statusFixture = {
      configured: true,
      source: 'file',
      config: { kind: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1', apiKeySet: false },
    };
    clearMock.mockResolvedValueOnce({ configured: false, source: 'none' });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));

    await user.click(screen.getByRole('button', { name: '关闭 AI' }));
    await user.click(await screen.findByRole('button', { name: '关闭' })); // popconfirm 确认（本套禁用了两字按钮插空格）
    expect(clearMock).toHaveBeenCalled();
    expect(await screen.findByText('AI 已关闭')).toBeInTheDocument();
  });
});
