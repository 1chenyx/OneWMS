import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearProjectionTables, OneCore, type ProjectionTable } from '../src/index.js';

/**
 * clearProjectionTables —— 整组清理按元数据清单驱动（EXTENSIBILITY B.0）。
 *
 * 要盯住的三件事：
 *  1. 只清本工作区（多工作区同库是既定形态，串号 = 数据事故）；
 *  2. scope 能把一张共用表切成多组（动态记录表按 module_id 分组的前提）；
 *  3. 表名/列名要拼进 SQL，畸形值必须挡住——参数化占位保护不了标识符。
 */

describe('clearProjectionTables', () => {
  let core: OneCore;
  beforeEach(() => {
    core = OneCore.open(':memory:');
    const db = core.exposeDb();
    db.exec(`
      CREATE TABLE t_parent (workspace_id TEXT NOT NULL, id TEXT NOT NULL);
      CREATE TABLE t_child (workspace_id TEXT NOT NULL, parent_id TEXT NOT NULL);
      CREATE TABLE t_shared (workspace_id TEXT NOT NULL, module_id TEXT NOT NULL, id TEXT NOT NULL);
    `);
    const ins = db.prepare('INSERT INTO t_parent (workspace_id, id) VALUES (?, ?)');
    ins.run('ws-a', 'p1');
    ins.run('ws-b', 'p2');
    const insc = db.prepare('INSERT INTO t_child (workspace_id, parent_id) VALUES (?, ?)');
    insc.run('ws-a', 'p1');
    insc.run('ws-b', 'p2');
    const inss = db.prepare('INSERT INTO t_shared (workspace_id, module_id, id) VALUES (?, ?, ?)');
    inss.run('ws-a', 'mod.x', 'r1');
    inss.run('ws-a', 'mod.y', 'r2');
    inss.run('ws-b', 'mod.x', 'r3');
  });
  afterEach(() => core.close());

  const count = (table: string, where = '1=1') =>
    (core.exposeDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

  it('一次调用清空清单里的全部表，且只清本工作区', () => {
    const tables: ProjectionTable[] = [{ table: 't_child' }, { table: 't_parent' }];
    clearProjectionTables(core.exposeDb(), 'ws-a', tables);

    expect(count('t_parent')).toBe(1); // ws-b 那行还在
    expect(count('t_child')).toBe(1);
    expect(count('t_parent', `workspace_id = 'ws-b'`)).toBe(1);
  });

  it('scope 把共用表切成多组：只清自己那一片，同库其他组不受影响', () => {
    clearProjectionTables(core.exposeDb(), 'ws-a', [{ table: 't_shared', scope: { module_id: 'mod.x' } }]);

    expect(count('t_shared')).toBe(2); // ws-a/mod.y 与 ws-b/mod.x 都还在
    expect(count('t_shared', `workspace_id = 'ws-a' AND module_id = 'mod.x'`)).toBe(0);
    expect(count('t_shared', `workspace_id = 'ws-a' AND module_id = 'mod.y'`)).toBe(1);
    expect(count('t_shared', `workspace_id = 'ws-b'`)).toBe(1);
  });

  it('空清单是空操作（新组还没表时不该炸）', () => {
    expect(() => clearProjectionTables(core.exposeDb(), 'ws-a', [])).not.toThrow();
    expect(count('t_parent')).toBe(2);
  });

  it.each([
    ['表名带引号', [{ table: 't_parent; DROP TABLE t_child' }]],
    ['表名带空格', [{ table: 't parent' }]],
    ['列名带引号', [{ table: 't_shared', scope: { 'module_id = ? OR 1': 'x' } }]],
  ])('畸形标识符直接拒绝：%s', (_label, tables) => {
    expect(() => clearProjectionTables(core.exposeDb(), 'ws-a', tables as ProjectionTable[])).toThrow(/不合法/);
    expect(count('t_parent')).toBe(2);
    expect(count('t_child')).toBe(2);
  });
});
