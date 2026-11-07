import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AiProviderConfig, AiProviderKind } from '@one/ai';

/**
 * AI 配置的页面持久化位（M17：AI 模型配置页）。
 *
 * env 只读（进程启动快照）；页面保存走「配置文件」——落在 dbPath 同目录，
 * 随数据走（桌面版在 app data，便携版在 data/）。明文 JSON：与迁移包同级
 * 的本地可信域信任假设（§9.2 本地优先，密钥不出本机）。
 *
 * 校验标准只有一份（parseAiConfigInput）：PUT 请求体与文件读取共用——
 * 文件损坏/结构非法按「未配置」处理，不让坏文件拖垮 server 启动。
 */

/** 配置文件名（dbPath 同目录；ONE_AI_CONFIG_PATH 可显式覆盖） */
export const AI_CONFIG_FILE = 'ai-config.json';

/** dbPath → 配置文件路径；:memory: 宿主无落盘位 → null（页面保存仅进程内生效） */
export function resolveAiConfigPath(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof env.ONE_AI_CONFIG_PATH === 'string' && env.ONE_AI_CONFIG_PATH.trim()) {
    return env.ONE_AI_CONFIG_PATH;
  }
  if (dbPath === ':memory:') return null;
  return resolve(dirname(resolve(dbPath)), AI_CONFIG_FILE);
}

/** 一条已保存的模型（同一厂商可以有多条，靠模型名区分） */
export interface AiModelProfile {
  id: string;
  /** 厂商预设 id；自定义地址为 custom */
  vendorId: string;
  label: string;
  kind: AiProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/** 配置文件 v2：多模型 + 当前使用的那一条 */
export interface AiConfigCatalog {
  version: 2;
  activeId: string | null;
  profiles: AiModelProfile[];
}

export const EMPTY_AI_CATALOG: AiConfigCatalog = { version: 2, activeId: null, profiles: [] };

export type ParseResult = { ok: true; config: AiProviderConfig } | { ok: false; message: string };

/**
 * 校验 + 归一（页面 PUT / 连通测试 / 文件读取同一标准）。
 *  - kind 缺省 openai-compatible（与 readAiConfig 的 env 语义一致）；
 *  - model 必填（AI 可选的开关就是它——空模型 = 不配置）；
 *  - baseUrl：openai-compatible 必填（resolveLanguageModel 会抛）；ollama 可省（缺省本机 11434）；
 *  - apiKey：两者都可选（ollama 忽略；部分本地兼容网关也免鉴权）。
 */
export function parseAiConfigInput(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '请求体必须是 JSON 对象 { kind, model, baseUrl, apiKey }' };
  }
  const body = raw as Record<string, unknown>;
  const kind: AiProviderKind = body.kind === 'ollama' ? 'ollama' : 'openai-compatible';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    return { ok: false, message: '模型名不能为空（如 qwen3:8b / gpt-4o-mini / deepseek-chat）' };
  }
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (kind === 'openai-compatible' && !baseUrl) {
    return { ok: false, message: '云 API（OpenAI 兼容）需要 Base URL（如 https://api.deepseek.com/v1）' };
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, message: 'Base URL 必须以 http:// 或 https:// 开头' };
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  return {
    ok: true,
    config: { kind, model, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined },
  };
}

/** 旧的单模型文件 → 一条目录（读到 v1 时升级，不丢密钥） */
export function catalogFromProvider(config: AiProviderConfig, id = 'legacy'): AiConfigCatalog {
  return {
    version: 2,
    activeId: id,
    profiles: [
      {
        id,
        vendorId: 'custom',
        label: config.model,
        kind: config.kind,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      },
    ],
  };
}

/** 当前使用的那条 → 进程级 AiProviderConfig（聊天与备份的生效面） */
export function activeProvider(catalog: AiConfigCatalog): AiProviderConfig | undefined {
  const profile =
    catalog.profiles.find((item) => item.id === catalog.activeId) ?? catalog.profiles[0];
  if (!profile) return undefined;
  return {
    kind: profile.kind,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
  };
}

function parseProfile(raw: unknown): AiModelProfile | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const parsed = parseAiConfigInput({
    kind: body.kind,
    model: body.model,
    baseUrl: body.baseUrl,
    apiKey: body.apiKey,
  });
  if (!parsed.ok) return undefined;
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return undefined;
  const vendorId = typeof body.vendorId === 'string' && body.vendorId.trim() ? body.vendorId.trim() : 'custom';
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : parsed.config.model;
  return { id, vendorId, label, ...parsed.config };
}

/**
 * 读配置目录。v2 读多模型；v1 单对象升级成一条。
 * 不存在、损坏、没有合法条目 → undefined（按未配置处理，不阻断启动）。
 */
export function readAiCatalog(path: string): AiConfigCatalog | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const body = raw as Record<string, unknown>;
    if (body.version === 2 && Array.isArray(body.profiles)) {
      const profiles = body.profiles.map(parseProfile).filter((item): item is AiModelProfile => item !== undefined);
      if (profiles.length === 0) {
        console.warn(`[one-server] AI 配置文件没有合法模型，已忽略（${path}）`);
        return undefined;
      }
      const requested = typeof body.activeId === 'string' ? body.activeId : '';
      const activeId = profiles.some((item) => item.id === requested) ? requested : profiles[0]!.id;
      return { version: 2, activeId, profiles };
    }
  }
  const legacy = parseAiConfigInput(raw);
  if (!legacy.ok) {
    console.warn(`[one-server] AI 配置文件不合法，已忽略（${path}）：${legacy.message}`);
    return undefined;
  }
  return catalogFromProvider(legacy.config);
}

/** 读当前生效的那一条（备份与启动用）。无文件 → undefined */
export function readAiConfigFile(path: string): AiProviderConfig | undefined {
  const catalog = readAiCatalog(path);
  return catalog ? activeProvider(catalog) : undefined;
}

/** 写整份目录（覆盖式） */
export function writeAiCatalog(path: string, catalog: AiConfigCatalog): void {
  writeFileSync(path, JSON.stringify(catalog, null, 2), 'utf-8');
}

/** 把单条配置写成只有它的目录（旧备份恢复） */
export function writeAiConfigFile(path: string, config: AiProviderConfig): void {
  writeAiCatalog(path, catalogFromProvider(config));
}

/** 删配置文件（关闭 AI：回到 env 兜底或彻底关闭）；不存在 = 幂等成功 */
export function deleteAiConfigFile(path: string): void {
  try {
    rmSync(path);
  } catch {
    // 不存在即目标态；其他失败留给 GET 的真相面暴露
  }
}
