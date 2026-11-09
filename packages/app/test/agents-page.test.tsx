import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import AgentsPage from '../src/pages/AgentsPage';
import { AppNavProvider, useAppNav } from '../src/app-nav';
import type { AgentCatalog } from '../src/api/client';

/**
 * 助手管理：左边清单和右边详情同时在。详情里点开一块业务再改。
 * mock 数据层，不打真接口。
 */

const agentsMock = vi.fn();
const proposeMock = vi.fn();
const confirmMock = vi.fn();
const rejectMock = vi.fn();

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      agents: () => agentsMock(),
      proposeAgents: (agents: unknown, note?: string) => proposeMock(agents, note),
      confirmProposal: (id: string) => confirmMock(id),
      rejectProposal: (id: string) => rejectMock(id),
    },
  };
});

const catalog: AgentCatalog = {
  agents: [
    {
      id: 'general',
      name: '通用助手',
      description: '查询与出入库',
      systemPrompt: '你是通用仓库助手。',
      tools: ['wms.inventory.query', 'wms.sku.create'],
    },
    {
      id: 'readonly',
      name: '只读助手',
      description: '仅查询',
      systemPrompt: '你是只读助手。',
      tools: ['wms.inventory.query'],
    },
  ],
  tools: [
    { id: 'wms.inventory.query', label: '查询库存', description: '查询库存余量。', permission: 'read' },
    { id: 'wms.inventory.adjust', label: '调整库存', description: '增减库存数量。', permission: 'write' },
    { id: 'wms.order.query', label: '查询单据', description: '按单号查出入库单。', permission: 'read' },
    { id: 'wms.sku.create', label: '创建商品', description: '新建一个 SKU。', permission: 'write' },
    { id: 'memory.read', label: '读取记忆', description: '读取记忆章节。', permission: 'read' },
  ],
};

function PageProbe() {
  const { page } = useAppNav();
  return <div data-testid="page">{page}</div>;
}

const wrap = (ui: ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>
      <AppNavProvider>
        {ui}
        <PageProbe />
      </AppNavProvider>
    </AntApp>
  </ConfigProvider>
);

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  agentsMock.mockReset();
  proposeMock.mockReset();
  confirmMock.mockReset();
  rejectMock.mockReset();
  agentsMock.mockResolvedValue(catalog);
});

async function renderPage() {
  render(wrap(<AgentsPage />));
  expect(await screen.findByRole('button', { name: /通用助手/ })).toBeInTheDocument();
}

describe('助手清单和编辑', () => {
  it('左右同时可见，点另一个助手才换草稿，已有 id 不能改', async () => {
    const user = userEvent.setup();
    await renderPage();

    expect(screen.queryByRole('link', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByText('收起')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '搜索业务或工具' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '展示名' })).toHaveValue('通用助手');
    expect(screen.getByPlaceholderText('如 inspector')).toBeDisabled();
    expect(screen.getByRole('button', { name: /通用助手/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /只读助手/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '库存，只能查询' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /通用助手/ })).toHaveTextContent('可以修改商品，只能查询库存');

    await user.click(screen.getByRole('button', { name: /只读助手/ }));

    expect(screen.getByRole('textbox', { name: '展示名' })).toHaveValue('只读助手');
    expect(screen.queryByDisplayValue('通用助手')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /只读助手/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /通用助手/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByPlaceholderText('如 inspector')).toBeDisabled();
    expect(screen.getByRole('button', { name: '库存，只能查询' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '商品，不开放' })).toBeInTheDocument();
    expect(screen.queryByText('查询库存余量。')).not.toBeInTheDocument();
  });

  it('加载失败时不能保存，避免把空清单提交出去', async () => {
    agentsMock.mockRejectedValueOnce(new Error('network down'));
    render(wrap(<AgentsPage />));

    expect(await screen.findByText('助手清单加载失败')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /新建助手/ })).toBeDisabled();
  });
});

