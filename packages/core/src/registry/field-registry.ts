import type { Database as SqliteDatabase } from 'better-sqlite3';
import { FieldConflictError, FieldNotFoundError } from '../errors.js';
import type { EventEnvelope } from '../oplog/envelope.js';
import type { OplogStore } from '../oplog/oplog-store.js';
import { qualifyKey, type FieldSharing } from './key-naming.js';

/**
 * 全局字段注册表（FieldRegistry，DESIGN.md §7.1）。
 *
 * 核心不变量：
 *  - 字段属于实体，不属于模块：owner 创建、usedBy 共享；
 *  - 本注册表是事件投影：所有变更先落 `registry.*` 事件再应用，
 *    因此「重放全部事件 = 完整重建注册表」（§8 唯一真相纪律）；
 *  - 软删除：visible=false，永不物理删除（卸载模块不丢用户数据）；
 *  - private 字段自动加模块前缀，从机制上消除无意撞名（§7.2，规则与
 *    FieldSharing 定义见 key-naming.ts——依赖方向：本文件向下引用基础层）。
 */
export type FieldDataType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface FieldDefinition {
  entity: string;
  /** 模块声明中的原始 key（存储与引用一律使用 qualifiedKey） */
  key: string;
  label: string;
  dataType: FieldDataType;
  sharing: FieldSharing;
  description?: string;
}

export interface RegisteredField {
  entity: string;
  /** 实际存储键：private 字段带模块前缀（promo__note），shared 字段为原始 key */
  qualifiedKey: string;
  label: string;
  dataType: FieldDataType;
  sharing: FieldSharing;
  owner: string;
  visible: boolean;
  usedBy: string[];
  description?: string;
  createdAt: string;
}

export interface UnregisterReport {
  moduleId: string;
  /** 本模块作为 usage 被移出的字段 */
  releasedUsages: { entity: string; qualifiedKey: string }[];
  /** 本模块作为 owner 的字段的处置结果 */
  ownedFields: {
    entity: string;
    qualifiedKey: string;
    resolution: 'transferred' | 'hidden';
    newOwner?: string;
  }[];
}

interface FieldRow {
  workspace_id: string;
  entity: string;
  field_key: string;
  label: string;
  data_type: string;
  visible: number;
  sharing: string;
  owner: string;
  description: string | null;
  created_at: string;
}

