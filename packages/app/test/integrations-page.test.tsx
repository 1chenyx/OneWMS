import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ProfileSnapshot } from '@one/core';
import IntegrationsPage from '../src/pages/IntegrationsPage';

/**
 * 对接页。配置走确认后才生效。密钥写入本机，不出现在提议里，也不回显。
 */

const harness = vi.hoisted(() => {
  const proposeMock = vi.fn();
  const confirmMock = vi.fn();
  const rejectMock = vi.fn();
  const checkMock = vi.fn();
  const putSecret = vi.fn();
  const deleteSecret = vi.fn();
  const invokeMock = vi.fn();
  const confirmToolMock = vi.fn();
  const state: {
    snapshot: ProfileSnapshot | null;
    names: string[];
    rows: { entity: 'sku' | 'partner' | 'warehouse'; externalCode: string; internalCode: string }[];
  } = { snapshot: null, names: [], rows: [] };
  return { proposeMock, confirmMock, rejectMock, checkMock, putSecret, deleteSecret, invokeMock, confirmToolMock, state };
});

vi.mock('../src/api/hooks', () => ({
  useProfileSnapshot: () => ({ isLoading: false, isError: false, data: harness.state.snapshot }),
  useProposeProfile: () => ({ mutateAsync: harness.proposeMock, isPending: false }),
  useConfirmProposal: () => ({ mutateAsync: harness.confirmMock, isPending: false }),
  useRejectProposal: () => ({ mutate: harness.rejectMock, isPending: false }),
  useCheckIntegrationSettings: () => ({ mutateAsync: harness.checkMock, isPending: false }),
  useIntegrationSecrets: () => ({ data: { names: harness.state.names }, isLoading: false }),
  usePutIntegrationSecret: () => ({ mutateAsync: harness.putSecret, isPending: false }),
  useDeleteIntegrationSecret: () => ({ mutateAsync: harness.deleteSecret, isPending: false }),
  useIntegrationCodes: () => ({ data: { rows: harness.state.rows }, isLoading: false }),
  useToolInvoke: () => ({ mutateAsync: harness.invokeMock, isPending: false }),
  useToolConfirm: () => ({ mutateAsync: harness.confirmToolMock, isPending: false }),
}));

const wrap = (ui: ReactNode) => (
  <ConfigProvider button={{ autoInsertSpace: false }}>
    <AntApp>{ui}</AntApp>
  </ConfigProvider>
);

const snapshot = (withConnector: boolean): ProfileSnapshot => ({
  workspaceId: 'ws',
  version: 4,
  schema: { entities: {} },
  workflows: {},
  modules: withConnector
    ? {
        'module.integration': {
          enabled: true,
          settings: {
            pollIntervalSec: 60,
            maxAttempts: 8,
            timeoutMs: 15000,
            writers: { order: 'jiancang', sku: null, partner: null },
            connectors: {
              jiancang: {
                id: 'jiancang',
                name: '简仓',
                enabled: true,
                direction: 'inbound',
                transport: { kind: 'http', baseUrl: 'https://erp.example' },
                auth: { adapter: 'bearer', secretRefs: { token: 'token' } },
                endpoints: [{ id: 'pull', method: 'GET', path: '/orders', shape: 'document' }],
                routes: [
                  {
                    id: 'sales-in',
                    enabled: true,
                    direction: 'in',
                    endpointId: 'pull',
                    inbound: {
                      mode: 'poll',
                      itemsPath: 'data.rows',
                      cursor: { queryParam: 'updatedSince', from: 'iso8601' },
                    },
                    canonical: 'order.create',
                    idempotency: { externalIdPath: 'billNo' },
                    mapping: { fields: [] },
                  },
                ],
              },
            },
          },
        },
      }
    : {},
  roles: {},
});

