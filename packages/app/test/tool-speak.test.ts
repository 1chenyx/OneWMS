import { describe, expect, it } from 'vitest';
import { humanError, speakInvocation, speakRun } from '../src/chat/tool-speak';
import type { ChatInvocation } from '../src/api/client';

function inv(partial: Partial<ChatInvocation> & Pick<ChatInvocation, 'toolId'>): ChatInvocation {
  return { callId: 'c1', args: {}, ...partial };
}

describe('工具调用人话', () => {
  it('成功的建档和开单说清楚编码、单号，不出现工具名', () => {
    const sku = speakInvocation(
      inv({
        toolId: 'wms.sku.create',
        args: { skuCode: 'A-1', name: '螺丝' },
        ok: true,
        payload: { skuId: 'x', skuCode: 'A-1' },
      }),
    );
    expect(sku.title).toBe('创建了商品 A-1 螺丝');
    expect(sku.title).not.toContain('wms.');

    const order = speakInvocation(
      inv({
        toolId: 'wms.order.create',
        args: { direction: 'out', lines: [{ skuCode: 'A-1', quantity: 2 }] },
        ok: true,
        payload: { orderNo: 'OUT-1', state: 'created' },
      }),
    );
    expect(order.title).toBe('开了出库单 OUT-1');
    expect(order.details).toEqual(['共 1 行']);

    const canceled = speakInvocation(
      inv({
        toolId: 'wms.order.cancel',
        args: { orderNo: 'IN-1' },
        ok: true,
        payload: { orderNo: 'IN-1', from: 'created', to: 'canceled' },
      }),
    );
    expect(canceled.title).toBe('取消了单据 IN-1');
    expect(canceled.title).not.toContain('wms.');
  });

  it('失败只留原因，去掉错误类名', () => {
    expect(humanError('InsufficientStockError: 库存不足')).toBe('库存不足');
    const spoken = speakInvocation(
      inv({
        toolId: 'wms.inventory.adjust',
        args: { skuCode: 'A-1', delta: -999 },
        ok: false,
        payload: { error: 'InsufficientStockError: 库存不足' },
      }),
    );
    expect(spoken.title).toContain('库存不足');
    expect(spoken.title).not.toContain('Insufficient');
  });

  it('多条收成一句概括', () => {
    const summary = speakRun([
      inv({ toolId: 'wms.sku.create', args: { skuCode: 'A-1' }, ok: true, payload: { skuCode: 'A-1' } }),
      inv({ toolId: 'wms.order.create', callId: 'c2', args: { direction: 'in' }, ok: true, payload: { orderNo: 'IN-1' } }),
    ]);
    expect(summary).toBe('做了 2 项（创建商品、开出入库单）');
  });

  it('加载工具说明只说组名', () => {
    const spoken = speakInvocation(
      inv({
        toolId: 'tools.load',
        args: { group: 'order' },
        ok: true,
        payload: { group: 'order', toolIds: ['wms.order.create'] },
      }),
    );
    expect(spoken.title).toBe('加载了 order 的完整说明');
    expect(spoken.title).not.toContain('wms.');
  });

  it('项目实况查询说人话，不露出工具名', () => {
    const spoken = speakInvocation(
      inv({ toolId: 'profile.workflow.query', args: { workflowId: 'inbound' }, ok: true, payload: {} }),
    );
    expect(spoken.title).toBe('查了流程 inbound');
    expect(spoken.title).not.toContain('profile.');
  });

  it('按表格处理的结果说出新建、更新和没做成的行', () => {
    const spoken = speakInvocation(
      inv({
        toolId: 'chat.attachment.apply',
        args: { action: 'sku' },
        ok: true,
        payload: {
          action: 'sku',
          created: 2,
          updated: 1,
          failedCount: 1,
          failed: [{ row: 4, skuCode: 'A-9', error: '缺少名称' }],
        },
      }),
    );
    expect(spoken.title).toBe('按表格处理了商品：新建 2 个，更新 1 个，1 行没做成');
    expect(spoken.details).toEqual(['第 4 行 A-9：缺少名称']);
  });
});
