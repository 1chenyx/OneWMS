import { randomUUID } from 'node:crypto';
import { EventError } from '../errors.js';

/**
 * 事件信封 —— 全系统唯一的事实载体（DESIGN.md §8.1）。
 *
 * 铁律（§13.4）：
 *  - 事件不可变：只有 INSERT，内核不提供任何 UPDATE/DELETE 事件 API；
 *  - 全程 UUID：eventId 为 uuid，业务主键亦禁用自增 int；
 *  - workspaceId 为信封显式字段（SaaS / 多工作区口子，§13.5）。
 */
export interface EventEnvelope {
  /** 全局唯一，uuid v4 —— 幂等重放的唯一键 */
  readonly eventId: string;
  /** 工作区（租户）边界，所有隔离的第一参数 */
  readonly workspaceId: string;
  /** 产生者：v1 为节点 id；语义开放，未来可升级为用户身份（§13.5 口子 3） */
  readonly actor: string;
  /** Lamport 逻辑时钟（跨节点因果序） */
  readonly lamport: number;
  /** 本节点内单调递增序号（事件按 actor 分通道拉取的依据） */
  readonly seq: number;
  /** 事件类型，命名空间格式：`领域.实体.动作`（过去时，事实而非命令） */
  readonly type: string;
  /** 业务载荷（JSON 序列化存储；同步传输时为 E2E 密文） */
  readonly payload: unknown;
  /** 产生时间（ISO 8601） */
  readonly createdAt: string;
}

/** 信封的可序列化形态（payload 为 JSON 字符串） */
export interface EventRow {
  event_id: string;
  workspace_id: string;
  actor: string;
  lamport: number;
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}

export function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    actor: row.actor,
    lamport: row.lamport,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

/**
 * 构造一条本地事件信封（seq/lamport 由 OplogStore 在事务内分配后传入）。
 */
export function buildEnvelope(params: {
  workspaceId: string;
  actor: string;
  seq: number;
  lamport: number;
  type: string;
  payload: unknown;
}): EventEnvelope {
  if (!params.type || !params.type.includes('.')) {
    throw new EventError(`事件类型必须带命名空间（领域.实体.动作）: "${params.type}"`);
  }
  return {
    eventId: randomUUID(),
    workspaceId: params.workspaceId,
    actor: params.actor,
    lamport: params.lamport,
    seq: params.seq,
    type: params.type,
    payload: params.payload,
    createdAt: new Date().toISOString(),
  };
}
