import { randomUUID } from 'node:crypto';
import { ProposalNotFoundError, ProposalStateError } from '../errors.js';
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

export interface Proposal {
  proposalId: string;
  workspaceId: string;
  /** 提议者：'ai:模型名' / 节点 id / 未来用户身份 */
  proposedBy: string;
  /** 提议说明（AI 给出的意图描述，进确认界面） */
  note?: string;
  patch: PatchOp[];
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
  baseVersion: number;
  summary: string;
  status: ProposalStatus;
  createdAt: string;
}

export class ProposalStore {
  #proposals = new Map<string, Proposal>();

  create(params: {
    workspaceId: string;
    proposedBy: string;
    note?: string;
    patch: PatchOp[];
    baseVersion: number;
    baseFieldFingerprint: string;
    report: ImpactReport;
  }): Proposal {
    const proposal: Proposal = {
      proposalId: randomUUID(),
      workspaceId: params.workspaceId,
      proposedBy: params.proposedBy,
      note: params.note,
      patch: params.patch,
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
      .map(({ proposalId, proposedBy, note, baseVersion, report, status, createdAt }) => ({
        proposalId,
        proposedBy,
        note,
        baseVersion,
        summary: report.summary,
        status,
        createdAt,
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
