import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDefinition } from '@one/core';
import type { MemoryWorkspace } from '../memory.js';
import { MEMORY_EVENT_TYPES, type MemoryScope, type MemorySource } from '../events/catalog.js';
import { readMemorySettings } from '../config/memory-settings.js';
import type { MemoryRecord } from '../views/memory-view.js';

/**
 * 记忆领域工具（DESIGN.md §4 宪法：触碰记忆数据的唯一通道，人与 AI 共用）。
 *
 * 护栏模式（write 工具三步，与 wms 领域一致）：
 *  1. ws.sync()——校验前先追账，投影读到的是最新事实；
 *  2. 业务校验——内容非空且 ≤500 字 / scope 枚举 / 总量上限 / 遗忘对象存在；
 *  3. ctx.appendEvent——事件落账后再 sync()，返回值携带新状态。
 * 校验失败绝不落事件。
 *
 * source 不开放为工具参数（防伪标）：由 handler 从审计 actor 推导——
 * 'ai:memory-auto@…' → auto（后台提取）、'ai:*' → ai（对话中显式记录）、
 * 其余 → manual（人工界面）。
 */

/** 工作区解析器（与 wms 工具同模式：handler 按调用上下文的工作区取门面） */
export type MemoryWorkspaceResolver = (workspaceId: string) => MemoryWorkspace;

/** 工具定义包装器：handler 参数逆变位置的集中受控窄化（与 wms 的 tool-def 同模式） */
function def<P>(tool: ToolDefinition<P>): ToolDefinition {
  return { ...tool, handler: (params: unknown, ctx: ToolContext) => tool.handler(params as P, ctx) };
}

/** 记忆内容长度上限（字符） */
export const MAX_MEMORY_CONTENT_LENGTH = 500;

function sourceOfActor(actor: string): MemorySource {
  if (actor.startsWith('ai:memory-auto')) return 'auto';
  if (actor.startsWith('ai:')) return 'ai';
  return 'manual';
}

/** 记录的对外形状（createdAt 省略——消费方只关心内容与更新时间） */
function toOut(r: MemoryRecord): { memoryId: string; scope: MemoryScope; content: string; source: MemorySource; updatedAt: string } {
  return { memoryId: r.id, scope: r.scope, content: r.content, source: r.source, updatedAt: r.updatedAt };
}

export function createMemoryTools(resolveWorkspace: MemoryWorkspaceResolver): ToolDefinition[] {
  const memoryList: ToolDefinition<{ scope?: MemoryScope }> = {
    id: 'memory.list',
    label: '记忆清单',
    description:
      '列出当前保存的长期记忆。每条记忆带 memoryId、scope（personal=用户个人偏好/习惯，project=本仓库业务事实/约定）、内容与来源。scope 可选过滤。遗忘指定记忆时需要 memoryId。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['personal', 'project'],
          description: '按层过滤（可选）：personal=个人偏好，project=业务约定',
        },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      return ws.memory.list(params.scope).map(toOut);
    },
  };

  const memorySave: ToolDefinition<{ scope: MemoryScope; content: string }> = {
    id: 'memory.save',
    label: '保存记忆',
    description:
      '保存一条长期记忆（用户明确要求记住某信息，或提取到值得长期记住的关键信息时使用）。scope 选择分层：personal=用户个人偏好/习惯（如称呼、回复风格、常用操作方式），project=本仓库业务事实/约定（如商品特性、供应商约定、流程惯例）。content 用一句完整的话描述，只记单条事实；同主题修正时先 forget 旧条再 save 新条。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['personal', 'project'],
          description: '记忆分层：personal=用户个人偏好/习惯，project=本仓库业务事实/约定',
        },
        content: {
          type: 'string',
          description: `记忆内容，一句完整的话描述单条事实（不超过 ${MAX_MEMORY_CONTENT_LENGTH} 字）`,
        },
      },
      required: ['scope', 'content'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (params.scope !== 'personal' && params.scope !== 'project') {
        throw new Error('TOOL_REJECTED: scope 只能是 personal 或 project');
      }
      const content = typeof params.content === 'string' ? params.content.trim() : '';
      if (!content) {
        throw new Error('TOOL_REJECTED: content 不能为空白字符串');
      }
      if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
        throw new Error(
          `TOOL_REJECTED: content 长度 ${content.length} 超过上限 ${MAX_MEMORY_CONTENT_LENGTH} 字（拆成多条单事实记忆）`,
        );
      }
      const { maxMemoryItems } = readMemorySettings(ws);
      if (ws.memory.count() >= maxMemoryItems) {
        throw new Error(
          `TOOL_REJECTED: 记忆总量已达上限 ${maxMemoryItems} 条——先用 memory.forget 遗忘过时记忆，或在「AI 记忆」管理页清理`,
        );
      }
      const memoryId = randomUUID();
      const source = sourceOfActor(ctx.actor);
      ctx.appendEvent(MEMORY_EVENT_TYPES.itemSaved, {
        memoryId,
        scope: params.scope,
        content,
        source,
      });
      ws.sync();
      const r = ws.memory.byId(memoryId);
      if (!r) throw new Error('MEMORY_PROJECTION_MISS: 事件已落账但投影未命中（数据不一致）');
      return toOut(r);
    },
  };

  const memoryForget: ToolDefinition<{ memoryId: string }> = {
    id: 'memory.forget',
    label: '遗忘记忆',
    description:
      '删除一条长期记忆（用户明确要求忘掉某信息，或发现某条记忆已过时/错误时使用）。memoryId 从 memory.list 或记忆清单上下文中获取。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: '要遗忘的记忆 id（memory.list 返回的 memoryId）' },
      },
      required: ['memoryId'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (typeof params.memoryId !== 'string' || !params.memoryId) {
        throw new Error('TOOL_REJECTED: memoryId 不能为空');
      }
      if (!ws.memory.byId(params.memoryId)) {
        throw new Error(`TOOL_REJECTED: 记忆 ${params.memoryId} 不存在（可能已被遗忘）`);
      }
      ctx.appendEvent(MEMORY_EVENT_TYPES.itemForgotten, { memoryId: params.memoryId });
      ws.sync();
      return { forgotten: true, memoryId: params.memoryId };
    },
  };

  return [def(memoryList), def(memorySave), def(memoryForget)];
}