export class FieldRegistry {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly oplog: OplogStore,
  ) {}

  /**
   * 提供字段（模块 provides，§6 manifest）。
   * 不存在 → 创建并成为 owner；已存在且类型兼容 → 加入 usedBy；类型冲突 → 拒绝。
   * opts.actor：事件 actor 覆盖（缺省 `module:providedBy`）——种子场景传
   * `module:xxx@nodeId` 使通道节点唯一（M5 同步的账本唯一约束要求，§8.5）。
   */
  provide(
    workspaceId: string,
    providedBy: string,
    def: FieldDefinition,
    opts?: { actor?: string },
  ): RegisteredField {
    const qualifiedKey = qualifyKey(providedBy, def.key, def.sharing);
    const existing = this.#getRow(workspaceId, def.entity, qualifiedKey);

    if (existing && existing.data_type !== def.dataType) {
      throw new FieldConflictError(
        `字段 ${def.entity}.${qualifiedKey} 已存在（owner: ${existing.owner}，` +
          `类型 ${existing.data_type}），与 ${providedBy} 声明的类型 ${def.dataType} 不兼容`,
      );
    }

    // 命令侧校验通过 → 落事件（唯一真相）→ 立即应用投影（命令路径与重放共用 applyEvent）
    const provided = this.oplog.append({
      workspaceId,
      actor: opts?.actor ?? `module:${providedBy}`,
      type: 'registry.field.provided',
      payload: {
        providedBy,
        entity: def.entity,
        key: def.key,
        qualifiedKey,
        label: def.label,
        dataType: def.dataType,
        sharing: def.sharing,
        description: def.description ?? null,
      },
    });
    this.applyEvent(provided);

    const field = this.getField(workspaceId, def.entity, qualifiedKey);
    if (!field) throw new FieldNotFoundError(`事件应用后字段仍不存在: ${qualifiedKey}`);
    return field;
  }

  /**
   * 声明依赖（模块 requires，§6 manifest）。
   * 字段必须已存在且类型兼容——这是安装期冲突检测的执行点（§7.2）。
   * opts.actor：事件 actor 覆盖（与 provide 同——M5 同步的账本唯一约束要求
   * 落账 actor 通道节点唯一，模块系统安装时传 `module:xxx@nodeId`）。
   */
  require(
    workspaceId: string,
    requiredBy: string,
    spec: { entity: string; key: string; sharing?: FieldSharing; expectType?: FieldDataType },
    opts?: { actor?: string },
  ): RegisteredField {
    const sharing = spec.sharing ?? 'shared';
    const qualifiedKey = qualifyKey(requiredBy, spec.key, sharing);
    const field = this.getField(workspaceId, spec.entity, qualifiedKey);

    if (!field) {
      throw new FieldNotFoundError(
        `模块 ${requiredBy} 依赖的字段 ${spec.entity}.${qualifiedKey} 未注册` +
          `（需先安装提供它的模块）`,
      );
    }
    if (spec.expectType && field.dataType !== spec.expectType) {
      throw new FieldConflictError(
        `字段 ${spec.entity}.${qualifiedKey} 类型为 ${field.dataType}，` +
          `与 ${requiredBy} 期望的 ${spec.expectType} 不兼容`,
      );
    }

    const required = this.oplog.append({
      workspaceId,
      actor: opts?.actor ?? `module:${requiredBy}`,
      type: 'registry.field.required',
      payload: { requiredBy, entity: spec.entity, qualifiedKey },
    });
    this.applyEvent(required);

    return this.getField(workspaceId, spec.entity, qualifiedKey)!;
  }

  /** 软删除/恢复可见性（AI 改配置、用户个性化的落点之一） */
  setVisibility(workspaceId: string, by: string, entity: string, qualifiedKey: string, visible: boolean): void {
    const field = this.getField(workspaceId, entity, qualifiedKey);
    if (!field) throw new FieldNotFoundError(`字段不存在: ${entity}.${qualifiedKey}`);

    const changed = this.oplog.append({
      workspaceId,
      actor: by,
      type: 'registry.field.visibility_changed',
      payload: { entity, qualifiedKey, visible, by },
    });
    this.applyEvent(changed);
  }

  /**
   * 卸载模块（§7.2 卸载语义）：
   *  - 非 owner：仅移出 usedBy；
   *  - owner 且仍有使用者：所有权移交给第一个使用者；
   *  - owner 且无使用者：软删除（visible=false），数据永不丢失。
   */
  unregisterModule(workspaceId: string, moduleId: string): UnregisterReport {
    // 报告必须在应用事件之前收集（应用后 owner 可能已被移交）
    const usageRows = this.db
      .prepare<unknown[], { entity: string; field_key: string }>(
        `SELECT entity, field_key FROM field_usage
         WHERE workspace_id = ? AND used_by = ?`,
      )
      .all(workspaceId, moduleId);
    const ownedRows = this.db
      .prepare<unknown[], { entity: string; field_key: string }>(
        `SELECT entity, field_key FROM field_registry
         WHERE workspace_id = ? AND owner = ?`,
      )
      .all(workspaceId, moduleId);

    const ownedFields: UnregisterReport['ownedFields'] = ownedRows.map((r) => {
      // 与 #applyUnregister 的选择规则一致：排除本模块后按字典序取第一位
      const nextOwner = this.db
        .prepare<unknown[], { used_by: string }>(
          `SELECT used_by FROM field_usage
           WHERE workspace_id = ? AND entity = ? AND field_key = ? AND used_by != ?
           ORDER BY used_by ASC LIMIT 1`,
        )
        .get(workspaceId, r.entity, r.field_key, moduleId);
      return nextOwner
        ? {
            entity: r.entity,
            qualifiedKey: r.field_key,
            resolution: 'transferred' as const,
            newOwner: nextOwner.used_by,
          }
        : { entity: r.entity, qualifiedKey: r.field_key, resolution: 'hidden' as const };
    });

    const unregistered = this.oplog.append({
      workspaceId,
      actor: `module:${moduleId}`,
      type: 'registry.module.unregistered',
      payload: { moduleId },
    });
    this.applyEvent(unregistered);

    return {
      moduleId,
      releasedUsages: usageRows.map((r) => ({ entity: r.entity, qualifiedKey: r.field_key })),
      ownedFields,
    };
  }

  listFields(workspaceId: string, entity?: string): RegisteredField[] {
    const rows = this.#allRows(workspaceId, entity);
    return rows.map((r) => this.#toField(workspaceId, r)).filter((f): f is RegisteredField => !!f);
  }

  getField(workspaceId: string, entity: string, qualifiedKey: string): RegisteredField | undefined {
    const row = this.#getRow(workspaceId, entity, qualifiedKey);
    return row ? this.#toField(workspaceId, row) : undefined;
  }

  // ─────────────────────────────────────────────────────────────
  // 事件投影：重放器与命令路径共用的唯一应用逻辑（§8 唯一真相）
  // ─────────────────────────────────────────────────────────────

  /** 将一条 registry.* 事件应用到注册表投影（重放/同步摄入时调用） */
  applyEvent(envelope: EventEnvelope): void {
    const p = envelope.payload as Record<string, unknown>;
    const ws = envelope.workspaceId;
    switch (envelope.type) {
      case 'registry.field.provided': {
        const entity = p.entity as string;
        const qualifiedKey = p.qualifiedKey as string;
        this.db
          .prepare(
            `INSERT INTO field_registry
               (workspace_id, entity, field_key, label, data_type, visible, sharing, owner, description, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT (workspace_id, entity, field_key) DO NOTHING`,
          )
          .run(
            ws,
            entity,
            qualifiedKey,
            p.label,
            p.dataType,
            p.sharing,
            p.providedBy,
            p.description ?? null,
            envelope.createdAt,
          );
        this.#addUsage(ws, entity, qualifiedKey, p.providedBy as string);
        return;
      }
      case 'registry.field.required': {
        this.#addUsage(ws, p.entity as string, p.qualifiedKey as string, p.requiredBy as string);
        return;
      }
      case 'registry.field.visibility_changed': {
        this.db
          .prepare(
            `UPDATE field_registry SET visible = ?
             WHERE workspace_id = ? AND entity = ? AND field_key = ?`,
          )
          .run(p.visible ? 1 : 0, ws, p.entity, p.qualifiedKey);
        return;
      }
      case 'registry.module.unregistered': {
        this.#applyUnregister(ws, p.moduleId as string);
        return;
      }
      default:
        return; // 非注册表事件，安全忽略
    }
  }

  #applyUnregister(workspaceId: string, moduleId: string): void {
    // 1. 移出该模块的所有 usage
    this.db
      .prepare(`DELETE FROM field_usage WHERE workspace_id = ? AND used_by = ?`)
      .run(workspaceId, moduleId);

    // 2. 处置其拥有的字段
    const owned = this.db
      .prepare<unknown[], { entity: string; field_key: string }>(
        `SELECT entity, field_key FROM field_registry
         WHERE workspace_id = ? AND owner = ?`,
      )
      .all(workspaceId, moduleId);

    for (const f of owned) {
      const nextOwner = this.db
        .prepare<unknown[], { used_by: string }>(
          `SELECT used_by FROM field_usage
           WHERE workspace_id = ? AND entity = ? AND field_key = ?
           ORDER BY used_by ASC LIMIT 1`,
        )
        .get(workspaceId, f.entity, f.field_key);

      if (nextOwner) {
        // 所有权移交（§7.2：字段保留，跟随下一位使用者）
        this.db
          .prepare(
            `UPDATE field_registry SET owner = ?
             WHERE workspace_id = ? AND entity = ? AND field_key = ?`,
          )
          .run(nextOwner.used_by, workspaceId, f.entity, f.field_key);
      } else {
        // 无人使用 → 软删除（数据永不丢，§7.2 卸载语义）
        this.db
          .prepare(
            `UPDATE field_registry SET visible = 0
             WHERE workspace_id = ? AND entity = ? AND field_key = ?`,
          )
          .run(workspaceId, f.entity, f.field_key);
      }
    }
  }

  #addUsage(workspaceId: string, entity: string, qualifiedKey: string, usedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO field_usage (workspace_id, entity, field_key, used_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(workspaceId, entity, qualifiedKey, usedBy);
  }

  #getRow(workspaceId: string, entity: string, qualifiedKey: string): FieldRow | undefined {
    return this.db
      .prepare<unknown[], FieldRow>(
        `SELECT * FROM field_registry
         WHERE workspace_id = ? AND entity = ? AND field_key = ?`,
      )
      .get(workspaceId, entity, qualifiedKey);
  }

  #allRows(workspaceId: string, entity?: string): FieldRow[] {
    return entity
      ? this.db
          .prepare<unknown[], FieldRow>(
            `SELECT * FROM field_registry
             WHERE workspace_id = ? AND entity = ? ORDER BY field_key`,
          )
          .all(workspaceId, entity)
      : this.db
          .prepare<unknown[], FieldRow>(
            `SELECT * FROM field_registry
             WHERE workspace_id = ? ORDER BY entity, field_key`,
          )
          .all(workspaceId);
  }

  #toField(workspaceId: string, row: FieldRow): RegisteredField | undefined {
    const usedBy = this.db
      .prepare<unknown[], { used_by: string }>(
        `SELECT used_by FROM field_usage
         WHERE workspace_id = ? AND entity = ? AND field_key = ? ORDER BY used_by`,
      )
      .all(workspaceId, row.entity, row.field_key)
      .map((r) => r.used_by);
    return {
      entity: row.entity,
      qualifiedKey: row.field_key,
      label: row.label,
      dataType: row.data_type as FieldDataType,
      sharing: row.sharing as FieldSharing,
      owner: row.owner,
      visible: row.visible === 1,
      usedBy,
      description: row.description ?? undefined,
      createdAt: row.created_at,
    };
  }
}
