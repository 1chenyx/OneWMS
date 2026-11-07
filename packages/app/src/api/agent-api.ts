import { request } from './request';

/** 与 @one/ai 的 AgentDefinition 同形（前端镜像 HTTP 契约，不依赖 ai 包类型） */
export interface AgentDef {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  /** v2 预留（管理页灰显）：助手按角色分配 */
  allowedRoles?: string[];
}

/** GET /api/agents 响应：定义清单 + 工具总线目录（管理页勾选授权的数据源） */
export interface AgentCatalog {
  agents: AgentDef[];
  tools: { id: string; label: string; description: string; permission: 'read' | 'write' }[];
}

/** 前端提交的配置体（apiKey 留空且接入方式与 Base URL 未变时，服务端沿用已保存密钥） */
export interface AiConfigInput {
  kind: 'openai-compatible' | 'ollama';
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/** 已保存的一条模型（GET 不含密钥明文） */
export interface AiProfilePublic {
  id: string;
  vendorId: string;
  label: string;
  kind: 'openai-compatible' | 'ollama';
  model: string;
  baseUrl: string;
  apiKeySet: boolean;
  active: boolean;
}

/** POST /api/ai-config/profiles：一次可加同一厂商的多个模型 */
export interface AiProfileWrite {
  vendorId: string;
  label: string;
  kind: 'openai-compatible' | 'ollama';
  baseUrl?: string;
  apiKey?: string;
  models: string[];
  activate?: boolean;
}

/** GET/PUT/DELETE /api/ai-config 响应：脱敏状态（apiKey 只报 apiKeySet 不回传明文） */
export interface AiConfigStatus {
  configured: boolean;
  /** file = 页面配置（优先）/ env = 启动环境变量 / none = 未配置 */
  source: 'file' | 'env' | 'none';
  config?: {
    kind: 'openai-compatible' | 'ollama';
    model: string;
    /** 生效端点（ollama 未填时回显本机缺省） */
    baseUrl: string;
    apiKeySet: boolean;
    id?: string;
    vendorId?: string;
    label?: string;
  };
  /** 页面上保存的模型。环境变量来的配置不在这里。 */
  profiles?: AiProfilePublic[];
}

/** POST /api/ai-config/test 响应（200 包结果——测试失败不是请求失败） */
export interface AiTestResult {
  ok: boolean;
  model: string;
  latencyMs?: number;
  reply?: string;
  message?: string;
}

export const agentApi = {
  /** 定义清单 + 工具目录（readAgentDefs 的配置面或内置兜底，server 现算） */
  agents: () => request<AgentCatalog>('/api/agents'),
  /** 提议更新助手定义（整体替换 settings.agents；慢通道，需人工确认） */
  proposeAgents: (agents: AgentDef[], note?: string) =>
    request<{ proposalId: string }>('/api/agents/propose', {
      method: 'POST',
      body: JSON.stringify({ agents, note }),
    }),
  /** 状态卡：configured/source + 脱敏配置（apiKey 不回传明文） */
  aiConfig: () => request<AiConfigStatus>('/api/ai-config'),
  /** 保存并热生效（写配置文件 + 重建 provider；响应即新状态） */
  saveAiConfig: (body: AiConfigInput) =>
    request<AiConfigStatus>('/api/ai-config', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** 关闭 AI（删页面配置；启动 env 配置仍在则回落 env） */
  clearAiConfig: () =>
    request<AiConfigStatus>('/api/ai-config', {
      method: 'DELETE',
    }),
  /** 当前接入点上可选的模型名（失败时至少包含正在用的那个） */
  aiModels: () => request<{ models: string[] }>('/api/ai-config/models'),
  /** 追加一条或多条，不冲掉已经保存的其他模型 */
  addAiProfiles: (body: AiProfileWrite) =>
    request<AiConfigStatus>('/api/ai-config/profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 把已保存的某一条设为对话正在用的模型 */
  activateAiProfile: (id: string) =>
    request<AiConfigStatus>(`/api/ai-config/profiles/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
    }),
  /** 移除一条；删光则回落环境变量或关闭 */
  deleteAiProfile: (id: string) =>
    request<AiConfigStatus>(`/api/ai-config/profiles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /**
   * 连通测试。body 缺省测当前生效配置；
   * 带 profileId 测已保存的那条（不必再把密钥发一遍）。
   */
  testAiConfig: (body?: Partial<AiConfigInput> & { profileId?: string }) =>
    request<AiTestResult>('/api/ai-config/test', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
};
