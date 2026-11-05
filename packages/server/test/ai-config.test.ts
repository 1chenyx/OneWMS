import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createAppContext, type AppContext } from '../src/index.js';

/**
 * AI 模型配置端点直测（M17）：app.request 不起端口；不碰真实 LLM。
 *
 * 连通测试的失败面用「本地一次性 HTTP 服务器返回 401」构造：401 是
 * AI SDK 的不可重试错误，首轮即失败——快且确定（不可达端点会触发 SDK
 * 默认重试退避 ~6s，又依赖网络环境，都不适合进测试）。
 *
 * 覆盖：GET 默认态 / PUT 保存热生效 + 文件落盘 / 校验 400 分支 /
 * 密钥复用（kind 与 baseUrl 未变才沿用）/ DELETE 关闭与 env 回落 /
 * GET 脱敏（不回传明文）/ POST /test 的空配置 400 与失败面。
 */

let ctx: AppContext | undefined;
let dir: string | undefined;

afterEach(() => {
  ctx?.close();
  ctx = undefined;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function setup(options?: {
  aiConfigEnv?: { kind: 'openai-compatible' | 'ollama'; model: string; baseUrl?: string };
}) {
  dir = mkdtempSync(join(tmpdir(), 'onewms-ai-config-'));
  const env = options?.aiConfigEnv;
  ctx = createAppContext({
    dbPath: ':memory:',
    workspaceId: 'ws-ai-config-test',
    aiConfigPath: join(dir, 'ai-config.json'),
    ...(env ? { provider: undefined, aiConfig: env, aiConfigEnv: env, aiConfigSource: 'env' as const } : {}),
  });
  return createApp(ctx!);
}

const json = { 'content-type': 'application/json' };

/** 本地一次性 HTTP 服务器：对任意请求恒回 401（AI SDK 不可重试错误） */
async function startAuthRejectingServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

describe('GET /api/ai-config：默认态', () => {
  it('未配置 → configured false / source none / 无 config', async () => {
    const app = setup();
    const res = await app.request('/api/ai-config');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { configured: boolean; source: string; config?: unknown };
    expect(data.configured).toBe(false);
    expect(data.source).toBe('none');
    expect(data.config).toBeUndefined();
  });

  it('env 注入宿主 → source env（M16 前语义兼容：给了配置即视为 env 来源）', async () => {
    const app = setup({ aiConfigEnv: { kind: 'openai-compatible', model: 'env-model', baseUrl: 'https://api.example.com/v1' } });
    const res = await app.request('/api/ai-config');
    const data = (await res.json()) as { configured: boolean; source: string; config: { model: string } };
    expect(data.configured).toBe(true);
    expect(data.source).toBe('env');
    expect(data.config.model).toBe('env-model');
  });
});

describe('PUT /api/ai-config：保存热生效 + 落盘', () => {
  it('ollama 配置 → 200 新状态；文件写入；ctx 热更新（provider 从无到有）', async () => {
    const app = setup();
    expect(ctx!.provider).toBeUndefined();

    const res = await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'ollama', model: 'qwen3:8b' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      configured: boolean;
      source: string;
      config: { kind: string; model: string; baseUrl: string };
    };
    expect(data.configured).toBe(true);
    expect(data.source).toBe('file');
    expect(data.config.model).toBe('qwen3:8b');
    expect(data.config.baseUrl).toBe('http://localhost:11434/v1'); // ollama 缺省回显

    // 文件落盘（重启后仍是这份数据）
    const file = JSON.parse(readFileSync(join(dir!, 'ai-config.json'), 'utf-8')) as Record<string, unknown>;
    expect(file.model).toBe('qwen3:8b');

    // 热生效：provider 现场重建（无需重启进程）
    expect(ctx!.provider).toBeDefined();
    expect(ctx!.aiConfig?.model).toBe('qwen3:8b');
  });

  it('model 缺失 → 400 AI_CONFIG_INVALID', async () => {
    const app = setup();
    const res = await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'ollama' }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('AI_CONFIG_INVALID');
  });

  it('openai-compatible 缺 baseUrl → 400（与 resolveLanguageModel 的必填约束同界）', async () => {
    const app = setup();
    const res = await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ model: 'deepseek-chat' }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string; message: string };
    expect(data.code).toBe('AI_CONFIG_INVALID');
    expect(data.message).toContain('Base URL');
  });

  it('baseUrl 非 http(s) → 400', async () => {
    const app = setup();
    const res = await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ model: 'deepseek-chat', baseUrl: 'ftp://x' }),
    });
    expect(res.status).toBe(400);
  });

  it('密钥复用：kind 与 baseUrl 都未变才沿用；任一变化即丢弃（旧密钥不静默发给新端点）', async () => {
    const app = setup();
    await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'openai-compatible', model: 'a', baseUrl: 'https://api.a.com/v1', apiKey: 'sk-1' }),
    });

    // kind + baseUrl 未变、密钥留空 → 沿用 sk-1（改模型名是常见编辑场景）
    await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'openai-compatible', model: 'b', baseUrl: 'https://api.a.com/v1' }),
    });
    let file = JSON.parse(readFileSync(join(dir!, 'ai-config.json'), 'utf-8')) as { model: string; apiKey?: string };
    expect(file.model).toBe('b');
    expect(file.apiKey).toBe('sk-1');

    // 同 kind 换 baseUrl（换服务商）→ 不沿用
    await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'openai-compatible', model: 'c', baseUrl: 'https://api.b.com/v1' }),
    });
    file = JSON.parse(readFileSync(join(dir!, 'ai-config.json'), 'utf-8')) as { model: string; apiKey?: string };
    expect(file.model).toBe('c');
    expect(file.apiKey).toBeUndefined();

    // 换 kind → 不沿用
    await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'ollama', model: 'qwen3:8b' }),
    });
    const res = await app.request('/api/ai-config');
    const data = (await res.json()) as { config: { apiKeySet: boolean } };
    expect(data.config.apiKeySet).toBe(false);
  });

  it('GET 不回传密钥明文（只报 apiKeySet）', async () => {
    const app = setup();
    await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'openai-compatible', model: 'a', baseUrl: 'https://api.a.com/v1', apiKey: 'sk-secret-xyz' }),
    });
    const res = await app.request('/api/ai-config');
    const text = await res.text();
    expect(text).not.toContain('sk-secret-xyz');
    const data = JSON.parse(text) as { config: { apiKeySet: boolean } };
    expect(data.config.apiKeySet).toBe(true);
  });
});

