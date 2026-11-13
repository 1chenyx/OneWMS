import { request } from './request';
import type { ProposeResponse } from './profile-api';

/**
 * AI 记忆端点（前端镜像 HTTP 契约，不依赖 @one/memory 运行时）。
 *
 * 记忆形态是「章节级 markdown 账本」：每节 = 标题 + 摘要 + 关键词 + 正文，
 * 而不是一条条散句——人能像读文档一样读它，AI 也能按需只取某节全文。
 *
 * 读写分治：读直查投影（一次拿全清单 + 生效设置 + AI 常驻段 T0）；写走工具
 * 总线（server 端护栏 + 审计），并以 baseLamport 做乐观并发令牌——章节被别人
 * 写过就拒绝，避免两边互相覆盖；设置改动走慢通道（propose → 人工确认）。
 */

export type MemoryScope = 'personal' | 'project';

/** 章节（GET /api/memory 响应项；与 server 的 SectionOut 同形） */
export interface MemorySection {
  id: string;
  scope: MemoryScope;
  /** 章节自然键（小写字母/数字/连字符，AI 与人共用；legacy-* 是 v1 收容章节） */
  sectionKey: string;
  title: string;
  /** 正文（markdown，一行一个要点） */
  bodyMd: string;
  /** 一句话摘要（常驻目录里代替全文出现） */
  summary: string;
  /** 检索关键词（AI 按需预取的判据） */
  keywords: string[];
  /** 乐观并发令牌：写回时原样回传，服务端比对不一致即拒绝 */
  baseLamport: number;
  /** 最后写入方（user:local@node / ai:…，审计可辨人写还是 AI 写） */
  lastActor: string;
  lines: number;
  createdAt: string;
  updatedAt: string;
}

/** 当前生效的记忆设置（server 窄化兜底后的值） */
export interface MemorySettings {
  autoMemory: boolean;
  /** 章节总数上限（达到后拒绝新建章节，仍可写既有章节） */
  maxSections: number;
}

/** AI 每轮对话常驻看到的记忆段（T0）：personal 全文 + project 目录 */
export interface ResidentMemory {
  text: string;
  /** 任一层超预算 */
  overflow: boolean;
  /** 用户画像全文超预算（不截断，截断会让偏好随机失效） */
  personalOverflow: boolean;
  /** 业务约定目录超预算（同样不截断） */
  projectOverflow: boolean;
}

/** GET /api/memory 响应：章节清单（scope 过滤后）+ 生效设置 + 常驻段 */
export interface MemoryLedgerResponse {
  sections: MemorySection[];
  settings: MemorySettings;
  resident: ResidentMemory;
}

/** 章节的一个历史版本（GET /api/memory/history 响应项，最新在前） */
export interface MemoryHistoryEntry {
  lamport: number;
  /** 写入类型（append / rewrite / remove…） */
  type: string;
  actor: string;
  createdAt: string;
  title: string;
  bodyMd: string;
  summary: string;
  keywords: string[];
}

/** 单个 scope 的整理结果（consolidate 会调大模型，failed 列出没能归并的章节） */
export interface MemoryConsolidateScopeResult {
  scope: MemoryScope;
  rewritten: number;
  created: number;
  removed: number;
  failed: { sectionKey: string; message: string }[];
  /** 超过单次上限、留到下次整理的章节数 */
  deferred: number;
}

export interface MemoryConsolidateResult {
  scopes: MemoryConsolidateScopeResult[];
}

/** POST /api/memory/rewrite 入参（baseLamport 必填：无令牌的覆盖会被拒） */
export interface MemoryRewriteInput {
  scope: MemoryScope;
  sectionKey: string;
  title: string;
  bodyMd: string;
  summary?: string;
  keywords?: string[];
  baseLamport: number;
}

export const memoryApi = {
  /** 章节账本 + 生效设置 + AI 常驻段（scope 可选过滤 personal / project） */
  memoryLedger: (scope?: MemoryScope) =>
    request<MemoryLedgerResponse>(scope ? `/api/memory?scope=${scope}` : '/api/memory'),
  /** 追加一行要点到某节（经工具总线 memory.append；节不存在则按 title 新建） */
  appendMemory: (body: { scope: MemoryScope; sectionKey: string; title?: string; text: string }) =>
    request<MemorySection>('/api/memory', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 整节覆盖（经工具总线 memory.rewrite；baseLamport 冲突即拒绝） */
  rewriteMemory: (body: MemoryRewriteInput) =>
    request<MemorySection>('/api/memory/rewrite', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 删除整节（经工具总线 memory.remove；同样要令牌） */
  removeMemory: (body: { scope: MemoryScope; sectionKey: string; baseLamport: number }) =>
    request<{ removed: boolean; scope: MemoryScope; sectionKey: string }>('/api/memory/remove', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 某节的历史版本（最新在前，最多 50 条）——回滚 = 取旧正文用当前令牌重写 */
  memoryHistory: (scope: MemoryScope, sectionKey: string) =>
    request<{ entries: MemoryHistoryEntry[] }>(
      `/api/memory/history?scope=${scope}&sectionKey=${encodeURIComponent(sectionKey)}`,
    ),
  /** 让 AI 整理归并（省略 scope = 两层都整理；会调大模型，可能十几秒） */
  consolidateMemory: (scope?: MemoryScope) =>
    request<MemoryConsolidateResult>('/api/memory/consolidate', {
      method: 'POST',
      body: JSON.stringify(scope ? { scope } : {}),
    }),
  /** 提议更新记忆设置（慢通道，需人工确认后生效） */
  proposeMemorySettings: (
    body: { autoMemory?: boolean; maxSections?: number },
    note?: string,
  ) =>
    request<ProposeResponse>('/api/memory/settings/propose', {
      method: 'POST',
      body: JSON.stringify({ ...body, note }),
    }),
};
