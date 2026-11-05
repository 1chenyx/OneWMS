import type { ModuleManifest } from '@one/core';
import type { WmsWorkspace } from '@one/wms';

/**
 * Agent 定义契约（M16：AI 助手多实例化——「使用 AI」与「配置 AI」分离）。
 *
 * 真相源分治：定义存 Profile 配置层（core.ai 模块 settings.agents，慢通道可写：
 * propose → confirm），读取方窄化 + 兜底（脏面防御，与 readWmsSettings 同模式）——
 * 未配置 / 清空 / 全部非法 → 回退内置三件套（general / readonly / config），
 * 零种子事件，符合「未配置 = 缺省」惯例。
 *
 * 权限语义（三件套的关键矩阵，M16 拍板）：
 *  - general：全量工具 − profile.propose（业务读写，不能改配置）；
 *  - readonly：仅 permission='read' 的工具；
 *  - config：read 全量 + profile.propose（能提议配置，无业务写）。
 * 「改配置」是高权限动作：使用 AI（对话）与配置 AI（管理页）分属不同通道。
 */

/** core.ai 模块 id（settings.agents 的落点；区别于审计 actor 前缀 'ai:{id}'） */
export const AI_MODULE_ID = 'core.ai';

/** 工具元数据最小面（内置三件套的装配输入；handler 不可见——AI 上下文安全） */
export interface AgentToolRef {
  id: string;
  permission: 'read' | 'write';
}

export interface AgentDefinition {
  /** 助手 id（稳定标识：chat 请求的 agentId、审计 actor 'ai:{id}'） */
  id: string;
  /** 展示名（前端切换器 / 管理页） */
  name: string;
  /** 一句话职责说明（切换器 / 管理页的辅助文案） */
  description: string;
  /** 人设前缀：置于全局 System Prompt 之前（定制人设，全局纪律不删减） */
  systemPrompt: string;
  /**
   * 工具授权清单（元素取自工具总线 id，装配时过滤总线在场项）。
   * 预留 'agent:<id>' 形态 = 委托给另一 agent 执行（多 AI 协作，v2 生长点）
   * ——v1 装配遇此形态直接抛错（见 createAgentFromDef）。
   */
  tools: string[];
  /** 模型覆盖（如 'qwen3:8b'）：缺省用进程级 AI 配置 */
  model?: string;
  /**
   * 可使用的角色/用户清单（v2 预留：助手按角色分配）。v1 不消费——
   * 字段仅透传保存，管理界面灰显「预留」。
   */
  allowedRoles?: string[];
}

/**
 * 内置三件套（代码缺省）：工具矩阵按总线现状展开——将来新增工具自动进入
 * general（新业务工具）与 readonly / config（新读工具），内置定义无需跟进维护。
 */
export function builtinAgentDefs(toolRefs: readonly AgentToolRef[]): AgentDefinition[] {
  const readIds = toolRefs.filter((t) => t.permission === 'read').map((t) => t.id);
  const configTools = toolRefs.some((t) => t.id === 'profile.propose')
    ? [...readIds, 'profile.propose']
    : readIds;
  return [
    {
      id: 'general',
      name: '通用助手',
      description: '查询与出入库操作（默认）',
      systemPrompt: '你是通用仓库助手：可以查询库存、管理 SKU 与单据、执行出入库操作。',
      tools: toolRefs.filter((t) => t.id !== 'profile.propose').map((t) => t.id),
    },
    {
      id: 'readonly',
      name: '只读助手',
      description: '仅查询，不修改任何数据',
      systemPrompt: '你是只读查询助手：只回答关于库存、单据、配置现状的问题，不修改任何数据。',
      tools: readIds,
    },
    {
      id: 'config',
      name: '配置助手',
      description: '查询 + 起草配置变更提议（由用户确认生效）',
      systemPrompt: '你是配置助手：帮助用户查看现状并起草配置变更提议。提议必须由用户亲自确认后才生效。',
      tools: configTools,
    },
  ];
}

/** 脏面窄化：settings.agents 的单项 → AgentDefinition（非法项返回 undefined 丢弃） */
function asAgentDef(raw: unknown): AgentDefinition | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return undefined;
  if (typeof r.name !== 'string' || !r.name.trim()) return undefined;
  if (typeof r.systemPrompt !== 'string') return undefined;
  if (!Array.isArray(r.tools) || r.tools.some((t) => typeof t !== 'string')) return undefined;
  return {
    id: r.id,
    name: r.name,
    description: typeof r.description === 'string' ? r.description : '',
    systemPrompt: r.systemPrompt,
    tools: r.tools as string[],
    model: typeof r.model === 'string' && r.model.trim() ? r.model : undefined,
  };
}

/**
 * 读助手定义清单：core.ai settings.agents（配置面）→ 内置三件套（缺省面）。
 * 配置了但全部非法 / 清空 = 恢复内置（与「未配置」同归）。重复 id 保留先到者（确定性）。
 */
export function readAgentDefs(ws: WmsWorkspace): AgentDefinition[] {
  const raw = ws.profile.getSnapshot().modules[AI_MODULE_ID]?.settings?.agents;
  if (!Array.isArray(raw)) return builtinAgentDefs(ws.tools.list());

  const defs: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const def = asAgentDef(item);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    defs.push(def);
  }
  return defs.length > 0 ? defs : builtinAgentDefs(ws.tools.list());
}

/**
 * core.ai 模块 manifest（M16）：纯配置载体——不注册工具、不 provide 字段，
 * 只声明 settings.agents 键。default: [] 使 install 种子写入 agents 键
 * （空清单 = 内置兜底），慢通道的 replace 路径永远可用（目标键在场）。
 * 安装时机：server 装配（createAppContext，幂等——同版本零事件）。
 */
export function aiModuleManifest(): ModuleManifest {
  return {
    id: AI_MODULE_ID,
    name: 'AI 助手',
    description:
      'AI 助手定义（多实例）：每个 agent = 人设 + 工具授权 + 可选模型覆盖，前端可切换。' +
      '定义存本模块 settings.agents，改动走配置慢通道（propose → confirm）。',
    version: '0.1.0',
    capabilities: [],
    settings: {
      schema: {
        type: 'object',
        properties: {
          agents: {
            type: 'array',
            description:
              '助手定义清单（整体替换）：每项 { id, name, description, systemPrompt, tools, model?, allowedRoles? }，' +
              'tools 取工具总线 id（GET /api/agents 返回 tools 目录）。清单为空或全部非法时回退内置三件套' +
              '（general / readonly / config）',
            default: [],
          },
        },
      },
    },
  };
}
