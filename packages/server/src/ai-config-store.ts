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

/** 读配置文件：不存在/损坏/不合法 → undefined（按未配置处理，不阻断启动） */
export function readAiConfigFile(path: string): AiProviderConfig | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined; // 不存在或 JSON 损坏
  }
  const parsed = parseAiConfigInput(raw);
  if (!parsed.ok) {
    console.warn(`[one-server] AI 配置文件不合法，已忽略（${path}）：${parsed.message}`);
    return undefined;
  }
  return parsed.config;
}

/** 写配置文件（覆盖式——页面保存的就是完整配置） */
export function writeAiConfigFile(path: string, config: AiProviderConfig): void {
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

/** 删配置文件（关闭 AI：回到 env 兜底或彻底关闭）；不存在 = 幂等成功 */
export function deleteAiConfigFile(path: string): void {
  try {
    rmSync(path);
  } catch {
    // 不存在即目标态；其他失败留给 GET 的真相面暴露
  }
}
