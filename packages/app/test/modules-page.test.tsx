import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import ModulesPage from '../src/pages/ModulesPage';

/**
 * 模块页：一张卡片一个开关，写明打开后出现在哪里。
 */

const harness = vi.hoisted(() => {
  const proposeMock = vi.fn();
  const confirmMock = vi.fn();
  const rejectMock = vi.fn();
  const state: { snapshot: ProfileSnapshot | null } = { snapshot: null };
  return { proposeMock, confirmMock, rejectMock, state };
});

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, isError: false, data: harness.state.snapshot }),
  useProfileCatalog: () => ({ data: undefined }),
  useProposeProfile: () => ({ mutateAsync: harness.proposeMock, isPending: false }),
  useConfirmProposal: () => ({ mutateAsync: harness.confirmMock, isPending: false }),
  useRejectProposal: () => ({ mutate: harness.rejectMock, isPending: false }),
}));

const wrap = (ui: ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

beforeEach(() => {
  harness.proposeMock.mockReset();
  harness.confirmMock.mockReset();
  harness.rejectMock.mockReset();
  harness.state.snapshot = {
    workspaceId: 'ws',
    version: 13,
    schema: { entities: {} },
    workflows: {},
    modules: {
      'core.wms': { enabled: true, version: '0.1.0' },
      'module.asn': { enabled: true, version: '0.1.0' },
      'module.putaway': { enabled: true, version: '0.1.0' },
      'module.return': { enabled: true, version: '0.1.0' },
      'module.serial': { enabled: false, version: '0.1.0' },
      'module.warehouse': { enabled: false, version: '0.1.0' },
    },
    roles: {},
  };
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('模块页', () => {
  it('卡片写明出现在哪里，收发步骤不在这页', () => {
    render(wrap(<ModulesPage />));
    expect(screen.getByText('作业里会出现「序列号」')).toBeInTheDocument();
    expect(screen.getByText('收发时要填写每一件的号')).toBeInTheDocument();
    expect(screen.getByText('出入库单可以按原单开客退或退供')).toBeInTheDocument();
    expect(screen.getByText('库位页可以新建仓库，把库位划进去')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '序列号' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: '退货' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '序列号' }).closest('article')?.getAttribute('data-on')).toBe('false');
    expect(screen.queryByRole('switch', { name: '预报' })).not.toBeInTheDocument();
    expect(screen.queryByText('仓储基础')).not.toBeInTheDocument();
  });

  it('打开序列号后卡片说明作业里会出现它，生效后才提交', async () => {
    harness.proposeMock.mockResolvedValue({
      proposalId: 'p-serial',
      pendingConfirm: true,
      hint: '',
      report: { summary: '启用序列号', items: [] },
    });
    harness.confirmMock.mockResolvedValue({ newVersion: 14, appliedOps: 1 });
    const user = userEvent.setup();
    render(wrap(<ModulesPage />));

    await user.click(screen.getByRole('switch', { name: '序列号' }));
    expect(harness.proposeMock).toHaveBeenCalledWith({
      patch: [{ op: 'replace', path: '/modules/module.serial/enabled', value: true }],
      note: '模块：打开序列号',
    });
    expect(screen.getByRole('switch', { name: '序列号' }).closest('article')?.getAttribute('data-on')).toBe('true');
    const bar = await screen.findByRole('region', { name: '确认这次修改' });
    expect(bar).toHaveTextContent('打开后，作业里会出现序列号');
    expect(bar).toHaveTextContent('已经做完的单据不变');

    await waitFor(() => expect(screen.getByRole('button', { name: '生效' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '生效' }));
    expect(harness.confirmMock).toHaveBeenCalledWith({ id: 'p-serial' });
    expect(await screen.findByText(/已生效（v14）/)).toBeInTheDocument();
  });
});