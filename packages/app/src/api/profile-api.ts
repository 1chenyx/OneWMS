import type { ProfileSnapshot, Proposal, ProposalSummary } from '@one/core';
import { request } from './request';

export interface ConfirmResponse {
  newVersion: number;
  appliedOps: number;
}

export const profileApi = {
  profileSnapshot: () => request<ProfileSnapshot>('/api/profile/snapshot'),
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
