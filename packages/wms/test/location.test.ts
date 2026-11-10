import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore, type EventEnvelope } from '@one/core';
import {
  WmsDomain,
  LocationAlreadyExistsError,
  LocationNotFoundError,
  DEFAULT_LOCATION_ID,
} from '../src/index.js';

/**
 * 库位主数据（M10）：
 *  - 创建（编码唯一 / 保留字 DEFAULT 拒绝 / name 缺省同编码）+ 清单
 *  - 库位存在性守卫：adjust / query 引用未建库位即拒
 *  - 虚拟默认库位：显式引用 DEFAULT 直通，不占实体清单
 */

let core: OneCore;
let ws: ReturnType<WmsDomain['workspace']>;

beforeEach(async () => {
  core = OneCore.open(':memory:');
  const domain = WmsDomain.attach(core);
  ws = domain.workspace('ws-location');
  await ws.tools.invoke('wms.sku.create', { skuCode: 'A-1', name: '螺丝' });
});

afterEach(() => {
  core.close();
});

function countEvents(): number {
  let n = 0;
  ws.events.forEach(() => n++);
  return n;
}

describe('库位主数据', () => {
  it('创建成功：返回值 + 投影可查 + 事件落账', async () => {
    const before = countEvents();
    const r = (await ws.tools.invoke('wms.location.create', {
      locationCode: 'A-01',
      name: '一号架',
    })) as { locationId: string; locationCode: string; name: string };
    expect(r.locationId).toBeTruthy();
    expect(r.locationCode).toBe('A-01');
    expect(r.name).toBe('一号架');

    expect(ws.locations.byCode('A-01')?.name).toBe('一号架');
    expect(countEvents()).toBe(before + 1);

    const list = (await ws.tools.invoke('wms.location.list', {})) as {
      locationCode: string;
      name: string;
    }[];
    expect(list).toEqual([{ locationCode: 'A-01', name: '一号架', createdAt: expect.any(String) }]);
  });

  it('name 缺省同编码', async () => {
    const r = (await ws.tools.invoke('wms.location.create', { locationCode: 'B-02' })) as {
      name: string;
    };
    expect(r.name).toBe('B-02');
    expect(ws.locations.byCode('B-02')?.name).toBe('B-02');
  });

  it('重复编码 → 拒绝且零事件', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01' });
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.location.create', { locationCode: 'A-01' }),
    ).rejects.toThrow(LocationAlreadyExistsError);
    expect(countEvents()).toBe(before);
    expect(ws.locations.list()).toHaveLength(1);
  });

  it('保留字 DEFAULT → 拒绝（虚拟默认库位不可实体化）', async () => {
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.location.create', { locationCode: 'DEFAULT' }),
    ).rejects.toThrow(/保留字/);
    expect(countEvents()).toBe(before);
    expect(ws.locations.list()).toHaveLength(0);
  });

  it('空编码按编号规则生成', async () => {
    const created = (await ws.tools.invoke('wms.location.create', { locationCode: '' })) as { locationCode: string };
    expect(created.locationCode).toBe('LOC-0001');
  });
});

