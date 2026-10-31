import type { ModuleConfig, PatchOp, ProfileSnapshot, WorkflowDef } from '../profile/profile-types.js';
import type { ProfileService } from '../profile/profile-service.js';
import type { ImpactReport } from '../profile/impact.js';
import type { Proposal, ProposalSummary } from '../profile/proposal-store.js';

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
  ) {}

  /** 聚合快照（schema ← 注册表；workflows/modules/roles ← config.change 投影） */
  getSnapshot(): ProfileSnapshot {
    return this.service.getSnapshot(this.workspaceId);
  }

  /** 提议：校验三关 + 影响报告（不落事件，pending 态） */
  propose(by: string, patch: PatchOp[], note?: string): { proposalId: string; report: ImpactReport } {
    return this.service.propose(this.workspaceId, by, patch, note);
  }

  /** 人工确认 → 热应用（actor 默认本节点，前端接入后传用户身份） */
  confirm(proposalId: string, by = this.nodeId): { newVersion: number; appliedOps: number } {
    return this.service.confirm(this.workspaceId, by, proposalId);
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
