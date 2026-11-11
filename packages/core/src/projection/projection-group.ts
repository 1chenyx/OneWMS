import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * 投影组元数据 —— 「组名 + 派生规则版本 + 本组拥有哪些表」的唯一登记处。
 *
 * 为什么要有这份清单：重建一组投影 = 清空本组的表 + 从 oplog 全量重放。
 * 原先「本组有哪些表」是散在 clear() 里的 N 条硬编码 DELETE（WMS 有 20 条），
 * 加一张投影表要同时改建表、清空，还得靠记性。漏一条的后果不是报错而是静默错账：
 * 重放时旧行还在，新行又插一遍，库存翻倍、单据重复。
 * 改成元数据清单后加表只改一处，而且能拿 sqlite_master 对着校验完整性（见 wms 侧测试）。
 *
 * 与版本戳的关系：`group` 就是 ensureProjectionVersion 的组维度
 * （meta key = `projection.<group>.<workspaceId>`）。**一组一个版本号**，
 * bump 只重建本组声明的表 —— 这是「新增一组投影不必拖累整个域重放」的地基。
 * 声明式模块的动态投影正是按这条规则各自成组（组名 `dyn.{moduleId}`）。
 */
export interface ProjectionGroupSpec {
  /** 组名：版本戳维度，也出现在「投影版本超前」的报错文案里。全库唯一 */
  readonly group: string;
  /**
   * 派生规则版本。改了本组任何派生语义就 +1（聚合口径、状态机投影结果、
   * 事件应用顺序…）；只加表、只加列、只改查询 → 不用动。
   */
  readonly codeVersion: number;
  /** 本组拥有的投影表，按「先子表后主表」排列 */
  readonly tables: readonly ProjectionTable[];
}

export interface ProjectionTable {
  readonly table: string;
  /**
   * 同表被多组共用时的组内切片。典型是动态记录表 `dyn_records`：物理上一张表，
   * 逻辑上按 `module_id` 一个模块一组，某个模块 bump 版本只清自己那几行。
   * 键必须是该表真实存在的列名。
   */
  readonly scope?: Readonly<Record<string, string | number>>;
}

/** SQL 标识符白名单：表名/列名要拼进语句，不能靠参数化占位，只能自己挡住畸形值 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(kind: string, value: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`投影组元数据里的${kind}不合法：${JSON.stringify(value)}`);
  }
}

/**
 * 清空一组投影表在指定工作区（及 scope 切片）下的全部行。
 *
 * 只删行、不删表：oplog 才是真相，投影是缓存，表结构由各域 migrate 期负责，
 * 删完重放自然填回来。
 *
 * **调用方必须自带事务** —— 各域的 replay() 都是 `db.transaction(...)` 包起来的。
 * 裸调会把「清了一半」的中间态留在库里。
 */
export function clearProjectionTables(
  db: SqliteDatabase,
  workspaceId: string,
  tables: readonly ProjectionTable[],
): void {
  for (const { table, scope } of tables) {
    assertIdentifier('表名', table);
    const scopeKeys = scope ? Object.keys(scope) : [];
    for (const key of scopeKeys) assertIdentifier('列名', key);
    const where = ['workspace_id = ?', ...scopeKeys.map((key) => `${key} = ?`)].join(' AND ');
    const params: (string | number)[] = [workspaceId, ...scopeKeys.map((key) => scope![key])];
    db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
  }
}
