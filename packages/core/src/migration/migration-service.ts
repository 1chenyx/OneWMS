import { MigrationError } from '../errors.js';
import type { EventEnvelope } from '../oplog/envelope.js';
import type { OplogStore } from '../oplog/oplog-store.js';
import type { ProfileService } from '../profile/profile-service.js';

/** 迁移包标识与版本（导入端的结构校验位——防误投任意 JSON） */
export const MIGRATION_BUNDLE_KIND = 'onewms-migration-bundle';
export const MIGRATION_BUNDLE_VERSION = 1;

/**
 * 迁移包（DESIGN §1.1「配置包 + 事件重放」、§6.4 迁移闭环，里程碑 7）。
 *
 * v1 形态 = 全量事件包 + 重放：Profile 不单独打包（快照是事件投影，
 * 重放自动恢复；快照引导是 §8.6 部分副本的优化）。events 按账本全序
 * (lamport, actor) 排列——导入端幂等摄入后重放即可与源一致。
 */
export interface MigrationBundle {
  readonly kind: typeof MIGRATION_BUNDLE_KIND;
  readonly bundleVersion: typeof MIGRATION_BUNDLE_VERSION;
  /** 源节点身份（追溯用） */
  readonly nodeId: string;
  /** 工作区边界（迁移 = 同工作区搬家；跨工作区 = 跨密钥边界，导入拒绝） */
  readonly workspaceId: string;
  /** 导出时刻的 config 版本链值（元信息展示用，不参与校验——版本链在事件流里） */
  readonly profileVersion: number;
  readonly eventCount: number;
  readonly createdAt: string;
  /** 账本全量事件，按 (lamport, actor) 全序 */
  readonly events: EventEnvelope[];
}

/**
 * 迁移包编排（MigrationService，里程碑 7）。
 *
 * 「迁移和同步是同一个动作的两种节奏」（§8.5）：导出 = 账本全量照抄，
 * 导入 = 幂等摄入（eventId 查重，与同步 applyRemote 同一承诺）。
 * 依赖登记：→ oplog-store（全量读 + ingest）、→ profile-service（getVersion 元信息）。
 * 不做 manifest 在场性报告（宿主层组装——需要进程 manifest 目录）；
 * 不碰投影（导入后 replay 在宿主）；不加密（迁移包是本地可信域文件）。
 */
export class MigrationService {
  constructor(
    readonly nodeId: string,
    private readonly oplog: OplogStore,
    private readonly profile: ProfileService,
  ) {}

  /** 导出全量迁移包（events 按 (lamport, actor) 全序） */
  exportBundle(workspaceId: string): MigrationBundle {
    const events: EventEnvelope[] = [];
    this.oplog.forEachEvent(workspaceId, (env) => {
      events.push(env);
    });
    return {
      kind: MIGRATION_BUNDLE_KIND,
      bundleVersion: MIGRATION_BUNDLE_VERSION,
      nodeId: this.nodeId,
      workspaceId,
      profileVersion: this.profile.getVersion(workspaceId),
      eventCount: events.length,
      createdAt: new Date().toISOString(),
      events,
    };
  }

  /**
   * 导入迁移包：结构校验 → workspaceId 一致性 → 幂等摄入。
   * 重复导入零事件（eventId 查重）；投影重建在宿主（replayAll）。
   */
  importBundle(workspaceId: string, bundle: unknown): { accepted: number; skipped: number } {
    const b = bundle as Partial<MigrationBundle>;
    if (!b || b.kind !== MIGRATION_BUNDLE_KIND) {
      throw new MigrationError(`不是合法的迁移包（kind 应为 ${MIGRATION_BUNDLE_KIND}）`);
    }
    if (b.bundleVersion !== MIGRATION_BUNDLE_VERSION) {
      throw new MigrationError(`迁移包版本不支持：${String(b.bundleVersion)}（本节点支持 ${MIGRATION_BUNDLE_VERSION}）`);
    }
    if (typeof b.workspaceId !== 'string' || b.workspaceId !== workspaceId) {
      throw new MigrationError(
        `工作区不一致：包属 ${String(b.workspaceId)}，本节点为 ${workspaceId}（迁移 = 同工作区搬家；跨工作区 = 跨密钥边界）`,
      );
    }
    if (!Array.isArray(b.events)) {
      throw new MigrationError('迁移包 events 必须是数组');
    }
    for (const env of b.events) {
      const e = env as Partial<EventEnvelope>;
      if (
        typeof e.eventId !== 'string' ||
        typeof e.workspaceId !== 'string' ||
        typeof e.actor !== 'string' ||
        typeof e.type !== 'string' ||
        typeof e.lamport !== 'number' ||
        typeof e.seq !== 'number'
      ) {
        throw new MigrationError(`迁移包含非法事件信封: ${JSON.stringify(e).slice(0, 120)}`);
      }
      if (e.workspaceId !== workspaceId) {
        throw new MigrationError(`迁移包含跨工作区事件（期望 ${workspaceId}，实际 ${e.workspaceId}）`);
      }
    }
    return this.oplog.ingest(b.events as EventEnvelope[]);
  }
}
