import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import type { ProfileCatalog } from '../src/api/profile-api';
import RulesPage from '../src/pages/RulesPage';

/**
 * 规则页：整仓出库规则。确认后才写入。
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
    },
    roles: {},
  };
}

const catalog: ProfileCatalog = {
  modules: [
    {
      id: 'core.wms',
      name: '仓储基础',
      description: '仓储管理核心领域。',
      system: true,
      contributions: [],
    },
  ],
};

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

describe('规则页', () => {
  it('出库规则整仓一套，缺省是严格桶并且可以换', () => {
    render(wrap(<RulesPage />));
    expect(screen.getByRole('heading', { name: '规则' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '出库规则' })).toBeInTheDocument();
    expect(screen.getByText(/单上不再另选/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /严格桶/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: '过期批次不能出' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /指定批次可以换/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /指定库位可以换/ })).toBeChecked();
  });

  it('批次怎么扣改的是仓库设置，确认后才提交', async () => {
    harness.proposeMock.mockResolvedValue({
      proposalId: 'p-rule',
      pendingConfirm: true,
      hint: '',
      report: { summary: '共 1 项变更', items: [] },
    });
    harness.confirmMock.mockResolvedValue({ newVersion: 15, appliedOps: 1 });
    const user = userEvent.setup();
    render(wrap(<RulesPage />));

    await user.click(screen.getByRole('radio', { name: /先进先出/ }));
    expect(harness.proposeMock).toHaveBeenCalledWith({
      patch: [{ op: 'replace', path: '/modules/core.wms/settings/defaultAllocation', value: 'fifo' }],
      note: '规则：出库改为先进先出',
    });
    const bar = await screen.findByRole('region', { name: '确认这次修改' });
    expect(bar).toHaveTextContent('批次怎么扣改为先进先出');
    expect(bar).toHaveTextContent('已经开出的单还是原来的批次');
    expect(screen.getByRole('radio', { name: /先进先出/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: '过期批次不能出' })).toBeDisabled();

    await applyReady();
    await user.click(screen.getByRole('button', { name: '生效' }));
    expect(harness.confirmMock).toHaveBeenCalledWith({ id: 'p-rule' });
    expect(await screen.findByText(/已生效（v15）/)).toBeInTheDocument();
  });

  it('过期批次开关提议 blockExpiredOutbound', async () => {
    harness.proposeMock.mockResolvedValue({
      proposalId: 'p-exp',
      pendingConfirm: true,
      hint: '',
      report: { summary: '共 1 项变更', items: [] },
    });
    const user = userEvent.setup();
    render(wrap(<RulesPage />));

    await user.click(screen.getByRole('switch', { name: '过期批次不能出' }));
    expect(harness.proposeMock).toHaveBeenCalledWith({
      patch: [{ op: 'replace', path: '/modules/core.wms/settings/blockExpiredOutbound', value: true }],
      note: '规则：打开过期批次拦截',
    });
    expect(await screen.findByRole('region', { name: '确认这次修改' })).toHaveTextContent('打开过期拦截');
    expect(screen.getByRole('switch', { name: '过期批次不能出' })).toBeChecked();
  });

  it('指定批次能不能换也是仓库设置', async () => {
    harness.proposeMock.mockResolvedValue({
      proposalId: 'p-lock',
      pendingConfirm: true,
      hint: '',
      report: { summary: '共 1 项变更', items: [] },
    });
    const user = userEvent.setup();
    render(wrap(<RulesPage />));

    await user.click(screen.getByRole('radio', { name: /指定批次不能换/ }));
    expect(harness.proposeMock).toHaveBeenCalledWith({
      patch: [{ op: 'replace', path: '/modules/core.wms/settings/specifiedBatchConstraint', value: 'lock' }],
      note: '规则：指定批次改为不能换',
    });
    expect(await screen.findByRole('region', { name: '确认这次修改' })).toHaveTextContent('写了批次的行改为不能换');
  });
});
