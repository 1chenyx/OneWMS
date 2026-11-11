import type { OplogStore } from '../oplog/oplog-store.js';
import type { FieldRegistry, UnregisterReport } from '../registry/field-registry.js';
import { qualifyKey } from '../registry/key-naming.js';
import type { ProfileService } from '../profile/profile-service.js';
import { ProposalStore } from '../profile/proposal-store.js';
import type { ImpactItem, ImpactReport } from '../profile/impact.js';
import type { ToolBus } from '../bus/tool-bus.js';
import {
  ModuleConflictError,
  ModuleDependencyError,
  ModuleNotFoundError,
  ModuleValidationError,
} from '../errors.js';
import type { ModuleConfig, PatchOp, ProfileSnapshot } from '../profile/profile-types.js';
import { compareSemver, validateDynamicRecords, validateManifest } from './manifest-validate.js';
import { CORE_VERSION, DYN_RECORD_PREFIX, type InstalledModule, type ModuleLifecyclePayload, type ManifestRecord, type ModuleManifest } from './manifest-types.js';
import { hasDynRecords, type DynProjectionPort, type DynRecordSchema } from '../dyn/dyn-store.js';

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
    /**
     * 提议登记（B.1）。必须与 ProfileService 注入**同一个实例**——
     * 声明式模块的注册提议与配置补丁提议共用一个待确认队列，
     * 前端 `GET /api/proposals` 一处看到全部，confirm 由 WorkspaceFacade 按 kind 分派。
     * 缺省自建（只服务于直接 install() 的调用方，此时提议能力形同关闭）。
     */
    private readonly proposals: ProposalStore = new ProposalStore(),
    /**
     * 动态记录投影回调（B.2）。依赖经接口反转（DynProjectionPort）：
     * 注册表不持有存储实现，DynStore 也不反向依赖注册表——它经闭包取 schema。
     * 安装含声明式实体的模块成功后，回调整组重投影（dyn_index 按新 manifest 重建）。
     */
    private readonly dyn?: DynProjectionPort,
    /**
     * 声明式实体工具同步回调（B.4）。用闭包反转而不是 import：注册表不该知道
     * 「工具 description 怎么拼」，只负责在正确的时机喊一声。
     * 另一个同步时机在工作区打开时（WorkspaceFacade 构造）——重启后 manifest 是靠
     * config.change 重放回来的，那条路径不经过 install，所以两处都得挂。
     */
    private readonly onDynRecordsInstalled?: (workspaceId: string) => void,
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
      for (const t of c.transitions) {
        if (wf.transitions.some((x) => x.from === t.from && x.to === t.to)) {
          throw new ModuleConflictError(
            `流程 ${wfId} 已存在转移 ${t.from}→${t.to}，与模块 ${manifest.id} 的贡献冲突（§6.3）`,
          );
        }
      }
    }

    // 预检 7（B.1，仅当 manifest 声明了 dyn 命名空间的实体时生效）：
    // 命名空间完整性 + 实体名不与任何已声明实体撞名。
    // ⚠️ 内置模块的 records 一律不受本预检影响（没有 `dyn.` 前缀就直接跳过），
    // 否则既有内置 manifest 之间合法的 id/别名重叠会突然变成安装失败。
    if ((manifest.records ?? []).some((r) => r.id.startsWith(DYN_RECORD_PREFIX))) {
      this.#assertDynamicRecords(workspaceId, manifest);
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
    // 代码不在场的模块（= 声明式模块）把整份 manifest 一起落账：进程目录随重启清空，
    // config 是它唯一的持久化载体。内置模块不写——代码才是真相，再存一份就是两份真相。
    const moduleConfig: ModuleConfig = {
      enabled: true,
      version: manifest.version,
      settings,
      ...(this.#manifests.has(manifest.id) ? {} : { manifest }),
    };
    const patch: PatchOp[] = [
      { op: 'add', path: `/modules/${manifest.id}`, value: moduleConfig },
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
        patch.push({
          op: 'add',
          path: `/workflows/${wfId}/transitions/-`,
          value: { ...t, providedBy: manifest.id },
        });
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

    // B.2：含声明式实体的模块安装成功后，整组重投影（清模块切片 + 按当前 manifest 重放）。
    // 必须无条件执行而不是只认版本戳——卸载保留数据，重装同 id 时 manifest 可能已变
    // （queryable 增减、字段增删），dyn_index 行只有按新 manifest 重建才对得上；
    // 版本戳只认代码版本（DYN_PROJECTION_VERSION），manifest 是数据不是代码，它管不到这里。
    if (this.dyn && hasDynRecords(manifest.records)) {
      this.dyn.reprojectModule(workspaceId, manifest.id);
    }

    // B.4：装完立刻把新实体的 AI 工具挂上总线，不重启就可用（这是 B 阶段的验收要求）。
    // 顺序在重投影之后：工具一旦可见就该能查到数据，别留「能调但查不到」的窗口。
    // ⚠️ 只在安装时同步，卸载时**什么都不做**（§A.4：不 unregister，可见性交给授权层过滤）。
    if (hasDynRecords(manifest.records)) {
      this.onDynRecordsInstalled?.(workspaceId);
    }

    return { installed: true, version: newVersion };
  }

  // ── 卸载（逆操作，§6.2 表格）────────────────────────────

  /**
   * 卸载模块（per-workspace）：
   *  - 字段处置委托 registry.unregisterModule（移交/软删除，M1 既有）；
   *  - workflows 摘除 = providedBy={id} 的 states 与 transitions，
   *    外加两端引用被摘状态的转移（老数据的转移可能没有 providedBy）；
   *    规则从数据推导——远端重放无需 manifest；
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
      const removedStates = new Set(wf.states.filter((s) => s.providedBy === moduleId).map((s) => s.id));
      const states = wf.states.filter((s) => s.providedBy !== moduleId);
      const transitions = wf.transitions.filter(
        (t) => t.providedBy !== moduleId && !removedStates.has(t.from) && !removedStates.has(t.to),
      );
      if (states.length === wf.states.length && transitions.length === wf.transitions.length) continue;
      patch.push({
        op: 'replace',
        path: `/workflows/${wfId}`,
        value: { states, transitions },
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

  // ── 声明式模块提案（B.1：慢通道 confirm/reject 复用 Profile 管线）──────

  /**
   * 为一份声明式 manifest 登记 `dyn.module.register` 提议（不落任何事件）。
   *
   * 提案期把**静态可判定**的全部拦下（结构 / 命名空间 / 撞名），因为确认界面展示的
   * 必须是「点了确认就能装上」的东西——把失败推迟到 confirm 会让用户点了才看到报错，
   * 影响报告失去意义（§7.3 所见即所得）。
   *
   * ⚠️ 安装期的 6 道预检**故意不在这里跑**：依赖是否在场、工具 handler 是否已注册
   * 都会随时间变化，propose 时通过不代表 confirm 时通过。confirm 由 install() 重新判定，
   * 失败会抛结构化错误而不是静默装上半个模块。
   */
  proposeInstall(
    workspaceId: string,
    manifest: ModuleManifest,
    opts: { proposedBy?: string; note?: string } = {},
  ): { proposalId: string; report: ImpactReport } {
    const { errors } = validateManifest(manifest);
    if (errors.length > 0) {
      throw new ModuleValidationError(
        `manifest 校验未通过（${errors.length} 项）：\n` + errors.map((e) => `- ${e.message}`).join('\n'),
      );
    }
    this.#assertDynamicRecords(workspaceId, manifest);

    const snapshot = this.profile.getSnapshot(workspaceId);
    const report = buildDynInstallReport(manifest, snapshot);
    const proposal = this.proposals.create({
      workspaceId,
      proposedBy: opts.proposedBy ?? `module:${manifest.id}@${this.nodeId}`,
      note: opts.note,
      kind: 'dyn.module.register',
      manifest,
      baseVersion: snapshot.version,
      // dyn 提议没有 patch，不参与 ProfileService.confirm 的字段指纹新鲜度检查；
      // 它的新鲜度由 install() 的幂等/冲突预检在 confirm 时刻重新判定。
      baseFieldFingerprint: '',
      report,
    });
    return { proposalId: proposal.proposalId, report };
  }

  /**
   * 声明式 records 的命名空间与撞名断言（提案期 + 安装预检 7 共用）。
   * 撞名比对的是**全部已声明实体**——包括尚未安装的内置模块：
   * 现在放行，等那个内置模块装上就会被顶掉查询入口（query-tools 按 id/label/alias 解析 entity）。
   */
  #assertDynamicRecords(workspaceId: string, manifest: ModuleManifest): void {
    const nsErrors = validateDynamicRecords(manifest);
    if (nsErrors.length > 0) {
      throw new ModuleValidationError(
        `声明式实体校验未通过（${nsErrors.length} 项）：\n` + nsErrors.map((e) => `- ${e.message}`).join('\n'),
      );
    }
    const taken = this.#recordNames(workspaceId, manifest.id);
    for (const record of manifest.records ?? []) {
      for (const name of [record.id, ...(record.aliases ?? [])]) {
        if (taken.has(name.trim().toLowerCase())) {
          throw new ModuleValidationError(
            `实体名「${name}」已被现有模块占用——声明式模块的 id/别名只能落在 ` +
              `${DYN_RECORD_PREFIX}${manifest.id}.{recordId} 命名空间内（别名同样不得与内置实体重名）`,
          );
        }
      }
    }
  }

  /** 现有实体的全部可寻址名（id + aliases，小写归一）。excludeModuleId 用于放行「自己覆盖自己」 */
  #recordNames(workspaceId: string, excludeModuleId?: string): Set<string> {
    const names = new Set<string>();
    const collect = (m: ModuleManifest): void => {
      if (m.id === excludeModuleId) return;
      for (const r of m.records ?? []) {
        names.add(r.id.trim().toLowerCase());
        for (const a of r.aliases ?? []) names.add(a.trim().toLowerCase());
      }
    };
    for (const m of this.#manifests.values()) collect(m);
    // 进程目录覆盖不到的部分：已安装的声明式模块（manifest 随 config 落账，重启后目录里没有）
    const snapshot = this.profile.getSnapshot(workspaceId);
    for (const [id, config] of Object.entries(snapshot.modules)) {
      if (config.manifest && !this.#manifests.has(id)) collect(config.manifest);
    }
    return names;
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
      // 进程目录优先（内置模块的真相是代码），落账的 manifest 兜底
      // （声明式模块重启后目录为空，只有 config 里有）
      manifest: this.#manifests.get(id) ?? config.manifest,
    }));
  }

  /**
   * 生效的 manifest 全集 = 进程目录（代码在场的内置模块）+ 已落账的声明式模块 manifest。
   *
   * query-tools 的目录装配必须用它替代 listManifests()，否则声明式模块对 AI 完全不可见
   * （进程目录里压根没有它的条目）。同 id 时进程目录优先——代码是真相。
   */
  effectiveManifests(workspaceId: string): ModuleManifest[] {
    const snapshot = this.profile.getSnapshot(workspaceId);
    const out = new Map<string, ModuleManifest>(this.#manifests);
    for (const [id, config] of Object.entries(snapshot.modules)) {
      if (config.manifest && !out.has(id)) out.set(id, config.manifest);
    }
    return [...out.values()];
  }

  /**
   * 已安装模块声明的全部声明式实体（B.2 记录存储的 schema 来源）。
   * 「生效 manifest 全集 ∩ 已安装」——未安装的目录条目不提供存储白名单。
   * module enabled 与否在此不区分：端点可见性（B.3）与存储 schema 是两层。
   */
  installedDynRecords(workspaceId: string): DynRecordSchema[] {
    const snapshot = this.profile.getSnapshot(workspaceId);
    const out: { moduleId: string; record: ManifestRecord }[] = [];
    for (const manifest of this.effectiveManifests(workspaceId)) {
      if (!snapshot.modules[manifest.id]) continue;
      for (const record of manifest.records ?? []) {
        if (record.id.startsWith(DYN_RECORD_PREFIX)) out.push({ moduleId: manifest.id, record });
      }
    }
    return out;
  }
}

