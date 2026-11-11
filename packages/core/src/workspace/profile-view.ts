import type { ModuleConfig, PatchOp, ProfileSnapshot, WorkflowDef } from '../profile/profile-types.js';
import type { ProfileService } from '../profile/profile-service.js';
import type { ImpactReport } from '../profile/impact.js';
import type { Proposal, ProposalSummary } from '../profile/proposal-store.js';
import type { ModuleManifest } from '../modules/manifest-types.js';

/**
 * Profile 的工作区绑定视图（ProfileView）。
 *
 * 与其他 View 同纪律：构造期绑定 workspaceId，调用方不再传。
 * confirm/reject 在这里暴露为公共 API——它们是**人类**的确认入口
 * （前端/CLI 调用），永不注册为 AI 工具（§4.1 确认权不可委托）。
 */
export class ProfileView {
  constructor(
    private readonly workspaceId: string,
    private readonly nodeId: string,
    private readonly service: ProfileService,
    /**
     * 声明式模块安装器（B.1）：由 WorkspaceFacade 注入的闭包，转调 ModuleRegistry.install。
     *
     * 为什么走闭包而不是直接持有 ModuleRegistry：ProfileService 不能 import ModuleRegistry
     * （后者已依赖前者，会形成运行时环）；而 WorkspaceFacade 同时持有两者，
     * 由它把「安装能力」作为函数递进来，依赖方向保持单向。
     * 缺省 undefined = 未装配（core 单测直接 new ProfileView 的场景），
     * 此时 confirm 一条 dyn 提议会明确报错而不是静默当成 patch 处理。
     */
    private readonly dynInstaller?: (manifest: ModuleManifest, actor: string) => { installed: boolean; version: number },
  ) {}

  /** 聚合快照（schema ← 注册表；workflows/modules/roles ← config.change 投影） */
  getSnapshot(): ProfileSnapshot {
    return this.service.getSnapshot(this.workspaceId);
  }

  /** 提议：校验三关 + 影响报告（不落事件，pending 态） */
  propose(by: string, patch: PatchOp[], note?: string): { proposalId: string; report: ImpactReport } {
    return this.service.propose(this.workspaceId, by, patch, note);
  }

  /**
   * 人工确认 → 热应用（actor 默认本节点，前端接入后传用户身份）。
   *
   * B.1 起按提议 kind 分派：
   *  - `patch` → ProfileService.confirm（双轨热应用，原路径不变）；
   *  - `dyn.module.register` → ModuleRegistry.install（6 道预检在 confirm 时刻重新判定）。
   * 分派放在这里而不是路由层，是为了让 `POST /api/proposals/:id/confirm` 一行不改——
   * 前端「待确认提议」列表本来就是一个队列，两种提议不该有两个确认入口。
   */
  confirm(proposalId: string, by = this.nodeId): { newVersion: number; appliedOps: number } {
    const proposal = this.service.getProposal(this.workspaceId, proposalId);
    if (proposal.kind !== 'dyn.module.register') {
      return this.service.confirm(this.workspaceId, by, proposalId);
    }
    if (!proposal.manifest) {
      throw new Error(`提议 ${proposalId} 声明为 dyn.module.register 但没有 manifest 载荷（装配错误）`);
    }
    if (!this.dynInstaller) {
      throw new Error(`提议 ${proposalId} 是声明式模块注册，但本视图未装配模块安装器（应经 WorkspaceFacade 使用）`);
    }
    const result = this.dynInstaller(proposal.manifest, by);
    // install 自己走轨道 B 落账（config.change + module.installed），这里只收尾提议终态。
    // ⚠️ 幂等分支（installed:false）也要标记 applied：提议已经消费掉了，
    // 留着 pending 会让用户反复确认一个不会再产生任何变化的操作。
    this.service.markProposalApplied(this.workspaceId, proposalId);
    return { newVersion: result.version, appliedOps: 1 };
  }

  /** 人工拒绝 */
  reject(proposalId: string): void {
    this.service.reject(this.workspaceId, proposalId);
  }

  /** 待确认提议清单（确认界面的数据源） */
  listPending(): ProposalSummary[] {
    return this.service.listPending(this.workspaceId);
  }

  /** 提议详情（含 patch 全文与影响报告，确认界面渲染 diff 用） */
  getProposal(proposalId: string): Proposal {
    return this.service.getProposal(this.workspaceId, proposalId);
  }

  /** 领域种子：装载默认配置基线（仅首次，幂等） */
  seedDefaults(
    by: string,
    defaults: { workflows?: Record<string, WorkflowDef>; modules?: Record<string, ModuleConfig> },
  ): { seeded: boolean; version: number } {
    return this.service.seedDefaults(this.workspaceId, by, defaults);
  }
}
