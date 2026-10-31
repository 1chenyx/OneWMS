import { describe, it, expect, beforeEach } from 'vitest';
import {
  OneCore,
  ToolNotFoundError,
  ToolValidationError,
  type ToolDefinition,
  type ToolContext,
} from '../src/index.js';

let core: OneCore;
let ws: ReturnType<OneCore['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = core.workspace('ws-test');
});

/** 领域工具示例（模拟未来 @one/wms 的出库工具：业务校验在 handler 内，规则即护栏） */
const adjustTool: ToolDefinition<{ delta: number }> = {
  id: 'wms.inventory.adjust',
  label: '库存调整',
  description: '对某 SKU 某库位做库存增减，delta 为负时校验库存不可为负',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      sku: { type: 'string', description: 'SKU 编码' },
      delta: { type: 'integer', minimum: -100000, maximum: 100000 },
    },
    required: ['sku', 'delta'],
  },
  handler: (params, ctx) => {
    if (params.delta < -50) {
      throw new Error('TOOL_REJECTED: 单次出库不得超过 50');
    }
    const event = ctx.appendEvent('wms.inventory.adjusted', params);
    return { ok: true, eventId: (event as { eventId: string }).eventId };
  },
};

describe('工具总线', () => {
  it('注册 + listTools 暴露元数据（handler 不可见——AI 上下文安全）', () => {
    ws.tools.register(adjustTool);
    const tools = ws.tools.list();
    // 内核默认注册 profile.propose（M4 慢通道入口）+ 本测试注册的领域工具
    expect(tools.map((t) => t.id)).toContain('wms.inventory.adjust');
    const listed = tools.find((t) => t.id === 'wms.inventory.adjust')!;
    expect(listed).toMatchObject({
      id: 'wms.inventory.adjust',
      permission: 'write',
    });
    expect(listed).not.toHaveProperty('handler');
  });

  it('工具 id 必须带命名空间', () => {
    expect(() =>
      ws.tools.register({ ...adjustTool, id: 'no-namespace' }),
    ).toThrow(ToolValidationError);
  });

  it('invoke：ctx 携带 workspaceId / actor，appendEvent 落账本', async () => {
    ws.tools.register(adjustTool);
    const result = (await ws.tools.invoke(
      'wms.inventory.adjust',
      { sku: 'A-1', delta: 5 },
      'ai:assistant',
    )) as { ok: boolean; eventId: string };

    expect(result.ok).toBe(true);
    const marks = ws.events.watermarks();
    expect(marks['ai:assistant'].seq).toBe(1); // actor = 调用者（AI 审计可追溯，§9.3）

    let seen: { actor: string; type: string; payload: unknown } | undefined;
    ws.events.forEach((e) => {
      seen = { actor: e.actor, type: e.type, payload: e.payload };
    });
    expect(seen?.actor).toBe('ai:assistant');
    expect(seen?.type).toBe('wms.inventory.adjusted');
    expect(seen?.payload).toEqual({ sku: 'A-1', delta: 5 });
  });

  it('未知工具 → ToolNotFoundError', async () => {
    await expect(ws.tools.invoke('wms.ghost.run', {})).rejects.toThrow(ToolNotFoundError);
  });

  it('参数校验：缺必填 / 类型错 / 越界 / enum', async () => {
    ws.tools.register(adjustTool);
    await expect(ws.tools.invoke('wms.inventory.adjust', { sku: 'A-1' })).rejects.toThrow(
      ToolValidationError,
    );
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { sku: 'A-1', delta: 'five' }),
    ).rejects.toThrow(ToolValidationError);
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { sku: 'A-1', delta: 999999 }),
    ).rejects.toThrow(ToolValidationError);
  });

  it('业务校验在 handler 内部——被拒的调用不产生事件（命令失败 ≠ 事实）', async () => {
    ws.tools.register(adjustTool);
    await expect(
      ws.tools.invoke('wms.inventory.adjust', { sku: 'A-1', delta: -60 }, 'ai:assistant'),
    ).rejects.toThrow();

    expect(ws.events.count()).toBe(0);
  });

  it('默认 actor 为本节点；注销工具后不可再调用', async () => {
    ws.tools.register(adjustTool);
    await ws.tools.invoke('wms.inventory.adjust', { sku: 'A-1', delta: 1 });
    expect(ws.events.watermarks()[core.nodeId].seq).toBe(1);

    ws.tools.unregister('wms.inventory.adjust');
    await expect(ws.tools.invoke('wms.inventory.adjust', { sku: 'A-1', delta: 1 })).rejects.toThrow(
      ToolNotFoundError,
    );
  });
});

describe('工具总线：参数校验器细节', () => {
  const echo: ToolDefinition = {
    id: 'test.echo',
    label: '回声',
    description: '校验器测试',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['mode'],
    },
    handler: (p) => p,
  };

  beforeEach(() => ws.tools.register(echo));

  it('enum 合法值通过，非法值拒绝', async () => {
    await expect(ws.tools.invoke('test.echo', { mode: 'fast' })).resolves.toBeTruthy();
    await expect(ws.tools.invoke('test.echo', { mode: 'turbo' })).rejects.toThrow(
      ToolValidationError,
    );
  });

  it('数组元素类型递归校验', async () => {
    await expect(ws.tools.invoke('test.echo', { mode: 'fast', tags: ['a', 'b'] })).resolves
      .toBeTruthy();
    await expect(ws.tools.invoke('test.echo', { mode: 'fast', tags: ['a', 42] })).rejects.toThrow(
      ToolValidationError,
    );
  });

  it('params 为空对象/undefined 时 required 报错', async () => {
    await expect(ws.tools.invoke('test.echo', {})).rejects.toThrow(ToolValidationError);
    await expect(ws.tools.invoke('test.echo', undefined)).rejects.toThrow(ToolValidationError);
  });
});