beforeEach(() => {
  harness.proposeMock.mockReset();
  harness.confirmMock.mockReset();
  harness.rejectMock.mockReset();
  harness.checkMock.mockReset();
  harness.putSecret.mockReset();
  harness.deleteSecret.mockReset();
  harness.invokeMock.mockReset();
  harness.confirmToolMock.mockReset();
  harness.checkMock.mockResolvedValue({ ok: true });
  harness.proposeMock.mockResolvedValue({
    proposalId: 'p-int',
    pendingConfirm: true,
    hint: '',
    report: { summary: '保存对接', items: [] },
  });
  harness.confirmMock.mockResolvedValue({ newVersion: 5, appliedOps: 1 });
  harness.putSecret.mockResolvedValue({ ok: true });
  harness.state.snapshot = snapshot(false);
  harness.state.names = [];
  harness.state.rows = [];
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('对接页', () => {
  it('添加连接器后保存会提议装上对接，密钥不进提议', async () => {
    const user = userEvent.setup();
    render(wrap(<IntegrationsPage />));
    await user.click(screen.getByRole('button', { name: '添加连接器' }));
    await user.type(screen.getByLabelText('令牌'), 's3cret');
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(harness.proposeMock).toHaveBeenCalled());
    expect(harness.putSecret).not.toHaveBeenCalled();
    const proposed = harness.proposeMock.mock.calls[0]?.[0] as {
      note: string;
      patch: { op: string; path: string; value: { settings: { connectors: Record<string, { name: string }> } } }[];
    };
    expect(proposed.note).toBe('对接：保存配置');
    expect(proposed.patch[0]?.op).toBe('add');
    expect(proposed.patch[0]?.path).toBe('/modules/module.integration');
    expect(proposed.patch[0]?.value.settings.connectors.erp.name).toBe('新的对接');
    expect(JSON.stringify(proposed)).not.toContain('s3cret');

    await user.click(await screen.findByRole('button', { name: '生效' }));
    expect(harness.confirmMock).toHaveBeenCalledWith({ id: 'p-int' });
    expect(await screen.findByText(/已生效（v5）/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('s3cret')).not.toBeInTheDocument();
  });

  it('校验不过就不提议，并写出原因', async () => {
    harness.checkMock.mockResolvedValue({
      ok: false,
      issues: [{ path: '/connectors/erp/name', code: 'NAME', message: '名称不能为空' }],
    });
    const user = userEvent.setup();
    render(wrap(<IntegrationsPage />));
    await user.click(screen.getByRole('button', { name: '添加连接器' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByText(/名称不能为空/)).toBeInTheDocument();
    expect(harness.proposeMock).not.toHaveBeenCalled();
  });

  it('已有连接器列出拉取路由，保存走替换', async () => {
    harness.state.snapshot = snapshot(true);
    harness.state.names = ['token'];
    const user = userEvent.setup();
    render(wrap(<IntegrationsPage />));
    expect(screen.getByText('sales-in · 拉取 · 建单')).toBeInTheDocument();
    expect(screen.getByText('本机已有 token')).toBeInTheDocument();
    expect(screen.queryByText('s3cret')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(harness.proposeMock).toHaveBeenCalled());
    const proposed = harness.proposeMock.mock.calls[0]?.[0] as { patch: { op: string; path: string }[] };
    expect(proposed.patch).toEqual([
      expect.objectContaining({ op: 'replace', path: '/modules/module.integration/settings' }),
    ]);
  });

  it('写入密钥后输入清空，页面上不留下值', async () => {
    const user = userEvent.setup();
    render(wrap(<IntegrationsPage />));
    await user.click(screen.getByRole('button', { name: '添加连接器' }));
    const field = screen.getByLabelText('令牌');
    await user.type(field, 's3cret');
    await user.click(screen.getByRole('button', { name: '写入密钥' }));
    await waitFor(() => expect(harness.putSecret).toHaveBeenCalledWith({ connectorId: 'erp', name: 'token', value: 's3cret' }));
    expect(field).toHaveValue('');
    expect(screen.queryByDisplayValue('s3cret')).not.toBeInTheDocument();
  });

  it('绑定编码走确认，不写进对接配置', async () => {
    const user = userEvent.setup();
    harness.invokeMock.mockResolvedValue({
      pending: true,
      token: 'tok-code',
      expiresAt: '2026-11-13T00:10:00.000Z',
      toolId: 'integration.code.bind',
      label: '绑定编码',
      permission: 'write',
      params: { connectorId: 'erp', entity: 'sku', externalCode: 'A1', internalCode: 'SKU-00001' },
    });
    harness.confirmToolMock.mockResolvedValue({
      pending: false,
      toolId: 'integration.code.bind',
      label: '绑定编码',
      result: { connectorId: 'erp', entity: 'sku', externalCode: 'A1', internalCode: 'SKU-00001' },
    });
    render(wrap(<IntegrationsPage />));
    await user.click(screen.getByRole('button', { name: '添加连接器' }));
    expect(screen.getByText('还没有对照。')).toBeInTheDocument();
    await user.type(screen.getByLabelText('对方编码'), 'A1');
    await user.type(screen.getByLabelText('内部编码'), 'SKU-00001');
    await user.click(screen.getByRole('button', { name: '绑定' }));

    expect(harness.invokeMock).toHaveBeenCalledWith({
      toolId: 'integration.code.bind',
      params: { connectorId: 'erp', entity: 'sku', externalCode: 'A1', internalCode: 'SKU-00001' },
    });
    expect(harness.proposeMock).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: '确认执行' }));
    await waitFor(() => expect(harness.confirmToolMock).toHaveBeenCalledWith({ toolId: 'integration.code.bind', token: 'tok-code' }));
    await waitFor(() => expect(screen.queryByDisplayValue('A1')).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue('SKU-00001')).not.toBeInTheDocument();
  });
});
