import type { OplogStore } from '../oplog/oplog-store.js';
import type { FieldRegistry, UnregisterReport } from '../registry/field-registry.js';
import { qualifyKey } from '../registry/key-naming.js';
import type { ProfileService } from '../profile/profile-service.js';
import type { ToolBus } from '../bus/tool-bus.js';
import {
  ModuleConflictError,
  ModuleDependencyError,
  ModuleNotFoundError,
  ModuleValidationError,
} from '../errors.js';
import type { PatchOp, ProfileSnapshot } from '../profile/profile-types.js';
import { compareSemver, validateManifest } from './manifest-validate.js';
import { CORE_VERSION, type InstalledModule, type ModuleLifecyclePayload, type ModuleManifest } from './manifest-types.js';

/** 模块生命周期审计事件类型（§8.2 事件目录：强一致） */
export const MODULE_INSTALLED_EVENT = 'module.installed';
export const MODULE_UNINSTALLED_EVENT = 'module.uninstalled';

/** 卸载结果：字段处置报告（M1 既有语义）+ config 新版本 */
export interface ModuleUninstallReport {
  moduleId: string;
  fields: UnregisterReport;
  newVersion: number;
}

/**
 * 模块注册服务（ModuleRegistry，DESIGN.md §6/§7，里程碑 6）。
 *
 * 职责：把声明性 manifest 变成受管的安装/卸载管线——预检（零事件）→
 * 双轨落事件（字段走注册表、config 走 applyDirect）→ 生命周期审计事件。
 *
 * 真相源分治（不存第二份真相）：
 *  - 安装状态 = Profile.modules 段（config.change 投影）；
 *  - 字段元数据 = registry.* 事件；
 *  - manifest 元数据 = 进程内存目录（代码装载方 registerManifest——「代码在场」的声明面）。
 *
 * 依赖登记（ARCHITECTURE.md 服务层横向依赖白名单）：
 *  - → oplog-store：module.installed/uninstalled 审计事件；
 *  - → field-registry：字段轨道；
 *  - → profile-service：config 轨道（applyDirect，写路径唯一）；
 *  - → tool-bus：安装期工具声明与总线事实的一致性校验（listTools 只读）。
 */
export class ModuleRegistry {
  /** 进程 manifest 目录（代码装载方注册；同 id 覆盖 = 热更新心智） */
  readonly #manifests = new Map<string, ModuleManifest>();

  constructor(
    private readonly nodeId: string,
    private readonly oplog: OplogStore,
    private readonly registry: FieldRegistry,
    private readonly profile: ProfileService,
    private readonly bus: ToolBus,
  ) {}

  // ── 进程 manifest 目录（代码装载方：领域包 attach 期调用）────

  /** 注册 manifest 到进程目录（结构校验先行；同 id 覆盖——版本升级的代码装载） */
  registerManifest(manifest: ModuleManifest): void {
    const { errors } = validateManifest(manifest);
    if (errors.length > 0) {
      throw new ModuleValidationError(
        `manifest 校验未通过（${errors.length} 项）：\n` + errors.map((e) => `- ${e.message}`).join('\n'),
      );
    }
    this.#manifests.set(manifest.id, manifest);
  }

  getManifest(id: string): ModuleManifest | undefined {
    return this.#manifests.get(id);
  }

