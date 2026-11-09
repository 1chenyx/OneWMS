import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import type { ProfileCatalog } from '../src/api/profile-api';
import FlowsPage from '../src/pages/FlowsPage';

/**
 * 流程页：流程图。关掉可选步骤后，箭头绕过该方块。
 */

const harness = vi.hoisted(() => {
  const proposeMock = vi.fn();
  const confirmMock = vi.fn();
  const rejectMock = vi.fn();
  const state: { snapshot: ProfileSnapshot | null; catalog: ProfileCatalog | null } = {
    snapshot: null,
    catalog: null,
  };
  return { proposeMock, confirmMock, rejectMock, state };
});

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, isError: false, data: harness.state.snapshot }),
  useProfileCatalog: () => ({ data: harness.state.catalog ?? undefined }),
  useProposeProfile: () => ({ mutateAsync: harness.proposeMock, isPending: false }),
  useConfirmProposal: () => ({ mutateAsync: harness.confirmMock, isPending: false }),
  useRejectProposal: () => ({ mutate: harness.rejectMock, isPending: false }),
}));

function snapshot(): ProfileSnapshot {
  return {
    workspaceId: 'ws',
    version: 13,
    schema: { entities: {} },
    workflows: {},
    modules: {
      'core.wms': { enabled: true, version: '0.1.0' },
      'module.asn': { enabled: true, version: '0.1.0' },
      'module.putaway': { enabled: true, version: '0.1.0' },
      'module.picking': { enabled: true, version: '0.1.0' },
      'module.reservation': { enabled: true, version: '0.1.0' },
      'module.partial': { enabled: true, version: '0.1.0' },
      'module.reversal': { enabled: true, version: '0.1.0' },
      'module.return': { enabled: true, version: '0.1.0' },
      'module.serial': { enabled: false, version: '0.1.0' },
    },
    roles: {},
  };
}

const catalog: ProfileCatalog = {
  modules: [
    {
      id: 'module.asn',
      name: '到货预报',
      description: '入库前的到货预报。',
      system: false,
      contributions: [],
    },
    {
      id: 'core.wms',
      name: '仓储基础',
      description: '仓储管理核心领域。',
      system: true,
      contributions: [],
    },
  ],
};

function chartNodes(lane: 'inbound' | 'outbound'): { label: string; active: string | null }[] {
  const chart = document.querySelector(`[data-testid="${lane}-chart"]`);
  return [...(chart?.querySelectorAll('[data-node]') ?? [])].map((node) => ({
    label: node.getAttribute('data-node') ?? '',
    active: node.getAttribute('data-active'),
  }));
}

