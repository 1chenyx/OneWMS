import { Hono } from 'hono';
import {
  MEMORY_EVENT_TYPES,
  SECTION_KEY_PATTERN,
  bodyLineCount,
  readMemorySettings,
  type MemorySection,
  type MemorySectionUpdatedPayload,
  type MemoryScope,
} from '@one/memory';
import type { AppContext } from '../context.js';
import { resolveActor } from '../actor.js';
import { runMemoryConsolidation } from '../memory-consolidate.js';

/**
 * AI 记忆管理端点（章节级 markdown 账本；读写分治，契约同 wms.ts / agents.ts）：
 *  - GET  /                  读 = 直查章节投影 + 当前生效设置 + T0 常驻段预览；
 *  - POST /                  写 = 经工具总线 memory.append（低摩擦追加一行）；
 *  - POST /rewrite           写 = 经工具总线 memory.rewrite（整节覆盖，带令牌）；
 *  - POST /remove            写 = memory.rewrite 且正文留空（删除也是章节写入的一种结果，
 *                            不再多一个工具——语义与 AI 对话中删节完全一致）；
 *  - GET  /history           读 = 扫事件账本还原某节的历史版本（事件是唯一真相，
 *                            投影只留最新态，历史只能从账本读）；
 *  - POST /consolidate       「整理」= 同步执行归并计划（planConsolidation → rewrite）；
 *  - POST /settings/propose  设置改动走慢通道（profile.propose → 人工确认，
 *                            与 AI/助手定义同一条通道——配置变更铁律）。
 * 人操作 actor = user:local@{nodeId}（source 推导为 'manual'，与 AI 通道审计可辨）。
 * 工具抛错直接冒泡给 apiErrorHandler（TOOL_REJECTED → 400 + code），此处不重复翻译。
 */

/** /history 的返回上限（管理页只看最近若干版；账本本身不截断） */
const HISTORY_LIMIT = 50;

interface HistoryEntry {
  lamport: number;
  type: string;
  actor: string;
  createdAt: string;
  title: string;
  bodyMd: string;
  summary: string;
  keywords: string[];
}

function readScope(raw: unknown): MemoryScope | undefined {
  return raw === 'personal' || raw === 'project' ? raw : undefined;
}