describe('库位更名（wms.location.update）', () => {
  it('改名成功：投影生效 + 事件落账 + 编码不变', async () => {
    const created = (await ws.tools.invoke('wms.location.create', {
      locationCode: 'A-01',
      name: '一号架',
    })) as { locationId: string };
    const before = countEvents();

    const r = (await ws.tools.invoke('wms.location.update', {
      locationCode: 'A-01',
      name: 'A 区 01 货架',
    })) as { locationId: string; locationCode: string; name: string };

    expect(r).toEqual({
      locationId: created.locationId,
      locationCode: 'A-01',
      name: 'A 区 01 货架',
    });
    expect(ws.locations.byCode('A-01')?.name).toBe('A 区 01 货架');
    // id 不变 = 历史单据/流水指向的桶不漂移
    expect(ws.locations.byCode('A-01')?.id).toBe(created.locationId);
    expect(countEvents()).toBe(before + 1);
  });

  it('重放幂等：同一事件应用两次结果不变（更名是 LWW）', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', name: '二号架' });

    // 取出更名事件，照重放器的路子对投影再应用两次：LWW 写死值，不叠加、不漂移
    const updated: EventEnvelope[] = [];
    ws.events.forEach((env) => {
      if (env.type === 'wms.location.updated') updated.push(env);
    });
    expect(updated).toHaveLength(1);
    ws.locations.applyEvent(updated[0]);
    ws.locations.applyEvent(updated[0]);
    expect(ws.locations.byCode('A-01')?.name).toBe('二号架');
    expect(ws.locations.list()).toHaveLength(1);
  });

  it('不传 name → 名称保持原样（只传要改的字段）', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
    const r = (await ws.tools.invoke('wms.location.update', { locationCode: 'A-01' })) as {
      name: string;
    };
    expect(r.name).toBe('一号架');
    expect(ws.locations.byCode('A-01')?.name).toBe('一号架');
  });

  it('空字符串 name → 拒绝（不改就别传）', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.location.update', { locationCode: 'A-01', name: '  ' }),
    ).rejects.toThrow(/不能为空/);
    expect(countEvents()).toBe(before);
  });

  it('不存在的库位 → LocationNotFoundError，零事件', async () => {
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.location.update', { locationCode: 'NOPE', name: 'x' }),
    ).rejects.toThrow(LocationNotFoundError);
    expect(countEvents()).toBe(before);
  });

  it('虚拟库位 DEFAULT 不可更名（它不落库）', async () => {
    await expect(
      ws.tools.invoke('wms.location.update', { locationCode: DEFAULT_LOCATION_ID, name: '默认' }),
    ).rejects.toThrow(LocationNotFoundError);
  });

  it('更名不影响已有库存桶（同 id 同桶）', async () => {
    await ws.tools.invoke('wms.location.create', { locationCode: 'A-01', name: '一号架' });
    await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 7,
      locationCode: 'A-01',
    });
    await ws.tools.invoke('wms.location.update', { locationCode: 'A-01', name: '二号架' });
    const loc = ws.locations.byCode('A-01')!;
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, loc.id)).toBe(7);
  });
});

describe('库位存在性守卫', () => {
  it('adjust 到未建库位 → LocationNotFoundError，零事件', async () => {
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.inventory.adjust', {
        skuCode: 'A-1',
        delta: 5,
        locationCode: 'A-01',
      }),
    ).rejects.toThrow(LocationNotFoundError);
    expect(countEvents()).toBe(before);
  });

  it('query 引用未建库位 → LocationNotFoundError', async () => {
    await expect(
      ws.tools.invoke('wms.inventory.query', { locationCode: 'A-01' }),
    ).rejects.toThrow(LocationNotFoundError);
  });

  it('单据行引用未建库位 → 拒绝且不建单', async () => {
    const before = countEvents();
    await expect(
      ws.tools.invoke('wms.order.create', {
        direction: 'in',
        lines: [{ skuCode: 'A-1', quantity: 5, locationCode: 'A-01' }],
      }),
    ).rejects.toThrow(LocationNotFoundError);
    expect(countEvents()).toBe(before);
    expect(ws.orders.list()).toHaveLength(0);
  });

  it('显式引用 DEFAULT 直通（虚拟桶，无需创建）', async () => {
    const r = (await ws.tools.invoke('wms.inventory.adjust', {
      skuCode: 'A-1',
      delta: 5,
      locationCode: DEFAULT_LOCATION_ID,
    })) as { locationCode: string; quantity: number };
    expect(r.locationCode).toBe('DEFAULT');
    expect(r.quantity).toBe(5);
    expect(ws.inventory.quantityOf(ws.skus.byCode('A-1')!.id, DEFAULT_LOCATION_ID)).toBe(5);
  });
});