const wrap = (ui: ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

async function applyReady() {
  await waitFor(() => expect(screen.getByRole('button', { name: '生效' })).toBeEnabled());
}

beforeEach(() => {
  harness.proposeMock.mockReset();
  harness.confirmMock.mockReset();
  harness.rejectMock.mockReset();
  harness.state.snapshot = snapshot();
  harness.state.catalog = catalog;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('流程页', () => {
  it('入库和出库画在同一页，仓库能力不出现', () => {
    render(wrap(<FlowsPage />));
    expect(chartNodes('inbound').map((node) => node.label)).toEqual(['建单', '预报', '收货', '上架', '完成']);
    expect(chartNodes('inbound').every((node) => node.active === 'true')).toBe(true);
    expect(chartNodes('outbound').map((node) => node.label)).toEqual(['建单', '拣货', '发货', '完成']);
    expect(screen.getByRole('switch', { name: '预报' })).toBeChecked();
    expect(screen.getByRole('switch', { name: /^拣货$/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: '拣货：占库存' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '收货：按实数' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '发货：可冲销' })).toBeChecked();
    expect(screen.queryByRole('switch', { name: '序列号' })).not.toBeInTheDocument();
    expect(screen.queryByText('仓储基础')).not.toBeInTheDocument();
    expect(screen.queryByText('退货')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '出库规则' })).not.toBeInTheDocument();
  });

  it('关掉预报后箭头从建单绕到收货，生效后才提交', async () => {
    harness.proposeMock.mockResolvedValue({
      proposalId: 'p-9',
      pendingConfirm: true,
      hint: '',
      report: {
        summary: '共 1 项变更',
        items: [
          {
            severity: 'info',
            kind: 'module.disabled',
            target: 'module.asn',
            description: '模块「module.asn」停用——引用其开关的流程条件将随之变化',
          },
        ],
      },
    });
    harness.confirmMock.mockResolvedValue({ newVersion: 14, appliedOps: 1 });
    const user = userEvent.setup();
    render(wrap(<FlowsPage />));

    await user.click(screen.getByRole('switch', { name: '预报' }));
    expect(harness.proposeMock).toHaveBeenCalledWith({
      patch: [{ op: 'replace', path: '/modules/module.asn/enabled', value: false }],
      note: '流程：关掉预报',
    });
    expect(chartNodes('inbound').find((node) => node.label === '预报')?.active).toBe('false');
    const bypass = document.querySelector('[data-testid="inbound-chart"] [data-from="建单"][data-to="收货"]');
    expect(bypass?.querySelector('[data-node="预报"]')).toBeTruthy();
    const bar = await screen.findByRole('region', { name: '确认这次修改' });
    expect(bar).toHaveTextContent('关掉后，从建单直接到收货');
    expect(bar).toHaveTextContent('已经做完的单据不变');

    await applyReady();
    await user.click(screen.getByRole('button', { name: '查看细节' }));
    expect(screen.getByText(/模块「到货预报」停用/)).toBeInTheDocument();
    expect(screen.queryByText(/module\.asn/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '生效' }));
    expect(harness.confirmMock).toHaveBeenCalledWith({ id: 'p-9' });
    expect(await screen.findByText(/已生效（v14）/)).toBeInTheDocument();
    expect(harness.rejectMock).not.toHaveBeenCalled();
  });

  it('关掉拣货后箭头从建单绕到发货', async () => {
    harness.proposeMock.mockResolvedValue({
      proposalId: 'p-pick',
      pendingConfirm: true,
      hint: '',
      report: { summary: '共 1 项变更', items: [] },
    });
    const user = userEvent.setup();
    render(wrap(<FlowsPage />));

    await user.click(screen.getByRole('switch', { name: /^拣货$/ }));
    expect(harness.proposeMock).toHaveBeenCalledWith({
      patch: [{ op: 'replace', path: '/modules/module.picking/enabled', value: false }],
      note: '流程：关掉拣货',
    });
    expect(chartNodes('outbound').find((node) => node.label === '拣货')?.active).toBe('false');
    const bypass = document.querySelector('[data-testid="outbound-chart"] [data-from="建单"][data-to="发货"]');
    expect(bypass?.querySelector('[data-node="拣货"]')).toBeTruthy();
    expect(await screen.findByRole('region', { name: '确认这次修改' })).toHaveTextContent('关掉后，建单直接发货');
  });

  it('撤销后预报回到主路径', async () => {
    harness.proposeMock.mockResolvedValue({
      proposalId: 'p-9',
      pendingConfirm: true,
      hint: '',
      report: { summary: '共 1 项变更', items: [] },
    });
    const user = userEvent.setup();
    render(wrap(<FlowsPage />));
    await user.click(screen.getByRole('switch', { name: '预报' }));
    await applyReady();
    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(harness.rejectMock).toHaveBeenCalledWith('p-9', expect.any(Object));
    expect(harness.confirmMock).not.toHaveBeenCalled();
    expect(chartNodes('inbound').find((node) => node.label === '预报')?.active).toBe('true');
    expect(document.querySelector('[data-from="建单"][data-to="收货"]')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '确认这次修改' })).not.toBeInTheDocument();
  });
});