/** 章节的对外形状（管理页表格与编辑器共用；lines 让列表不必回传全文即可显示规模） */
function toSectionOut(s: MemorySection) {
  return {
    id: s.id,
    scope: s.scope,
    sectionKey: s.sectionKey,
    title: s.title,
    bodyMd: s.bodyMd,
    summary: s.summary,
    keywords: [...s.keywords],
    baseLamport: s.baseLamport,
    lastActor: s.lastActor,
    lines: bodyLineCount(s.bodyMd),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function memoryRoutes(ctx: AppContext): Hono {
  return new Hono()
    .get('/', (c) => {
      const scope = readScope(c.req.query('scope'));
      ctx.memory.sync(); // 读前追账（同步/后台提取可能落后投影）
      return c.json({
        sections: ctx.memory.sections.list(scope).map(toSectionOut),
        settings: readMemorySettings(ctx.memory),
        // 常驻段恒为 personal+project 全量渲染（忽略 scope 过滤）：
        // 管理页要预览的是「AI 实际常驻看到什么」，按层过滤反而失真
        resident: ctx.memory.sections.resident(),
      });
    })
    .post('/', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        scope?: unknown;
        sectionKey?: unknown;
        title?: unknown;
        text?: unknown;
      };
      const result = await ctx.ws.tools.invoke(
        'memory.append',
        { scope: body.scope, sectionKey: body.sectionKey, title: body.title, text: body.text },
        resolveActor(ctx, c),
      );
      return c.json(result, 201);
    })
    .post('/rewrite', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        scope?: unknown;
        sectionKey?: unknown;
        title?: unknown;
        bodyMd?: unknown;
        summary?: unknown;
        keywords?: unknown;
        baseLamport?: unknown;
      };
      return c.json(
        await ctx.ws.tools.invoke(
          'memory.rewrite',
          {
            scope: body.scope,
            sectionKey: body.sectionKey,
            title: body.title,
            bodyMd: body.bodyMd,
            summary: body.summary,
            keywords: body.keywords,
            baseLamport: body.baseLamport,
          },
          resolveActor(ctx, c),
        ),
      );
    })
    .post('/remove', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        scope?: unknown;
        sectionKey?: unknown;
        baseLamport?: unknown;
      };
      const scope = readScope(body.scope);
      const sectionKey = typeof body.sectionKey === 'string' ? body.sectionKey.trim() : '';
      if (!scope || !SECTION_KEY_PATTERN.test(sectionKey)) {
        return c.json({ code: 'BAD_REQUEST', message: 'scope 与 sectionKey 无效' }, 400);
      }
      ctx.memory.sync(); // 取标题前先追账：投影落后会把在场的章节误判为不存在
      const existing = ctx.memory.sections.byKey(scope, sectionKey);
      if (!existing) return c.json({ code: 'NOT_FOUND', message: `章节 ${sectionKey} 不存在` }, 400);
      // 正文留空 = 删除；title 仍须传该节现有标题（工具把它当必填校验）
      return c.json(
        await ctx.ws.tools.invoke(
          'memory.rewrite',
          { scope, sectionKey, title: existing.title, bodyMd: '', baseLamport: body.baseLamport },
          resolveActor(ctx, c),
        ),
      );
    })
    .get('/history', (c) => {
      const scope = readScope(c.req.query('scope'));
      const sectionKey = (c.req.query('sectionKey') ?? '').trim();
      if (!scope || !SECTION_KEY_PATTERN.test(sectionKey)) {
        return c.json({ code: 'BAD_REQUEST', message: 'scope 与 sectionKey 必填且需合法' }, 400);
      }
      ctx.memory.sync();
      const entries: HistoryEntry[] = [];
      // EventsView 只暴露顺序遍历（无按类型/自然键的索引），本地库量级下全扫可接受
      ctx.memory.events.forEach((env) => {
        if (env.type !== MEMORY_EVENT_TYPES.sectionUpdated) return;
        const p = env.payload as MemorySectionUpdatedPayload;
        if (p.scope !== scope || p.sectionKey !== sectionKey) return;
        entries.push({
          lamport: env.lamport,
          type: env.type,
          actor: env.actor,
          createdAt: env.createdAt,
          title: p.title,
          bodyMd: p.bodyMd,
          summary: p.summary,
          keywords: [...(p.keywords ?? [])],
        });
      });
      return c.json({ entries: entries.reverse().slice(0, HISTORY_LIMIT) });
    })
    .post('/consolidate', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown };
      const provider = ctx.provider; // 当前生效的 AI 配置（与 chat 同一条通道）
      if (!provider) {
        return c.json(
          { code: 'AI_NOT_CONFIGURED', message: '未配置 AI，无法整理记忆（在「AI 模型」页面配置）' },
          400,
        );
      }
      const scope = body.scope === undefined ? undefined : readScope(body.scope);
      if (body.scope !== undefined && !scope) {
        return c.json({ code: 'BAD_REQUEST', message: 'scope 只能是 personal 或 project' }, 400);
      }
      const scopes = await runMemoryConsolidation(ctx, provider, { scope, actor: resolveActor(ctx, c) });
      return c.json({ scopes });
    })
    .post('/settings/propose', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        autoMemory?: unknown;
        maxSections?: unknown;
        note?: unknown;
      };
      // 只 patch 显式提供的键（autoMemory / maxSections 二选一或同时）
      const patch: { op: 'replace'; path: string; value: unknown }[] = [];
      if (body.autoMemory !== undefined) {
        if (typeof body.autoMemory !== 'boolean') {
          return c.json({ code: 'BAD_REQUEST', message: 'autoMemory 必须是布尔值' }, 400);
        }
        patch.push({ op: 'replace', path: '/modules/core.memory/settings/autoMemory', value: body.autoMemory });
      }
      if (body.maxSections !== undefined) {
        if (typeof body.maxSections !== 'number' || !Number.isInteger(body.maxSections) || body.maxSections < 1) {
          return c.json({ code: 'BAD_REQUEST', message: 'maxSections 必须是 ≥1 的整数' }, 400);
        }
        patch.push({
          op: 'replace',
          path: '/modules/core.memory/settings/maxSections',
          value: body.maxSections,
        });
      }
      if (patch.length === 0) {
        return c.json(
          { code: 'BAD_REQUEST', message: '至少提供 autoMemory 或 maxSections 之一' },
          400,
        );
      }
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : '更新 AI 记忆设置';
      const result = await ctx.ws.tools.invoke(
        'profile.propose',
        { patch, note },
        resolveActor(ctx, c),
      );
      return c.json(result, 201);
    });
}
