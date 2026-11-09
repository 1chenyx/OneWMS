import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDefinition } from '@one/core';
import type { MemoryWorkspace } from '../memory.js';
import {
  MEMORY_EVENT_TYPES,
  SECTION_KEY_PATTERN,
  type MemoryScope,
} from '../events/catalog.js';
import { readMemorySettings } from '../config/memory-settings.js';
import { bodyLineCount } from '../render.js';
import type { MemorySection } from '../views/memory-view.js';

/**
 * 记忆领域工具（DESIGN.md §4 宪法：触碰记忆数据的唯一通道，人与 AI 共用）。
 *
 * 三件套对应三层注入的写侧：
 *  - memory.read    目录（无参）/ 某节全文（带 sectionKey）——T1 按需读；
 *  - memory.append  往某节追加一行——低摩擦、免并发令牌（追加天然可交换）；
 *  - memory.rewrite 整节覆盖（含摘要与关键词重算）——归并/纠错/压缩走这里，
 *                   必须带 baseLamport 乐观并发令牌；正文留空 = 删除整节。
 *
 * 护栏模式（write 工具三步，与 wms 领域一致）：
 *  1. ws.sync()——校验前先追账，投影读到的是最新事实（也是令牌比对的基准）；
 *  2. 业务校验——键名规则 / 长度上限 / 章节数上限 / 并发令牌；
 *  3. ctx.appendEvent——事件落账后再 sync()，返回值携带新状态。
 * 校验失败绝不落事件（错误消息 `TOOL_REJECTED: ` 前缀）。
 */

/** 工作区解析器（与 wms 工具同模式：handler 按调用上下文的工作区取门面） */
export type MemoryWorkspaceResolver = (workspaceId: string) => MemoryWorkspace;

/** 工具定义包装器：handler 参数逆变位置的集中受控窄化（与 wms 的 tool-def 同模式） */
function def<P>(tool: ToolDefinition<P>): ToolDefinition {
  return { ...tool, handler: (params: unknown, ctx: ToolContext) => tool.handler(params as P, ctx) };
}

/** append 单次追加文本上限（字符）——追加是「记一条」，不是「写一篇」 */
export const MAX_APPEND_TEXT_LENGTH = 500;
/** 单节正文上限（字符）：超出必须 rewrite 归并压缩，不许无限膨胀 */
export const MAX_SECTION_BODY_LENGTH = 6000;
export const MAX_TITLE_LENGTH = 60;
export const MAX_SUMMARY_LENGTH = 120;
export const MAX_KEYWORDS = 8;
export const MAX_KEYWORD_LENGTH = 16;

const SCOPE_KEYS: readonly MemoryScope[] = ['personal', 'project'];

function isScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (SCOPE_KEYS as readonly string[]).includes(v);
}

function reject(msg: string): never {
  throw new Error(`TOOL_REJECTED: ${msg}`);
}

function checkKey(sectionKey: unknown): string {
  if (typeof sectionKey !== 'string' || !SECTION_KEY_PATTERN.test(sectionKey)) {
    reject(
      'sectionKey 必须是小写字母/数字/连字符（首字符为字母或数字，2–48 位），如 sku-characteristics',
    );
  }
  return (sectionKey as string).trim();
}

function checkText(label: string, value: unknown, max: number, required = true): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (required) reject(`${label} 不能为空白`);
    return '';
  }
  if (text.length > max) reject(`${label} 长度 ${text.length} 超过上限 ${max} 字`);
  return text;
}

function checkKeywords(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) reject('keywords 必须是字符串数组');
  const out: string[] = [];
  for (const k of raw as unknown[]) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t) continue;
    if (t.length > MAX_KEYWORD_LENGTH) reject(`关键词「${t}」超过 ${MAX_KEYWORD_LENGTH} 字`);
    if (!out.includes(t)) out.push(t);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/**
 * 追加文本规整：单行且不是 markdown 结构行时补 `- ` 前缀（章节正文统一是
 * 要点列表 / 小标题混排，散句直接贴进去会让文档不成体统）。
 * 结构行 = 列表项（- * >）、ATX 小标题（# 到 ######，允许 1–6 个井号）、
 * 有序列表（1. / 1)）——只认一个井号会把 `## 标题` 补成 `- ## 标题`。
 */
