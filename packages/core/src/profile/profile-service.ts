import type { Database as SqliteDatabase } from 'better-sqlite3';
import { ProfileValidationError, StaleProposalError } from '../errors.js';
import type { EventEnvelope } from '../oplog/envelope.js';
import type { OplogStore } from '../oplog/oplog-store.js';
import type { FieldRegistry, RegisteredField } from '../registry/field-registry.js';
import { applyPatch, parsePointer } from './patch.js';
import { buildImpactReport, type ImpactReport } from './impact.js';
import { ProposalStore, type Proposal, type ProposalSummary } from './proposal-store.js';
import { emptyConfigState, type ConfigState, type ModuleConfig, type PatchOp, type ProfileSnapshot, type WorkflowDef } from './profile-types.js';
import { validatePatch } from './validate.js';

/**
 * Profile 管线服务（DESIGN.md §5/§9.1，里程碑 4 慢通道的编排核心）。
 *
 * 真相源分治（ARCHITECTURE.md「慢通道管线」）：
 *  - 字段元数据（含 visible）的真相是 registry.* 事件（FieldRegistry 命令）；
 *  - workflows/modules/roles 的真相是 config.change 事件（本服务落账并投影）；
 *  - Profile 快照 = 聚合投影，不存第二份真相。
 *
 * 热应用双轨（顺序固定，确定性铁律）：
 *  轨道 A：/schema/** 操作 → 翻译成注册表命令（provide / setVisibility）；
 *  轨道 B：其余操作 → applyPatch 后落一条 config.change（profileVersion 严格 +1）。
 */
export const CONFIG_EVENT_TYPE = 'config.change';

interface ProfileStateRow {
  workspace_id: string;
  version: number;
  workflows: string;
  modules: string;
  roles: string;
}