describe('DELETE /api/ai-config：关闭与回落', () => {
  it('无 env 兜底 → configured false / provider 拆除；文件删除', async () => {
    const app = setup();
    await app.request('/api/ai-config', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ kind: 'ollama', model: 'qwen3:8b' }),
    });
    const res = await app.request('/api/ai-config', { method: 'DELETE' });
    const data = (await res.json()) as { configured: boolean; source: string };
    expect(data.configured).toBe(false);
    expect(data.source).toBe('none');
    expect(ctx!.provider).toBeUndefined();
    expect(existsSync(join(dir!, 'ai-config.json'))).toBe(false);
  });

  it('有 env 兜底 → 回落 env 配置（source=env）', async () => {
    const app = setup({ aiConfigEnv: { kind: 'openai-compatible', model: 'env-model', baseUrl: 'https://api.example.com/v1' } });
    const res = await app.request('/api/ai-config', { method: 'DELETE' });
    const data = (await res.json()) as { configured: boolean; source: string; config: { model: string } };
    expect(data.configured).toBe(true);
    expect(data.source).toBe('env');
    expect(data.config.model).toBe('env-model');
  });
});

describe('POST /api/ai-config/test：连通测试', () => {
  it('空 body 且当前未配置 → 400', async () => {
    const app = setup();
    const res = await app.request('/api/ai-config/test', { method: 'POST', headers: json, body: '{}' });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string };
    expect(data.code).toBe('AI_CONFIG_INVALID');
  });

  it('端点拒绝（401）→ 200 包 ok:false（测试失败不是请求失败，失败原文回传排障）', async () => {
    const app = setup();
    const { server, baseUrl } = await startAuthRejectingServer();
    try {
      const res = await app.request('/api/ai-config/test', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ kind: 'openai-compatible', model: 'x', baseUrl }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; message?: string };
      expect(data.ok).toBe(false);
      expect(typeof data.message).toBe('string');
      expect(data.message!.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('空 body 且当前已配置 → 测试当前生效配置', async () => {
    const app = setup();
    const { server, baseUrl } = await startAuthRejectingServer();
    try {
      await app.request('/api/ai-config', {
        method: 'PUT',
        headers: json,
        body: JSON.stringify({ kind: 'openai-compatible', model: 'cur', baseUrl }),
      });
      const res = await app.request('/api/ai-config/test', { method: 'POST', headers: json, body: '{}' });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; message?: string };
      expect(data.ok).toBe(false);
    } finally {
      server.close();
    }
  });
});
