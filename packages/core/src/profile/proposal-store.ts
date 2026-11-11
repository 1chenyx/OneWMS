import { randomUUID } from 'node:crypto';
import { ProposalNotFoundError, ProposalStateError } from '../errors.js';
import type { ModuleManifest } from '../modules/manifest-types.js';
import type { ImpactReport } from './impact.js';
import type { PatchOp } from './profile-types.js';

/**
 * 提议登记（ProposalStore）—— 慢通道确认工作流的状态载体（§4.2/§7.3）。
 *
 * 设计决策：**提议不落库、不落事件**。
 *  - 「提议不是事实」：oplog 里只应有已确认的 config.change——
 *    被拒绝的提议留在内存里消失即可，不污染事件流（审计语义干净）；
 *  - 重启丢弃 pending 提议是可接受的损失：用户让 AI 重新提议即可，无数据损坏；
 *  - 确认权在人类：confirm/reject 由前端/CLI 调用，永不注册为 AI 工具（§4.1）。
 *
 * 生命周期：pending → applied | rejected（终态，不可逆）。
 */
export type ProposalStatus = 'pending' | 'applied' | 'rejected';

/**
 * 提议的种类（B.1 引入）。
 *  - `patch`：配置补丁，confirm 时走 ProfileService 的双轨热应用；
 *  - `dyn.module.register`：声明式模块注册，confirm 时走 ModuleRegistry.install
 *    （载荷是整份 manifest，不是 patch）。
 *
 * 为什么加 kind 而不是把 manifest 硬塞成 patch：install 的 6 道预检
 * （依赖在场 / slot 占位 / 状态冲突 / 字段现状 / 工具在场）需要读实时状态并抛结构化错误，
 * 这些语义无法由 applyPatch 表达。两条路共用同一个确认队列与同一个 ProposalStore，
 * 前端「待确认提议」列表一处就能看到全部。
 */
export type ProposalKind = 'patch' | 'dyn.module.register';

export interface Proposal {
  proposalId: string;
  workspaceId: string;
  /** 提议者：'ai:模型名' / 节点 id / 未来用户身份 */
  proposedBy: string;
  /** 提议说明（AI 给出的意图描述，进确认界面） */
  note?: string;
  /** 提议种类；缺省 'patch'（既有调用方零改动） */
  kind: ProposalKind;
  /** kind='patch' 时的配置补丁 */
  patch: PatchOp[];
  /** kind='dyn.module.register' 时的模块声明（整份 manifest） */
  manifest?: ModuleManifest;
  /** propose 时刻的 profileVersion（confirm 时的新鲜度基准之一） */
  baseVersion: number;
  /** propose 时刻 patch 涉及字段的现状指纹（新鲜度基准之二） */
  baseFieldFingerprint: string;
  report: ImpactReport;
  status: ProposalStatus;
  createdAt: string;
}

/** 确认界面 / AI 上下文可见的提议摘要（不含 patch 全文） */
export interface ProposalSummary {
  proposalId: string;
  proposedBy: string;
  note?: string;
  kind: ProposalKind;
  baseVersion: number;
  summary: string;
  status: ProposalStatus;
  createdAt: string;
  /** patch 里的 path。界面用来把助手定义和其它配置分开确认，不展示给用户。 */
  paths: string[];
}

export class ProposalStore {
  #proposals = new Map<string, Proposal>();

  create(params: {
    workspaceId: string;
    proposedBy: string;
    note?: string;
    kind?: ProposalKind;
    patch?: PatchOp[];
    manifest?: ModuleManifest;
    baseVersion: number;
    baseFieldFingerprint: string;
    report: ImpactReport;
  }): Proposal {
    const proposal: Proposal = {
      proposalId: randomUUID(),
      workspaceId: params.workspaceId,
      proposedBy: params.proposedBy,
      note: params.note,
      kind: params.kind ?? 'patch',
      patch: params.patch ?? [],
      manifest: params.manifest,
      baseVersion: params.baseVersion,
      baseFieldFingerprint: params.baseFieldFingerprint,
      report: params.report,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.#proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  /** 按 id 取提议；mustBelongsTo 校验工作区归属（跨工作区 id 不可见） */
  get(proposalId: string, mustBelongsTo?: string): Proposal {
    const p = this.#proposals.get(proposalId);
    if (!p || (mustBelongsTo !== undefined && p.workspaceId !== mustBelongsTo)) {
      throw new ProposalNotFoundError(`提议不存在: ${proposalId}`);
    }
    return p;
  }

  listPending(workspaceId: string): ProposalSummary[] {
    return [...this.#proposals.values()]
      .filter((p) => p.workspaceId === workspaceId && p.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ proposalId, proposedBy, note, kind, baseVersion, report, status, createdAt, patch }) => ({
        proposalId,
        proposedBy,
        note,
        kind,
        baseVersion,
        summary: report.summary,
        status,
        createdAt,
        paths: patch.map((op) => op.path),
      }));
  }

  markApplied(proposalId: string, workspaceId: string): void {
    const p = this.get(proposalId, workspaceId);
    this.#assertPending(p);
    p.status = 'applied';
  }

  markRejected(proposalId: string, workspaceId: string): void {
    const p = this.get(proposalId, workspaceId);
    this.#assertPending(p);
    p.status = 'rejected';
  }

  #assertPending(p: Proposal): void {
    if (p.status !== 'pending') {
      throw new ProposalStateError(`提议 ${p.proposalId} 已 ${p.status === 'applied' ? '应用' : '拒绝'}，不能重复操作`);
    }
  }
}
