import type { ProfileSnapshot, Proposal, ProposalSummary } from '@one/core';
import { request } from './request';

export interface ConfirmResponse {
  newVersion: number;
  appliedOps: number;
}

/** 慢通道影响报告（M21：profile.propose 工具返回体） */
export interface ProposeResponse {
  proposalId: string;
  report: {
    summary: string;
    items: { severity: 'info' | 'warning'; kind: string; target: string; description: string }[];
  };
  pendingConfirm: boolean;
  hint: string;
}

/** 已安装模块的展示目录。不含工具和参数，只给流程页读名字、说明和贡献。 */
export interface ProfileCatalogModule {
  id: string;
  name: string;
  description: string;
  system: boolean;
  contributions: {
    workflowKey: string;
    states: { id: string; label: string }[];
    transitions: { from: string; to: string; when?: string; effect?: 'increase' | 'decrease' | 'check' | 'none' }[];
  }[];
}

export interface ProfileCatalog {
  modules: ProfileCatalogModule[];
}

export const profileApi = {
  profileSnapshot: () => request<ProfileSnapshot>('/api/profile/snapshot'),
  /** 已安装模块的名字、说明和流程贡献（流程页、模块页） */
  profileCatalog: () => request<ProfileCatalog>('/api/profile/catalog'),
  /** 提议配置变更（流程页、模块页入口；AI 走工具总线，同一队列同一确认界面） */
  proposeProfile: (
    patch: { op: string; path: string; value?: unknown }[],
    note?: string,
  ) =>
    request<ProposeResponse>('/api/profile/propose', {
      method: 'POST',
      body: JSON.stringify({ patch, note }),
    }),
  proposals: () => request<ProposalSummary[]>('/api/proposals'),
  proposalDetail: (id: string) => request<Proposal>(`/api/proposals/${id}`),
  confirmProposal: (id: string, by?: string) =>
    request<ConfirmResponse>(`/api/proposals/${id}/confirm`, {
      method: 'POST',
      // by 缺省由服务端补全 user:local@nodeId（本地界面确认，审计可辨）
      body: JSON.stringify(by === undefined ? {} : { by }),
    }),
  rejectProposal: (id: string) =>
    request<{ ok: boolean }>(`/api/proposals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};