  listManifests(): ModuleManifest[] {
    return [...this.#manifests.values()];
  }

  // ── 安装（预检全过才落第一条事件——「先证明后动手」）──────

  /**
   * 安装模块（per-workspace）。幂等：已装同版本 → { installed:false }（零事件）。
   * 落事件顺序固定（确定性铁律）：轨道 A（字段）→ 轨道 B（config）→ 审计事件。
   */
  install(
    workspaceId: string,
    manifest: ModuleManifest,
    opts?: { actor?: string },
  ): { installed: boolean; version: number } {
    // ── 预检（零事件）──────────────────────────────────
    const { errors } = validateManifest(manifest);
    if (errors.length > 0) {
      throw new ModuleValidationError(
        `manifest 校验未通过（${errors.length} 项）：\n` + errors.map((e) => `- ${e.message}`).join('\n'),
      );
    }
    if (manifest.minCoreVersion && compareSemver(CORE_VERSION, manifest.minCoreVersion) < 0) {
      throw new ModuleValidationError(
        `内核版本 ${CORE_VERSION} 低于模块 ${manifest.id} 要求的最低版本 ${manifest.minCoreVersion}`,
      );
    }

    const actor = opts?.actor ?? `module:${manifest.id}@${this.nodeId}`;
    const snapshot = this.profile.getSnapshot(workspaceId); // 入口追账
    const installed = snapshot.modules[manifest.id];

    // 预检 2：幂等 / 版本冲突（v1 无原地升级——先卸载再装）
    if (installed) {
      if (installed.version === manifest.version) {
        return { installed: false, version: snapshot.version };
      }
      throw new ModuleConflictError(
        `模块 ${manifest.id} 已安装（版本 ${installed.version ?? '未知'}），与本次声明的 ${manifest.version} 不一致——升级须先卸载`,
      );
    }

    // 预检 3：依赖在场且启用 + slot 无其他占位者（§7.2 择一型）
    for (const depId of manifest.dependencies?.modules ?? []) {
      const dep = snapshot.modules[depId];
      if (!dep) {
        throw new ModuleDependencyError(`模块 ${manifest.id} 依赖的 ${depId} 未安装（需先安装依赖模块）`);
      }
      if (!dep.enabled) {
        throw new ModuleDependencyError(`模块 ${manifest.id} 依赖的 ${depId} 当前已停用`);
      }
    }
    if (manifest.slot) {
      for (const other of this.#manifests.values()) {
        if (other.id === manifest.id || other.slot?.name !== manifest.slot.name) continue;
        if (snapshot.modules[other.id]) {
          throw new ModuleConflictError(
            `槽位 ${manifest.slot.name} 已被模块 ${other.id} 占用（择一型冲突：先卸载或切换，§7.2）`,
          );
        }
      }
    }

    // 预检 4：字段现状（§7.1 类型冲突 + §7.2 requires 存在性）
    for (const p of manifest.fields?.provides ?? []) {
      const qualifiedKey = qualifyKey(manifest.id, p.key, p.sharing ?? 'shared');
      const existing = this.registry.getField(workspaceId, p.entity, qualifiedKey);
      if (existing && existing.dataType !== p.type) {
        throw new ModuleConflictError(
          `字段 ${p.entity}.${qualifiedKey} 已存在（owner: ${existing.owner}，类型 ${existing.dataType}），` +
            `与模块 ${manifest.id} 声明的类型 ${p.type} 不兼容`,
        );
      }
    }
    for (const r of manifest.fields?.requires ?? []) {
      const qualifiedKey = qualifyKey(manifest.id, r.key, r.sharing ?? 'shared');
      const existing = this.registry.getField(workspaceId, r.entity, qualifiedKey);
      if (!existing) {
        throw new ModuleDependencyError(
          `模块 ${manifest.id} 依赖的字段 ${r.entity}.${qualifiedKey} 未注册（需先安装提供它的模块）`,
        );
      }
      if (r.expectType && existing.dataType !== r.expectType) {
        throw new ModuleConflictError(
          `字段 ${r.entity}.${qualifiedKey} 类型为 ${existing.dataType}，与模块 ${manifest.id} 期望的 ${r.expectType} 不兼容`,
        );
      }
    }

    // 预检 5：工具声明 ↔ 总线事实（装载方须先注册 handler）
    const busTools = new Map(this.bus.listTools().map((t) => [t.id, t]));
    for (const t of manifest.tools ?? []) {
      const actual = busTools.get(t.id);
      if (!actual) {
        throw new ModuleValidationError(
          `模块 ${manifest.id} 声明的工具 ${t.id} 未在工具总线上注册（代码装载方须先注册 handler）`,
        );
      }
      if (actual.permission !== t.permission) {
        throw new ModuleValidationError(
          `工具 ${t.id} 的 permission 声明（${t.permission}）与总线事实（${actual.permission}）不一致`,
        );
      }
    }

    // 预检 6：流程贡献（§6.3 模块不创建流程；同 id 状态冲突拒绝）
    for (const [wfId, c] of Object.entries(manifest.workflows?.contributes ?? {})) {
      const wf = snapshot.workflows[wfId];
      if (!wf) {
        throw new ModuleValidationError(
          `模块 ${manifest.id} 向不存在的流程 ${wfId} 贡献状态（模块只能向既有流程贡献，不创建流程）`,
        );
      }
      for (const s of c.states) {
        if (wf.states.some((x) => x.id === s.id)) {
          throw new ModuleConflictError(
            `流程 ${wfId} 已存在状态 "${s.id}"，与模块 ${manifest.id} 的贡献冲突（§6.3）`,
          );
        }
      }
    }

    // ── 落事件（顺序固定：轨道 A → 轨道 B → 审计）────────
    // 轨道 A：字段（已存在且类型兼容 → DO NOTHING + usedBy 追加，§7.1 后装共享语义）
    for (const p of manifest.fields?.provides ?? []) {
      this.registry.provide(
        workspaceId,
        manifest.id,
        {
          entity: p.entity,
          key: p.key,
          label: p.label,
          dataType: p.type,
          sharing: p.sharing ?? 'shared',
          description: p.description,
        },
        { actor },
      );
    }
    for (const r of manifest.fields?.requires ?? []) {
      this.registry.require(
        workspaceId,
        manifest.id,
        { entity: r.entity, key: r.key, sharing: r.sharing, expectType: r.expectType },
        { actor },
      );
    }

    // 轨道 B：config（modules 登记 + base 流程种子 + contributes 合并）
    const settings: Record<string, unknown> = {};
    for (const [k, prop] of Object.entries(manifest.settings?.schema.properties ?? {})) {
      if (prop.default !== undefined) settings[k] = prop.default;
    }
    const patch: PatchOp[] = [
      { op: 'add', path: `/modules/${manifest.id}`, value: { enabled: true, version: manifest.version, settings } },
    ];
    for (const [wfId, def] of Object.entries(manifest.workflows?.base ?? {})) {
      if (snapshot.workflows[wfId]) continue; // base 守卫：目标流程已存在（老库）则跳过
      patch.push({ op: 'add', path: `/workflows/${wfId}`, value: def });
    }
    for (const [wfId, c] of Object.entries(manifest.workflows?.contributes ?? {})) {
      for (const s of c.states) {
        patch.push({
          op: 'add',
          path: `/workflows/${wfId}/states/-`,
          value: { id: s.id, label: s.label, providedBy: manifest.id },
        });
      }
      for (const t of c.transitions) {
        patch.push({ op: 'add', path: `/workflows/${wfId}/transitions/-`, value: t });
      }
    }
    const { newVersion } = this.profile.applyDirect(
      workspaceId,
      actor,
      patch,
      `安装模块 ${manifest.id}@${manifest.version}`,
    );

    // 审计事件（manifest 摘要 + 版本，§8.2；不是配置投影的真相源）
    this.oplog.append({
      workspaceId,
      actor,
      type: MODULE_INSTALLED_EVENT,
      payload: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        capabilities: manifest.capabilities,
      } satisfies ModuleLifecyclePayload,
    });

    return { installed: true, version: newVersion };
  }