/**
 * 声明式模块注册提议的影响报告（§7.3：确认界面展示的全部内容都从这里来）。
 *
 * 与 buildImpactReport 分开写，因为那条路消费的是 patch 列表，
 * 而 dyn 提议的载荷是整份 manifest——没有 patch 可推。
 */
function buildDynInstallReport(manifest: ModuleManifest, snapshot: ProfileSnapshot): ImpactReport {
  const items: ImpactItem[] = [];

  for (const record of manifest.records ?? []) {
    items.push({
      severity: 'info',
      kind: 'record.added',
      target: record.id,
      description: `新增声明式实体「${record.label}」（${record.fields?.length ?? 0} 列）`,
    });
  }
  for (const f of manifest.fields?.provides ?? []) {
    items.push({
      severity: 'info',
      kind: 'field.added',
      target: `${f.entity}.${f.key}`,
      description: `模块 ${manifest.id} 提供扩展字段「${f.label}」`,
    });
  }
  for (const wfId of Object.keys(manifest.workflows?.base ?? {})) {
    const exists = Boolean(snapshot.workflows[wfId]);
    items.push({
      severity: 'info',
      kind: exists ? 'workflow.skipped' : 'workflow.added',
      target: wfId,
      description: exists ? `流程「${wfId}」已存在，base 种子跳过` : `新增基础流程「${wfId}」`,
    });
  }
  for (const [wfId, c] of Object.entries(manifest.workflows?.contributes ?? {})) {
    items.push({
      severity: 'info',
      kind: 'workflow.contributed',
      target: wfId,
      description: `向流程「${wfId}」贡献 ${c.states.length} 个状态 / ${c.transitions.length} 条转移`,
    });
  }
  for (const t of manifest.tools ?? []) {
    items.push({
      severity: 'info',
      kind: 'tool.declared',
      target: t.id,
      description: `声明工具「${t.label}」。handler 须已由代码装载方在总线上就位，否则确认时预检拒绝`,
    });
  }

  const current = snapshot.modules[manifest.id];
  if (current) {
    items.push({
      severity: 'warning',
      kind: 'module.conflict',
      target: manifest.id,
      description:
        current.version === manifest.version
          ? `模块 ${manifest.id} 已安装同版本，确认后为幂等操作（不产生事件）`
          : `模块 ${manifest.id} 已安装（版本 ${current.version ?? '未知'}）。当前版本无原地升级，确认时会被冲突预检拒绝`,
    });
  }
  for (const depId of manifest.dependencies?.modules ?? []) {
    if (!snapshot.modules[depId]?.enabled) {
      items.push({
        severity: 'warning',
        kind: 'module.dependency',
        target: depId,
        description: `依赖模块 ${depId} 未安装或未启用，确认时会被依赖预检拒绝`,
      });
    }
  }
  if ((manifest.tools ?? []).length > 0) {
    items.push({
      severity: 'warning',
      kind: 'tool.handler',
      target: manifest.id,
      description: '工具声明依赖代码侧已注册的 handler：纯 JSON 模块不能自带工具实现',
    });
  }

  const counts = [
    manifest.records?.length ? `${manifest.records.length} 个实体` : '',
    manifest.fields?.provides?.length ? `${manifest.fields.provides.length} 个扩展字段` : '',
    manifest.tools?.length ? `${manifest.tools.length} 个工具声明` : '',
  ].filter(Boolean);
  return {
    summary: `新增声明式模块「${manifest.name}」（${manifest.id}@${manifest.version}）${counts.length ? `：${counts.join('、')}` : ''}`,
    items,
  };
}