describe('一块业务', () => {
  it('右边点开一块才改这一块，清单仍在', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: /只读助手/ }));
    await user.click(screen.getByRole('button', { name: '库存，只能查询' }));

    expect(screen.getByRole('button', { name: /只读助手/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: '展示名' })).toHaveValue('只读助手');
    expect(screen.getByRole('button', { name: '只能查询' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '可以修改' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: '商品，不开放' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '逐项调整' }));
    expect(screen.getByRole('switch', { name: '调整库存' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: '查询库存' })).toBeChecked();
    expect(screen.queryByText('增减库存数量。')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '可以修改' }));
    await user.click(screen.getByRole('button', { name: '业务一览' }));

    expect(screen.getByRole('button', { name: '库存，可以修改' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '商品，不开放' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '展示名' })).toHaveValue('只读助手');
  });
});

describe('草稿保存', () => {
  it('新建助手后改 id，编辑区还在', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: /新建助手/ }));
    const idInput = screen.getByPlaceholderText('如 inspector');
    expect(idInput).toBeEnabled();
    await user.type(idInput, 'inspector');
    expect(idInput).toHaveValue('inspector');
    await user.type(screen.getByPlaceholderText('如 质检助手'), '质检');
    expect(screen.getByRole('button', { name: /质检/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: '展示名' })).toHaveValue('质检');
    expect(screen.getByText('未保存')).toBeInTheDocument();
  });

  it('保存提交整份清单，并转到对话页', async () => {
    proposeMock.mockResolvedValueOnce({ proposalId: 'p-9' });
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: '库存，只能查询' }));
    await user.click(screen.getByRole('button', { name: '可以修改' }));
    await user.click(screen.getByRole('button', { name: '业务一览' }));
    await user.click(screen.getByRole('button', { name: '商品，可以修改' }));
    await user.click(screen.getByRole('button', { name: '不开放' }));
    await user.click(screen.getByRole('button', { name: /保存（生成提议）/ }));

    const dialog = await screen.findByRole('dialog', { name: '确认助手改动' });
    expect(dialog).toHaveTextContent('「通用助手」改为可以修改库存');
    expect(screen.queryByRole('dialog', { name: '请确认配置变更' })).not.toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveTextContent('skus');

    confirmMock.mockResolvedValueOnce({ newVersion: 4, appliedOps: 1 });
    await user.click(screen.getByRole('button', { name: '确认应用' }));

    expect(proposeMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'general',
          tools: ['wms.inventory.query', 'wms.inventory.adjust'],
        }),
        expect.objectContaining({
          id: 'readonly',
          tools: ['wms.inventory.query'],
        }),
      ],
      '更新 AI 助手定义',
    );
    expect(confirmMock).toHaveBeenCalledWith('p-9');
    expect(await screen.findByText(/助手改动已应用/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveTextContent('skus');
    expect(screen.queryByText('未保存')).not.toBeInTheDocument();
  });

  it('放弃助手改动留在本页，不改当前配置', async () => {
    proposeMock.mockResolvedValueOnce({ proposalId: 'p-8' });
    rejectMock.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    await renderPage();

    await user.type(screen.getByRole('textbox', { name: '展示名' }), '甲');
    await user.click(screen.getByRole('button', { name: /保存（生成提议）/ }));
    expect(await screen.findByRole('dialog', { name: '确认助手改动' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '放弃' }));

    expect(rejectMock).toHaveBeenCalledWith('p-8');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveTextContent('skus');
    expect(screen.getByText('未保存')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '展示名' })).toHaveValue('通用助手甲');
  });

  it('删除要确认，确认后只改本地清单', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: /删除该助手/ }));
    await user.click(await screen.findByRole('button', { name: '删除' }));

    expect(screen.queryByRole('button', { name: /通用助手/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /只读助手/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: '展示名' })).toHaveValue('只读助手');
    expect(proposeMock).not.toHaveBeenCalled();
  });
});
