import type { DynListOptions, DynStore, DynStoredRecord } from '../dyn/dyn-store.js';

/**
 * 动态记录存储的工作区绑定视图（DynView，B.2）。
 *
 * 与其他 View 同纪律：构造期绑定 workspaceId，调用方不再传；
 * actor 缺省为本节点（多节点同步下 actor 通道由后缀天然区分）。
 * B.3 的 HTTP 端点与 B.4 的 AI 工具都从这里读写——存储层只认 manifest 白名单，
 * 端点层的路由/分页文法是另一回事。
 */
export class DynView {
  constructor(
    private readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly store: DynStore,
  ) {}

  /** 创建记录（recordId 缺省自动生成） */
  create(
    recordType: string,
    recordId: string | undefined,
    data: unknown,
    opts?: { actor?: string },
  ): { recordId: string; version: number } {
    return this.store.create(this.workspaceId, recordType, recordId, data, {
      actor: opts?.actor ?? this.nodeId,
    });
  }

  /** 整替更新（乐观并发：expectedVersion 必须等于读取时的 version） */
  update(
    recordType: string,
    recordId: string,
    data: unknown,
    expectedVersion: number,
    opts?: { actor?: string },
  ): { version: number } {
    return this.store.update(this.workspaceId, recordType, recordId, data, expectedVersion, {
      actor: opts?.actor ?? this.nodeId,
    });
  }

  /** 删除（乐观并发同 update） */
  delete(recordType: string, recordId: string, expectedVersion: number, opts?: { actor?: string }): void {
    this.store.delete(this.workspaceId, recordType, recordId, expectedVersion, {
      actor: opts?.actor ?? this.nodeId,
    });
  }

  get(recordType: string, recordId: string): DynStoredRecord | undefined {
    return this.store.get(this.workspaceId, recordType, recordId);
  }

  list(recordType: string, opts?: DynListOptions): { rows: DynStoredRecord[]; total: number } {
    return this.store.list(this.workspaceId, recordType, opts ?? {});
  }
}