  // ── 卸载（逆操作，§6.2 表格）────────────────────────────

  /**
   * 卸载模块（per-workspace）：
   *  - 字段处置委托 registry.unregisterModule（移交/软删除，M1 既有）；
   *  - workflows 摘除 = providedBy={id} 的 states + 两端引用这些 states 的 transitions
   *    （规则从数据推导——远端重放无需 manifest）；
   *  - modules 段移除；摘除 patch 过 applyDirect 校验（连通性兜底）。
   */
  uninstall(workspaceId: string, moduleId: string, opts?: { actor?: string }): ModuleUninstallReport {
    const actor = opts?.actor ?? `module:${moduleId}@${this.nodeId}`;
    const snapshot = this.profile.getSnapshot(workspaceId);
    const config = snapshot.modules[moduleId];
    if (!config) {
      throw new ModuleNotFoundError(`模块 ${moduleId} 未安装`);
    }

    // 构造摘除 patch（先算后动；replace 整个流程定义——比逐条 remove 索引稳健）
    const patch: PatchOp[] = [];
    for (const [wfId, wf] of Object.entries(snapshot.workflows)) {
      const removed = new Set(wf.states.filter((s) => s.providedBy === moduleId).map((s) => s.id));
      if (removed.size === 0) continue;
      patch.push({
        op: 'replace',
        path: `/workflows/${wfId}`,
        value: {
          states: wf.states.filter((s) => s.providedBy !== moduleId),
          transitions: wf.transitions.filter((t) => !removed.has(t.from) && !removed.has(t.to)),
        },
      });
    }
    patch.push({ op: 'remove', path: `/modules/${moduleId}` });

    // 轨道 A：字段处置（非 owner 移出 usedBy；owner 移交或软删除——数据永不丢）
    const fields = this.registry.unregisterModule(workspaceId, moduleId);

    // 轨道 B：config 摘除（applyDirect 内部跑校验管线兜底）
    const { newVersion } = this.profile.applyDirect(workspaceId, actor, patch, `卸载模块 ${moduleId}`);

    // 审计事件
    this.oplog.append({
      workspaceId,
      actor,
      type: MODULE_UNINSTALLED_EVENT,
      payload: { id: moduleId, version: config.version ?? '' } satisfies ModuleLifecyclePayload,
    });

    return { moduleId, fields, newVersion };
  }

  // ── 查询 ────────────────────────────────────────────────

  /** 已安装模块清单（modules 段状态 + 进程目录 manifest 元数据的聚合视图） */
  listInstalled(workspaceId: string): InstalledModule[] {
    const snapshot = this.profile.getSnapshot(workspaceId);
    return Object.entries(snapshot.modules).map(([id, config]) => ({
      id,
      enabled: config.enabled,
      version: config.version ?? '',
      settings: config.settings ?? {},
      manifest: this.#manifests.get(id),
    }));
  }
}