function normalizeAppend(text: string): string {
  if (text.includes('\n')) return text.trim();
  return /^(#{1,6}|[-*>]|\d+[.)])\s/.test(text) ? text : `- ${text}`;
}

/** 章节的对外形状（read 目录模式省略 bodyMd——目录就是省 token 的手段） */
function toDirectoryEntry(s: MemorySection) {
  return {
    scope: s.scope,
    sectionKey: s.sectionKey,
    title: s.title,
    summary: s.summary,
    keywords: [...s.keywords],
    lines: bodyLineCount(s.bodyMd),
    baseLamport: s.baseLamport,
    updatedAt: s.updatedAt,
  };
}

function toFull(s: MemorySection) {
  return { ...toDirectoryEntry(s), bodyMd: s.bodyMd, lastActor: s.lastActor };
}

export function createMemoryTools(resolveWorkspace: MemoryWorkspaceResolver): ToolDefinition[] {
  const memoryRead: ToolDefinition<{ scope?: MemoryScope; sectionKey?: string }> = {
    id: 'memory.read',
    label: '读记忆',
    description:
      '读长期记忆。不带参数 = 章节目录（每节的 scope、sectionKey、标题、摘要、关键词、行数、baseLamport）；' +
      '带 sectionKey = 该节完整 markdown 正文（scope 可省略，自动在两层里找）。' +
      '系统提示常驻的只有目录，需要细节时先读全文再回答或改写。',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['personal', 'project'],
          description: '按层过滤（可选）：personal=用户偏好，project=业务约定',
        },
        sectionKey: {
          type: 'string',
          description: '章节键（可选）：给了就返回该节全文，不给则返回目录',
        },
      },
      required: [],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      const scope = params.scope !== undefined && params.scope !== null ? params.scope : undefined;
      if (scope !== undefined && !isScope(scope)) reject('scope 只能是 personal 或 project');
      const key = typeof params.sectionKey === 'string' ? params.sectionKey.trim() : '';
      if (!key) {
        const sections = ws.sections.list(scope);
        return {
          sections: sections.map(toDirectoryEntry),
          hint: '需要某节全文：memory.read 传 sectionKey；改写：memory.rewrite 带该节 baseLamport',
        };
      }
      const sectionKey = checkKey(key);
      const found =
        (scope ? ws.sections.byKey(scope, sectionKey) : undefined) ??
        ws.sections.byKey('personal', sectionKey) ??
        ws.sections.byKey('project', sectionKey);
      if (!found) {
        reject(`章节 ${sectionKey} 不存在（用 memory.read 不带参数查看现有目录）`);
      }
      return toFull(found);
    },
  };

  const memoryAppend: ToolDefinition<{
    scope: MemoryScope;
    sectionKey: string;
    title?: string;
    text: string;
  }> = {
    id: 'memory.append',
    label: '追加记忆',
    description:
      '往记忆章节追加一行要点（低摩擦写法，日常记录优先用它）。scope：personal=用户偏好/习惯，' +
      'project=本仓库业务事实/约定。sectionKey 用已有章节的键（memory.read 目录里有）；' +
      '没有合适的章节才起新键（小写连字符，如 supplier-agreements），新章节要给 title。' +
      'text 写一条完整事实。整节重写、纠错、压缩用 memory.rewrite。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['personal', 'project'],
          description: '记忆分层：personal=用户偏好/习惯，project=业务事实/约定',
        },
        sectionKey: { type: 'string', description: '章节键（小写字母/数字/连字符）' },
        title: { type: 'string', description: '章节标题（新建章节时建议提供，≤60 字）' },
        text: {
          type: 'string',
          description: `要追加的一条要点（≤${MAX_APPEND_TEXT_LENGTH} 字）`,
        },
      },
      required: ['scope', 'sectionKey', 'text'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!isScope(params.scope)) reject('scope 只能是 personal 或 project');
      const sectionKey = checkKey(params.sectionKey);
      const text = checkText('text', params.text, MAX_APPEND_TEXT_LENGTH);
      const existing = ws.sections.byKey(params.scope, sectionKey);
      if (!existing) {
        const { maxSections } = readMemorySettings(ws);
        if (ws.sections.count() >= maxSections) {
          reject(
            `记忆章节已达上限 ${maxSections} 节——先用 memory.rewrite 归并相近章节（正文留空即删除），或在「AI 记忆」管理页整理`,
          );
        }
      }
      const bodyMd = existing
        ? `${existing.bodyMd.trimEnd()}\n${normalizeAppend(text)}`
        : normalizeAppend(text);
      if (bodyMd.length > MAX_SECTION_BODY_LENGTH) {
        reject(
          `章节「${sectionKey}」正文将达 ${bodyMd.length} 字，超过单节上限 ${MAX_SECTION_BODY_LENGTH}——` +
            '先用 memory.rewrite 归并压缩本节（合并重复要点、删过时内容），再追加',
        );
      }
      const title = existing
        ? existing.title
        : checkText('title', params.title, MAX_TITLE_LENGTH, false) ||
          sectionKey.replaceAll('-', ' ');
      ctx.appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, {
        sectionId: existing?.id ?? randomUUID(),
        scope: params.scope,
        sectionKey,
        title,
        bodyMd,
        summary: existing?.summary ?? text.slice(0, MAX_SUMMARY_LENGTH),
        keywords: existing ? [...existing.keywords] : [],
      });
      ws.sync();
      const after = ws.sections.byKey(params.scope, sectionKey);
      if (!after) reject('事件已落账但投影未命中（数据不一致）');
      return toFull(after);
    },
  };

  const memoryRewrite: ToolDefinition<{
    scope: MemoryScope;
    sectionKey: string;
    title: string;
    bodyMd: string;
    summary?: string;
    keywords?: string[];
    baseLamport: number;
  }> = {
    id: 'memory.rewrite',
    label: '重写记忆章节',
    description:
      '整节覆盖一个记忆章节（归并、纠错、压缩、重算摘要与关键词都走这里）。' +
      '必须带 memory.read 返回的 baseLamport：章节被别人改过就拒绝，重新读取最新全文再改。' +
      'bodyMd 是该节完整 markdown 正文（不是增量）；留空 = 删除整节。' +
      'keywords 要含简称与别名（按需检索靠它命中），summary 一句话概括本节。',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['personal', 'project'],
          description: '记忆分层：personal=用户偏好/习惯，project=业务事实/约定',
        },
        sectionKey: { type: 'string', description: '章节键（改写既有章节须与目录一致）' },
        title: { type: 'string', description: `章节标题（≤${MAX_TITLE_LENGTH} 字）` },
        bodyMd: {
          type: 'string',
          description: `完整新正文（markdown，≤${MAX_SECTION_BODY_LENGTH} 字）；留空表示删除本节`,
        },
        summary: { type: 'string', description: `一句话摘要（≤${MAX_SUMMARY_LENGTH} 字）` },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: `检索关键词（≤${MAX_KEYWORDS} 个，含简称与别名）`,
        },
        baseLamport: {
          type: 'integer',
          description: '乐观并发令牌：memory.read 返回的 baseLamport；新建章节传 0',
        },
      },
      required: ['scope', 'sectionKey', 'title', 'bodyMd', 'baseLamport'],
    },
    handler: (params, ctx) => {
      const ws = resolveWorkspace(ctx.workspaceId);
      ws.sync();
      if (!isScope(params.scope)) reject('scope 只能是 personal 或 project');
      const sectionKey = checkKey(params.sectionKey);
      const existing = ws.sections.byKey(params.scope, sectionKey);
      const baseLamport =
        typeof params.baseLamport === 'number' && Number.isInteger(params.baseLamport)
          ? params.baseLamport
          : reject('baseLamport 必须是整数（memory.read 返回值；新建章节传 0）');
      const expected = existing?.baseLamport ?? 0;
      if (baseLamport !== expected) {
        reject(
          `章节「${sectionKey}」已被其他写入更新（令牌期望 ${expected}，实到 ${baseLamport}）——` +
            '先用 memory.read 取最新全文再改',
        );
      }
      const bodyMd = checkText('bodyMd', params.bodyMd, MAX_SECTION_BODY_LENGTH, false);

      // 正文留空 = 删除整节（不再多一个工具；删除也是章节的一种写入结果）
      if (!bodyMd) {
        if (!existing) reject(`章节 ${sectionKey} 不存在，无需删除`);
        ctx.appendEvent(MEMORY_EVENT_TYPES.sectionRemoved, {
          scope: params.scope,
          sectionKey,
        });
        ws.sync();
        return { removed: true, scope: params.scope, sectionKey };
      }

      const title = checkText('title', params.title, MAX_TITLE_LENGTH);
      const summary = checkText('summary', params.summary, MAX_SUMMARY_LENGTH, false);
      const keywords = checkKeywords(params.keywords);
      if (!existing) {
        const { maxSections } = readMemorySettings(ws);
        if (ws.sections.count() >= maxSections) {
          reject(`记忆章节已达上限 ${maxSections} 节——先归并或删除既有章节`);
        }
      }
      ctx.appendEvent(MEMORY_EVENT_TYPES.sectionUpdated, {
        sectionId: existing?.id ?? randomUUID(),
        scope: params.scope,
        sectionKey,
        title,
        bodyMd,
        summary: summary || bodyMd.split('\n')[0].slice(0, MAX_SUMMARY_LENGTH),
        keywords,
      });
      ws.sync();
      const after = ws.sections.byKey(params.scope, sectionKey);
      if (!after) reject('事件已落账但投影未命中（数据不一致）');
      return toFull(after);
    },
  };

  return [def(memoryRead), def(memoryAppend), def(memoryRewrite)];
}
