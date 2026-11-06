import { request } from './request';

/**
 * AI 记忆端点（前端镜像 HTTP 契约，不依赖 @one/memory 运行时）。
 * 读写分治：读直查投影；写走工具总线（server 端护栏 + 审计）；
 * 设置改动走慢通道（propose → 人工确认）。
 */

/** 记忆条目（GET /api/memory 响应项；与 @one/memory 的 MemoryRecord 同形） */
export interface MemoryItem {
  id: string;
  scope: 'personal' | 'project';
  content: string;
  source: 'auto' | 'ai' | 'manual';
  createdAt: string;
  updatedAt: string;
}

/** 当前生效的记忆设置（server 窄化兜底后的值） */
export interface MemorySettings {
  autoMemory: boolean;
  maxMemoryItems: number;
}

/** GET /api/memory 响应：记忆清单（scope 过滤后）+ 生效设置 */
export interface MemoryListResponse {
  memories: MemoryItem[];
  settings: MemorySettings;
}

export const memoryApi = {
  /** 记忆清单 + 生效设置（scope 可选过滤 personal / project） */
  memories: (scope?: 'personal' | 'project') =>
    request<MemoryListResponse>(scope ? `/api/memory?scope=${scope}` : '/api/memory'),
  /** 手动保存一条记忆（经工具总线，source=manual） */
  createMemory: (body: { scope: 'personal' | 'project'; content: string }) =>
    request<MemoryItem>('/api/memory', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 遗忘一条记忆（经工具总线） */
  forgetMemory: (memoryId: string) =>
    request<{ forgotten: boolean; memoryId: string }>(`/api/memory/${encodeURIComponent(memoryId)}/forget`, {
      method: 'POST',
      body: '{}',
    }),
  /** 提议更新记忆设置（慢通道，需人工确认） */
  proposeMemorySettings: (body: { autoMemory?: boolean; maxMemoryItems?: number }, note?: string) =>
    request<{ proposalId: string }>('/api/memory/settings/propose', {
      method: 'POST',
      body: JSON.stringify({ ...body, note }),
    }),
};
