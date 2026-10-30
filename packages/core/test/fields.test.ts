import { describe, it, expect, beforeEach } from 'vitest';
import { OneCore, FieldConflictError, FieldNotFoundError } from '../src/index.js';

let core: OneCore;
let ws: ReturnType<OneCore['workspace']>;

beforeEach(() => {
  core = OneCore.open(':memory:');
  ws = core.workspace('ws-test');
});

describe('字段注册表：provide / require', () => {
  it('首次 provide 创建字段并成为 owner + 使用者', () => {
    const field = ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
      description: '用于计算剩余有效天数',
    });

    expect(field.qualifiedKey).toBe('expiry_date');
    expect(field.owner).toBe('module.expiry');
    expect(field.usedBy).toEqual(['module.expiry']);
    expect(field.visible).toBe(true);
  });

  it('类型兼容的二次 provide → 共享（owner 不变，usedBy 追加）', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    const field = ws.fields.provide('module.fifo', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });

    expect(field.owner).toBe('module.expiry'); // 先到先得
    expect(field.usedBy).toEqual(['module.expiry', 'module.fifo']);
  });

  it('类型冲突 → FieldConflictError（安装期硬拒绝，§7.2）', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });

    expect(() =>
      ws.fields.provide('module.bad', {
        entity: 'batch',
        key: 'expiry_date',
        label: '到期日期',
        dataType: 'string',
        sharing: 'shared',
      }),
    ).toThrow(FieldConflictError);
  });

  it('private 字段自动加模块前缀——两个模块的同名私有字段互不撞车（§7.2 决策）', () => {
    const a = ws.fields.provide('module.promo', {
      entity: 'sku',
      key: 'note',
      label: '促销备注',
      dataType: 'string',
      sharing: 'private',
    });
    const b = ws.fields.provide('module.expiry', {
      entity: 'sku',
      key: 'note',
      label: '效期备注',
      dataType: 'string',
      sharing: 'private',
    });

    expect(a.qualifiedKey).toBe('promo__note');
    expect(b.qualifiedKey).toBe('expiry__note');
    expect(ws.fields.list('sku')).toHaveLength(2);
  });

  it('require：字段缺失 → FieldNotFoundError；类型不符 → 冲突', () => {
    expect(() =>
      ws.fields.require('module.fifo', { entity: 'batch', key: 'expiry_date' }),
    ).toThrow(FieldNotFoundError);

    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });

    expect(() =>
      ws.fields.require('module.fifo', {
        entity: 'batch',
        key: 'expiry_date',
        expectType: 'string',
      }),
    ).toThrow(FieldConflictError);

    const ok = ws.fields.require('module.fifo', {
      entity: 'batch',
      key: 'expiry_date',
      expectType: 'date',
    });
    expect(ok.usedBy).toContain('module.fifo');
  });

  it('工作区隔离：字段互不可见', () => {
    const other = core.workspace('ws-other');
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    expect(ws.fields.list('batch')).toHaveLength(1);
    expect(other.fields.list('batch')).toHaveLength(0);
  });
});

describe('字段注册表：可见性与卸载语义（§7.2）', () => {
  it('setVisibility 是软删除——字段与数据永不在册面上消失', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    ws.fields.setVisibility('user:alice', 'batch', 'expiry_date', false);

    const field = ws.fields.get('batch', 'expiry_date');
    expect(field?.visible).toBe(false);
    expect(field).toBeDefined(); // 仍在注册表
  });

  it('卸载 owner 且仍有使用者 → 所有权移交（数据不丢）', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    ws.fields.require('module.fifo', { entity: 'batch', key: 'expiry_date' });

    const report = ws.fields.unregisterModule('module.expiry');

    expect(report.ownedFields[0]).toEqual({
      entity: 'batch',
      qualifiedKey: 'expiry_date',
      resolution: 'transferred',
      newOwner: 'module.fifo',
    });
    const field = ws.fields.get('batch', 'expiry_date');
    expect(field?.owner).toBe('module.fifo');
    expect(field?.visible).toBe(true);
  });

  it('卸载 owner 且无使用者 → 软删除（visible=false，行保留）', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });

    const report = ws.fields.unregisterModule('module.expiry');

    expect(report.ownedFields[0]?.resolution).toBe('hidden');
    const field = ws.fields.get('batch', 'expiry_date');
    expect(field).toBeDefined();
    expect(field?.visible).toBe(false);
    expect(field?.usedBy).toEqual([]);
  });

  it('卸载非 owner 模块 → 仅移出 usedBy', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    ws.fields.require('module.fifo', { entity: 'batch', key: 'expiry_date' });

    ws.fields.unregisterModule('module.fifo');

    const field = ws.fields.get('batch', 'expiry_date');
    expect(field?.owner).toBe('module.expiry');
    expect(field?.usedBy).toEqual(['module.expiry']);
  });
});

describe('注册表是事件投影（§8 唯一真相）', () => {
  it('每次 provide/require/visibility/unregister 都落 registry.* 事件', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    ws.fields.require('module.fifo', { entity: 'batch', key: 'expiry_date' });
    ws.fields.setVisibility('user:alice', 'batch', 'expiry_date', false);
    ws.fields.unregisterModule('module.expiry');

    const types: string[] = [];
    ws.events.forEach((e) => types.push(e.type));
    expect(types).toEqual([
      'registry.field.provided',
      'registry.field.required',
      'registry.field.visibility_changed',
      'registry.module.unregistered',
    ]);
  });

  it('replay() 清空投影后按事件全量重建——注册表与账本强一致', () => {
    ws.fields.provide('module.expiry', {
      entity: 'batch',
      key: 'expiry_date',
      label: '到期日期',
      dataType: 'date',
      sharing: 'shared',
    });
    ws.fields.require('module.fifo', { entity: 'batch', key: 'expiry_date' });
    ws.fields.setVisibility('user:alice', 'batch', 'expiry_date', false);
    ws.fields.provide('module.promo', {
      entity: 'sku',
      key: 'note',
      label: '促销备注',
      dataType: 'string',
      sharing: 'private',
    });

    const result = ws.replay();
    expect(result.totalEvents).toBe(4);
    expect(result.appliedRegistryEvents).toBe(4);

    const field = ws.fields.get('batch', 'expiry_date');
    expect(field?.owner).toBe('module.expiry');
    expect(field?.usedBy).toEqual(['module.expiry', 'module.fifo']);
    expect(field?.visible).toBe(false);
    expect(ws.fields.get('sku', 'promo__note')).toBeDefined();
  });
});