export class ProfileService {
  /** 每工作区追账游标（已应用的 lamport 高水位；-1 = 从头） */
  readonly #proposals: ProposalStore;
  #cursors = new Map<string, number>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly oplog: OplogStore,
    private readonly registry: FieldRegistry,
    proposals?: ProposalStore,
  ) {
    this.#proposals = proposals ?? new ProposalStore();
  }

  // ── 追账（投影是缓存，事件是真相）─────────────────────

  /**
   * 增量应用游标之后的 config.change 事件到 profile_state 投影。
   * 所有读/写入口先行调用——ingest 远端事件后自愈（与 WmsWorkspace 同模式）。
   * 注：游标为 lamport 单值，(lamport, actor) 同值多事件的边界由 M5 同步协议统一处理。
   */
  sync(workspaceId: string): { applied: number } {
    let applied = 0;
    const run = this.db.transaction(() => {
      this.oplog.forEachEvent(
        workspaceId,
        (env) => {
          if (env.type === CONFIG_EVENT_TYPE) {
            this.#applyConfigChange(env);
            applied++;
          }
          this.#cursors.set(workspaceId, env.lamport);
        },
        { fromLamport: this.#cursors.get(workspaceId) ?? -1 },
      );
    });
    run();
    return { applied };
  }

  /** 将一条事件应用到投影（WorkspaceFacade.replay 全量重放时喂入；只认 config.change） */
  applyEvent(envelope: EventEnvelope): void {
    if (envelope.type === CONFIG_EVENT_TYPE) {
      this.#applyConfigChange(envelope);
    }
  }

  /** 清空某工作区的 config 投影并复位游标（replay 第一步） */
  clearProjection(workspaceId: string): void {
    this.db.prepare(`DELETE FROM profile_state WHERE workspace_id = ?`).run(workspaceId);
    this.#cursors.set(workspaceId, -1);
  }

  // ── 快照（聚合投影）────────────────────────────────────

  /** 当前 config 版本（同步握手比较位，§8.5 ②）：先追账再读，不聚合全快照 */
  getVersion(workspaceId: string): number {
    this.sync(workspaceId);
    return this.#row(workspaceId)?.version ?? 0;
  }

  /** 聚合快照：schema.entities 实时读注册表，config 部分读 profile_state */
  getSnapshot(workspaceId: string): ProfileSnapshot {
    this.sync(workspaceId);
    const row = this.#row(workspaceId);
    const config = row ? this.#parseRow(row) : emptyConfigState();
    const version = row?.version ?? 0;

    const entities: ProfileSnapshot['schema']['entities'] = {};
    for (const f of this.registry.listFields(workspaceId)) {
      const slot = entities[f.entity] ?? (entities[f.entity] = { extensions: [] });
      slot.extensions.push({
        key: f.qualifiedKey,
        label: f.label,
        type: f.dataType,
        visible: f.visible,
        providedBy: f.owner,
      });
    }
    return { workspaceId, version, schema: { entities }, ...config };
  }

  // ── 慢通道三段式：提议 → 确认 → 热应用 ─────────────────

  /**
   * 提议（AI / 任何调用方）：校验三关 → 影响报告 → 登记 pending 提议。
   * 不落任何事件——「提议不是事实」。校验失败抛 ProfileValidationError（含完整问题清单）。
   */
  propose(
    workspaceId: string,
    proposedBy: string,
    patch: PatchOp[],
    note?: string,
  ): { proposalId: string; report: ImpactReport } {
    const snapshot = this.getSnapshot(workspaceId);
    const { errors, warnings, candidate } = validatePatch(snapshot, patch);
    if (errors.length > 0) {
      throw new ProfileValidationError(
        `配置 patch 校验未通过（${errors.length} 项）：\n` + errors.map((e) => `- ${e.message}`).join('\n'),
      );
    }
    const report = buildImpactReport(snapshot, candidate, warnings);
    const proposal = this.#proposals.create({
      workspaceId,
      proposedBy,
      note,
      patch,
      baseVersion: snapshot.version,
      baseFieldFingerprint: this.#fieldFingerprint(workspaceId, patch),
      report,
    });
    return { proposalId: proposal.proposalId, report };
  }

  /**
   * 人工确认 → 热应用（confirm/reject 永不注册为 AI 工具，§4.1 确认权在人类）。
   * 新鲜度检查：propose 之后配置若已变化（版本或涉及字段指纹），提议过期拒绝——
   * 保证「确认界面看到的 diff = 实际应用的变更」（§7.3 报告所见即应用所得）。
   */
  confirm(workspaceId: string, by: string, proposalId: string): { newVersion: number; appliedOps: number } {
    const proposal = this.#proposals.get(proposalId, workspaceId);

    const snapshot = this.getSnapshot(workspaceId);
    if (
      snapshot.version !== proposal.baseVersion ||
      this.#fieldFingerprint(workspaceId, proposal.patch) !== proposal.baseFieldFingerprint
    ) {
      throw new StaleProposalError(
        '提议生成后配置已发生变化，影响报告与现状不一致——请让 AI 重新提议',
      );
    }
    // 应用时刻重跑校验（双保险：此刻的护栏，理论上不会失败）
    const { errors } = validatePatch(snapshot, proposal.patch);
    if (errors.length > 0) {
      throw new ProfileValidationError(`应用时刻校验未通过：\n` + errors.map((e) => `- ${e.message}`).join('\n'));
    }

    // 轨道 A：/schema/** → 注册表命令（先于轨道 B，顺序固定）
    for (const op of proposal.patch) {
      const seg = parsePointer(op.path);
      if (seg[0] !== 'schema') continue;
      const entity = seg[2];
      if (op.op === 'add') {
        const v = op.value as { key: string; label: string; type: ProfileSnapshot['schema']['entities'][string]['extensions'][number]['type']; providedBy: string; visible?: boolean };
        this.registry.provide(workspaceId, v.providedBy, {
          entity,
          key: v.key,
          label: v.label,
          dataType: v.type,
          sharing: 'shared',
        });
        if (v.visible === false) {
          this.registry.setVisibility(workspaceId, by, entity, v.key, false);
        }
      } else if (op.op === 'replace') {
        const fields = this.registry.listFields(workspaceId, entity);
        const target = fields[Number(seg[4])];
        if (target) {
          this.registry.setVisibility(workspaceId, by, entity, target.qualifiedKey, op.value as boolean);
        }
      }
    }

    // 轨道 B：/workflows/** /modules/** /roles/** → 一条 config.change（version+1）
    const opsB = proposal.patch.filter((op) => !op.path.startsWith('/schema/'));
    let newVersion = snapshot.version;
    if (opsB.length > 0) {
      const state = this.#configState(workspaceId);
      applyPatch(state, opsB); // 先行验证可应用（失败则抛错，尚未落任何事件）
      newVersion = snapshot.version + 1;
      const env = this.oplog.append({
        workspaceId,
        actor: by,
        type: CONFIG_EVENT_TYPE,
        payload: {
          patch: opsB,
          profileVersion: newVersion,
          proposalId,
          summary: proposal.report.summary,
        },
      });
      this.#applyConfigChange(env); // 命令路径立即投影（与注册表同模式）
    }

    this.#proposals.markApplied(proposalId, workspaceId);
    return { newVersion, appliedOps: proposal.patch.length };
  }

  /** 人工拒绝：标记终态，不产生任何事件 */
  reject(workspaceId: string, proposalId: string): void {
    this.#proposals.markRejected(proposalId, workspaceId);
  }

  /**
   * 受管直接落账（M6）：校验管线 → 落 config.change（version+1）→ 投影。
   * 调用方是受信的宿主/模块系统（ModuleRegistry 的轨道 B）——不登记提议、
   * 不走人工确认；**永不注册为 AI 工具**（§4.1：AI 改配置只有 profile.propose 慢通道）。
   */
  applyDirect(workspaceId: string, by: string, patch: PatchOp[], summary: string): { newVersion: number } {
    const snapshot = this.getSnapshot(workspaceId); // 入口追账
    const { errors } = validatePatch(snapshot, patch);
    if (errors.length > 0) {
      throw new ProfileValidationError(
        `直接落账校验未通过（${errors.length} 项）：\n` + errors.map((e) => `- ${e.message}`).join('\n'),
      );
    }
    const state = this.#configState(workspaceId);
    applyPatch(state, patch); // 试应用（失败抛 PatchError，尚未落任何事件）
    const newVersion = snapshot.version + 1;
    const env = this.oplog.append({
      workspaceId,
      actor: by,
      type: CONFIG_EVENT_TYPE,
      payload: { patch, profileVersion: newVersion, summary },
    });
    this.#applyConfigChange(env); // 命令路径立即投影（与 confirm 同模式）
    return { newVersion };
  }

  listPending(workspaceId: string): ProposalSummary[] {
    return this.#proposals.listPending(workspaceId);
  }

  /** 提议详情（含 patch 全文与影响报告）——确认界面的数据源；不存在抛 ProposalNotFoundError */
  getProposal(workspaceId: string, proposalId: string): Proposal {
    return this.#proposals.get(proposalId, workspaceId);
  }

  // ── 领域种子（幂等）────────────────────────────────────

  /**
   * 装载默认配置基线（领域包调用，core 不认识仓储词汇——内容由领域声明）。
   * 仅当该工作区从未有过 config.change（版本 0 且账本无历史）时生效，
   * attach/重启/多进程反复构造均不重复。种子走事件：同步/迁移/重放自然携带基线。
   */
  seedDefaults(
    workspaceId: string,
    by: string,
    defaults: { workflows?: Record<string, WorkflowDef>; modules?: Record<string, ModuleConfig> },
  ): { seeded: boolean; version: number } {
    this.sync(workspaceId);
    const row = this.#row(workspaceId);
    const hasHistory = this.db
      .prepare(`SELECT 1 FROM oplog WHERE workspace_id = ? AND type = ? LIMIT 1`)
      .get(workspaceId, CONFIG_EVENT_TYPE);
    if (hasHistory || (row?.version ?? 0) > 0) {
      return { seeded: false, version: row?.version ?? 0 };
    }

    const patch: PatchOp[] = [];
    for (const [id, wf] of Object.entries(defaults.workflows ?? {})) {
      patch.push({ op: 'add', path: `/workflows/${id}`, value: wf });
    }
    for (const [id, mod] of Object.entries(defaults.modules ?? {})) {
      patch.push({ op: 'add', path: `/modules/${id}`, value: mod });
    }
    if (patch.length === 0) return { seeded: false, version: 0 };

    const env = this.oplog.append({
      workspaceId,
      actor: by,
      type: CONFIG_EVENT_TYPE,
      payload: { patch, profileVersion: 1, summary: '装载默认配置基线' },
    });
    this.#applyConfigChange(env);
    return { seeded: true, version: 1 };
  }

  // ── 内部：投影与指纹 ───────────────────────────────────

  #applyConfigChange(env: EventEnvelope): void {
    const ws = env.workspaceId;
    const p = env.payload as { patch: PatchOp[]; profileVersion: number };
    const row = this.#row(ws);
    const currentVersion = row?.version ?? 0;
    // 版本链防重/防乱序（§8.4）：严格 +1 才应用；其余静默跳过（重复摄入或乱序，
    // 乱序补洞是 M5 同步协议的职责）
    if (p.profileVersion !== currentVersion + 1) return;

    const state = row ? this.#parseRow(row) : emptyConfigState();
    const next = applyPatch(state, p.patch);
    this.#upsert(ws, p.profileVersion, next);
  }

  /**
   * patch 涉及字段的现状指纹：replace 的目标字段现状（dataType/visible）
   * + add 的目标键存在性。confirm 时重算对比——捕获 propose 与 confirm 之间
   * 的外部字段变更（版本链只覆盖 config 部分，字段走注册表事件流）。
   */
  #fieldFingerprint(workspaceId: string, patch: PatchOp[]): string {
    const entries: string[] = [];
    for (const op of patch) {
      const seg = parsePointer(op.path);
      if (seg[0] !== 'schema' || seg[1] !== 'entities' || seg[3] !== 'extensions') continue;
      const entity = seg[2];

      if (op.op === 'replace' && seg.length === 6 && seg[5] === 'visible') {
        const fields: RegisteredField[] = this.registry.listFields(workspaceId, entity);
        const target = fields[Number(seg[4])];
        if (target) {
          entries.push(`touch:${target.entity}.${target.qualifiedKey}:${target.dataType}:${target.visible}`);
        }
      } else if (op.op === 'add') {
        const key = (op.value as { key?: string }).key;
        if (key) {
          const exists = this.registry.getField(workspaceId, entity, key) !== undefined;
          entries.push(`add:${entity}.${key}:${exists ? 'exists' : 'absent'}`);
        }
      }
    }
    entries.sort();
    return entries.join('|');
  }

  #row(workspaceId: string): ProfileStateRow | undefined {
    return this.db
      .prepare<unknown[], ProfileStateRow>(`SELECT * FROM profile_state WHERE workspace_id = ?`)
      .get(workspaceId);
  }

  #parseRow(row: ProfileStateRow): ConfigState {
    return {
      workflows: JSON.parse(row.workflows) as ConfigState['workflows'],
      modules: JSON.parse(row.modules) as ConfigState['modules'],
      roles: JSON.parse(row.roles) as ConfigState['roles'],
    };
  }

  #configState(workspaceId: string): ConfigState {
    const row = this.#row(workspaceId);
    return row ? this.#parseRow(row) : emptyConfigState();
  }

  #upsert(workspaceId: string, version: number, state: ConfigState): void {
    this.db
      .prepare(
        `INSERT INTO profile_state (workspace_id, version, workflows, modules, roles)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           version = excluded.version, workflows = excluded.workflows,
           modules = excluded.modules, roles = excluded.roles`,
      )
      .run(workspaceId, version, JSON.stringify(state.workflows), JSON.stringify(state.modules), JSON.stringify(state.roles));
  }
}
