import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneCore } from '../src/index.js';

describe('OneCore 与多工作区（§13.5 口子）', () => {
  it('node id 持久化：同一文件二次打开保持同一身份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'one-core-'));
    try {
      const dbPath = join(dir, 'app.db');
      const first = OneCore.open(dbPath);
      const idFirst = first.nodeId;
      first.close();

      const second = OneCore.open(dbPath);
      expect(second.nodeId).toBe(idFirst);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一进程多工作区并存，互不串扰（SaaS 形态的本地雏形）', () => {
    const core = OneCore.open(':memory:');
    const personal = core.workspace('ws-personal');
    const company = core.workspace('ws-company');

    personal.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    personal.events.append('wms.sku.created', { skuCode: 'P-1' });
    company.events.append('wms.sku.created', { skuCode: 'C-1' });

    expect(personal.fields.list('batch')).toHaveLength(1);
    expect(company.fields.list('batch')).toHaveLength(0);
    expect(personal.events.count()).toBe(2); // provide 事件 + 业务事件
    expect(company.events.count()).toBe(1);

    // 各自重放互不影响
    personal.replay();
    expect(personal.fields.list('batch')).toHaveLength(1);
    expect(company.events.count()).toBe(1);
    core.close();
  });

  it('端到端：注册字段 → AI 工具调用 → 事件账本 → 重放重建，全链路一致', async () => {
    const core = OneCore.open(':memory:');
    const ws = core.workspace('ws-e2e');

    // ① 模块提供字段
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });

    // ② 领域工具（业务校验 + 事件落账）
    ws.tools.register({
      id: 'wms.inventory.adjust',
      label: '库存调整',
      description: '调整库存数量',
      permission: 'write',
      parameters: {
        type: 'object',
        properties: { sku: { type: 'string' }, delta: { type: 'integer' } },
        required: ['sku', 'delta'],
      },
      handler: (params, ctx) => {
        const event = ctx.appendEvent('wms.inventory.adjusted', params);
        return { eventId: (event as { eventId: string }).eventId };
      },
    });

    // ③ AI 调用
    await ws.tools.invoke('wms.inventory.adjust', { sku: 'A-1', delta: 5 }, 'ai:assistant');

    // ④ 账本完整
    expect(ws.events.count()).toBe(2); // registry 事件 + 业务事件
    const marks = ws.events.watermarks();
    expect(marks['ai:assistant'].seq).toBe(1);

    // ⑤ 重放后注册表与账本一致
    const result = ws.replay();
    expect(result.totalEvents).toBe(2);
    expect(ws.fields.get('batch', 'expiry_date')).toBeDefined();

    core.close();
  });
});
