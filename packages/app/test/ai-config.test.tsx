import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import AiConfigPage from '../src/pages/AiConfigPage';
import type { AiProfilePublic } from '../src/api/agent-api';

/**
 * AI 模型配置页：厂商画廊（地址预填，只填密钥）+ 已保存的多模型。
 * mock 数据层 hooks，不打真接口。
 */

const addMock = vi.fn();
const activateMock = vi.fn();
const deleteMock = vi.fn();
const clearMock = vi.fn();
const testMock = vi.fn();

interface StatusFixture {
  configured: boolean;
  source: 'file' | 'env' | 'none';
  config?: {
    kind: 'openai-compatible' | 'ollama';
    model: string;
    baseUrl: string;
    apiKeySet: boolean;
  };
  profiles?: AiProfilePublic[];
}

let statusFixture: StatusFixture = { configured: false, source: 'none', profiles: [] };

vi.mock('../src/api/hooks', () => ({
  useAiConfig: () => ({ isLoading: false, data: statusFixture }),
  useAddAiProfiles: () => ({ mutateAsync: addMock, isPending: false }),
  useActivateAiProfile: () => ({ mutateAsync: activateMock, isPending: false }),
  useDeleteAiProfile: () => ({ mutateAsync: deleteMock, isPending: false }),
  useClearAiConfig: () => ({ mutateAsync: clearMock, isPending: false }),
  useTestAiConfig: () => ({ mutateAsync: testMock, isPending: false }),
}));

const wrap = (ui: React.ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  addMock.mockReset();
  activateMock.mockReset();
  deleteMock.mockReset();
  clearMock.mockReset();
  testMock.mockReset();
  statusFixture = { configured: false, source: 'none', profiles: [] };
});

describe('厂商画廊', () => {
  it('国内厂商直接可见；国际厂商要点过去才出现', async () => {
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    expect(screen.getByText('未配置')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '通义千问' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '豆包（火山方舟）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OpenAI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '关闭 AI' })).not.toBeInTheDocument();

    await user.click(screen.getByText('国际'));
    expect(screen.getByRole('button', { name: 'OpenAI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'xAI（Grok）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OpenRouter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'DeepSeek' })).not.toBeInTheDocument();
  });

  it('点 DeepSeek 带出预填地址和默认模型；没填密钥不能保存', async () => {
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'DeepSeek' }));
    expect(screen.getByText('https://api.deepseek.com/v1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deepseek-flash', pressed: true })).toBeInTheDocument();
    expect(screen.queryByLabelText('模型 ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('其他模型 ID')).not.toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '添加并设为当前' }));
    expect(await screen.findByText('请填写 API Key')).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('填上密钥后按预填地址和默认模型保存', async () => {
    addMock.mockResolvedValueOnce({
      configured: true,
      source: 'file',
      config: { kind: 'openai-compatible', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', apiKeySet: true },
      profiles: [],
    });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    await user.click(screen.getByRole('button', { name: 'DeepSeek' }));
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: '添加并设为当前' }));

    expect(addMock).toHaveBeenCalledWith({
      vendorId: 'deepseek',
      label: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      models: ['deepseek-flash'],
      activate: true,
    });
    expect(await screen.findByText('已保存，当前使用 deepseek-flash')).toBeInTheDocument();
  });

  it('只有自定义要手填模型 ID', async () => {
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    await user.click(screen.getByRole('button', { name: '豆包（火山方舟）' }));
    expect(screen.getByRole('button', { name: 'doubao-seed-evolving', pressed: true })).toBeInTheDocument();
    expect(screen.queryByLabelText('模型 ID')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '自定义' }));
    expect(screen.getByLabelText('模型 ID')).toBeInTheDocument();
    await user.type(screen.getByLabelText('接口地址'), 'https://example.com/v1');
    await user.click(screen.getByRole('button', { name: '添加并设为当前' }));
    expect(await screen.findByText('请填写模型 ID')).toBeInTheDocument();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('本地 Ollama 不出现密钥，保存体是 ollama', async () => {
    addMock.mockResolvedValueOnce({
      configured: true,
      source: 'file',
      config: { kind: 'ollama', model: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1', apiKeySet: false },
    });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    await user.click(screen.getByText('本地'));
    await user.click(screen.getByRole('button', { name: 'Ollama' }));
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(screen.getByText('http://localhost:11434/v1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'qwen3:8b', pressed: true })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '添加并设为当前' }));
    expect(addMock).toHaveBeenCalledWith({
      vendorId: 'ollama',
      label: 'Ollama',
      kind: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      models: ['qwen3:8b'],
      activate: true,
    });
  });
});

describe('已保存的模型', () => {
  const profiles: AiProfilePublic[] = [
    {
      id: 'p1',
      vendorId: 'deepseek',
      label: 'DeepSeek',
      kind: 'openai-compatible',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeySet: true,
      active: true,
    },
    {
      id: 'p2',
      vendorId: 'openai',
      label: 'OpenAI',
      kind: 'openai-compatible',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKeySet: true,
      active: false,
    },
  ];

  it('当前使用有标记；设为当前打到那一条', async () => {
    statusFixture = {
      configured: true,
      source: 'file',
      config: {
        kind: 'openai-compatible',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeySet: true,
      },
      profiles,
    };
    activateMock.mockResolvedValueOnce({
      configured: true,
      source: 'file',
      config: { model: 'gpt-4o-mini' },
    });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    expect(screen.getByText('当前使用')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '设为当前' }));
    expect(activateMock).toHaveBeenCalledWith('p2');
  });

  it('关闭 AI 二次确认后清掉页面配置', async () => {
    statusFixture = {
      configured: true,
      source: 'file',
      config: {
        kind: 'ollama',
        model: 'qwen3:8b',
        baseUrl: 'http://localhost:11434/v1',
        apiKeySet: false,
      },
      profiles: [
        {
          id: 'p1',
          vendorId: 'ollama',
          label: 'Ollama',
          kind: 'ollama',
          model: 'qwen3:8b',
          baseUrl: 'http://localhost:11434/v1',
          apiKeySet: false,
          active: true,
        },
      ],
    };
    clearMock.mockResolvedValueOnce({ configured: false, source: 'none' });
    const user = userEvent.setup();
    render(wrap(<AiConfigPage />));
    await user.click(screen.getByRole('button', { name: '关闭 AI' }));
    await user.click(await screen.findByRole('button', { name: '关闭' }));
    expect(clearMock).toHaveBeenCalled();
    expect(await screen.findByText('AI 已关闭')).toBeInTheDocument();
  });
});
