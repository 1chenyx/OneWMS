import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ImpactReportView from '../src/components/ImpactReportView';
import ToolInvocationCard from '../src/components/ToolInvocationCard';
import type { ImpactReport } from '@one/core';

/** 报告条目由后端生成中文 description——前端只排版，直出即所见 */
const report: ImpactReport = {
  summary: '共 2 项变更：字段 1，流程 1。',
  items: [
    { severity: 'info', kind: 'field', target: 'sku.spec', description: '字段「规格」将从界面隐藏（数据保留）' },
    { severity: 'warning', kind: 'workflow', target: 'inbound', description: '转移 created→received 的 when 条件全部为条件式，存在死锁风险' },
  ],
} as ImpactReport;

describe('ImpactReportView', () => {
  it('summary + 条目 description 直出，warning/info 分级渲染', () => {
    render(<ImpactReportView report={report} />);
    expect(screen.getByText('共 2 项变更：字段 1，流程 1。')).toBeInTheDocument();
    expect(screen.getByText(/字段「规格」将从界面隐藏/)).toBeInTheDocument();
    expect(screen.getByText(/死锁风险/)).toBeInTheDocument();
    // warning/info 分级渲染（两条 Alert，其一为 warning 语义色）
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.some((a) => a.className.includes('ant-alert-warning'))).toBe(true);
    expect(alerts.some((a) => a.className.includes('ant-alert-info'))).toBe(true);
  });
});

describe('ToolInvocationCard', () => {
  it('成功调用：绿色标记 + 工具名 + 参数', () => {
    render(
      <ToolInvocationCard
        invocation={{ toolId: 'wms.sku.create', args: { skuCode: 'A-1' }, ok: true, payload: { skuId: 'x' } }}
      />,
    );
    expect(screen.getByText('wms.sku.create')).toBeInTheDocument();
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText(/skuCode/)).toBeInTheDocument();
  });

  it('被拒调用：红色标记 + 错误原因可见（护栏透明）', () => {
    render(
      <ToolInvocationCard
        invocation={{
          toolId: 'wms.inventory.adjust',
          args: { skuCode: 'A-1', delta: -999 },
          ok: false,
          payload: { error: 'InsufficientStockError: 库存不足' },
        }}
      />,
    );
    expect(screen.getByText('被拒')).toBeInTheDocument();
    expect(screen.getByText(/库存不足/)).toBeInTheDocument();
  });
});
