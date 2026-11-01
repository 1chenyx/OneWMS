import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OneCore } from '@one/core';
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

  it('空编码 → 拒绝', async () => {
    await expect(
      ws.tools.invoke('wms.location.create', { locationCode: '' }),
    ).rejects.toThrow(/不能为空/);
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
