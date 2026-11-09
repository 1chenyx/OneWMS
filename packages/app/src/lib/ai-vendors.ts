/**
 * AI 厂商预设（只活在页面上，不进 @one/ai）。
 *
 * 服务端只存 kind / baseUrl / model / apiKey，不认识厂商。
 * 这里把常见厂商的 OpenAI 兼容地址和当前接口模型 ID 铺好，
 * 用户要填的通常只剩密钥。只有「自定义」手填模型 ID。
 *
 * 只收 OpenAI 兼容接口。Anthropic 原生接口不是这一种，Claude 走 OpenRouter。
 * 名单按各厂商文档里的 model 字符串，不是商品名。
 */

export type AiVendorRegion = 'cn' | 'global' | 'local';

export interface AiVendor {
  id: string;
  name: string;
  region: AiVendorRegion;
  kind: 'openai-compatible' | 'ollama';
  /** 自定义厂商为空，地址由用户填 */
  baseUrl: string;
  models: { id: string; label: string }[];
  /** 云厂商必须有密钥；本机 Ollama / LM Studio 不需要 */
  needsKey: boolean;
  /** 只有自定义要手填模型 ID */
  modelFromUser: boolean;
  hint: string;
}

export const AI_VENDOR_REGIONS: { id: AiVendorRegion; label: string }[] = [
  { id: 'cn', label: '国内' },
  { id: 'global', label: '国际' },
  { id: 'local', label: '本地' },
];

const CUSTOM_VENDOR: AiVendor = {
  id: 'custom',
  name: '自定义',
  region: 'local',
  kind: 'openai-compatible',
  baseUrl: '',
  models: [],
  needsKey: false,
  modelFromUser: true,
  hint: '自己填兼容接口地址和模型 ID',
};

function chips(ids: string[]): { id: string; label: string }[] {
  return ids.map((id) => ({ id, label: id }));
}

export const AI_VENDORS: AiVendor[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: chips(['deepseek-flash', 'deepseek-v4-pro']),
    needsKey: true,
    modelFromUser: false,
    hint: 'V4.1 Flash 与 V4 Pro',
  },
  {
    id: 'dashscope',
    name: '通义千问',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: chips(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus']),
    needsKey: true,
    modelFromUser: false,
    hint: '阿里云百炼，国内站',
  },
  {
    id: 'dashscope-intl',
    name: '通义千问（国际）',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: chips(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus']),
    needsKey: true,
    modelFromUser: false,
    hint: '百炼国际站，密钥不与国内站通用',
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: chips(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3']),
    needsKey: true,
    modelFromUser: false,
    hint: '国内站 api.moonshot.cn',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: chips(['glm-5.3', 'glm-5.3-flash', 'glm-4.7']),
    needsKey: true,
    modelFromUser: false,
    hint: '开放平台 v4 兼容接口',
  },
  {
    id: 'doubao',
    name: '豆包（火山方舟）',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: chips(['doubao-seed-evolving', 'doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-lite-260915']),
    needsKey: true,
    modelFromUser: false,
    hint: '公开模型名。接入点 ep- 开头时用自定义',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: chips(['hy4', 'hunyuan-turbos-latest']),
    needsKey: true,
    modelFromUser: false,
    hint: '混元 OpenAI 兼容接口',
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    models: chips(['ernie-5.1']),
    needsKey: true,
    modelFromUser: false,
    hint: '千帆 v2 兼容接口',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.stepfun.com/v1',
    models: chips(['step-5-preview', 'step-3.7-flash', 'step-3.5-flash']),
    needsKey: true,
    modelFromUser: false,
    hint: 'StepFun 兼容接口',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: chips(['MiniMax-M3.1-Flash', 'MiniMax-M3']),
    needsKey: true,
    modelFromUser: false,
    hint: '国内站 api.minimaxi.com',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: chips(['deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4-Pro', 'Qwen/Qwen3-8B']),
    needsKey: true,
    modelFromUser: false,
    hint: '模型 ID 带组织名，一个密钥可换多家模型',
  },
  {
    id: 'spark',
    name: '讯飞星火',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    models: chips(['spark-x', '4.0Ultra']),
    needsKey: true,
    modelFromUser: false,
    hint: '星火 HTTP 兼容接口',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    models: chips(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']),
    needsKey: true,
    modelFromUser: false,
    hint: '官方 api.openai.com',
  },
  {
    id: 'xai',
    name: 'xAI（Grok）',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    models: chips(['grok-4.7', 'grok-4.5', 'grok-4.3']),
    needsKey: true,
    modelFromUser: false,
    hint: '密钥是 XAI_API_KEY，地址 api.x.ai',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: chips(['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite']),
    needsKey: true,
    modelFromUser: false,
    hint: 'Google AI Studio 的 OpenAI 兼容地址',
  },
  {
    id: 'groq',
    name: 'Groq',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: chips(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']),
    needsKey: true,
    modelFromUser: false,
    hint: '官方兼容接口上的对话模型',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    models: chips(['mistral-large-latest', 'mistral-small-latest', 'codestral-latest']),
    needsKey: true,
    modelFromUser: false,
    hint: 'latest 会跟着官方当前版本',
  },
  {
    id: 'moonshot-intl',
    name: 'Kimi（国际）',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: chips(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3']),
    needsKey: true,
    modelFromUser: false,
    hint: '国际站 api.moonshot.ai，密钥不与国内站通用',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: chips(['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-4.5', 'google/gemini-3.8-flash']),
    needsKey: true,
    modelFromUser: false,
    hint: '一个密钥调用多家模型，Claude 走这里',
  },
  {
    id: 'together',
    name: 'Together',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    models: chips(['Qwen/Qwen3.8-Flash', 'openai/gpt-oss-120b']),
    needsKey: true,
    modelFromUser: false,
    hint: '模型 ID 带组织名',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: chips([
      'accounts/fireworks/models/deepseek-v4p1-flash-1017',
      'accounts/fireworks/models/kimi-k3',
      'accounts/fireworks/models/glm-5p3',
    ]),
    needsKey: true,
    modelFromUser: false,
    hint: '模型 ID 是 accounts/fireworks/models/…',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.perplexity.ai',
    models: chips(['sonar-pro', 'sonar']),
    needsKey: true,
    modelFromUser: false,
    hint: '地址不带 /v1',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: chips(['gpt-oss-120b', 'qwen-3.8-27b']),
    needsKey: true,
    modelFromUser: false,
    hint: '官方兼容接口',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    region: 'local',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: chips(['qwen3:8b', 'llama3.1:8b', 'deepseek-r1:8b']),
    needsKey: false,
    modelFromUser: false,
    hint: '本机已拉取的常用模型，不需要密钥。别的名字用自定义',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    region: 'local',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    models: chips(['qwen3-8b', 'llama-3.1-8b-instruct', 'gemma-3-4b-it']),
    needsKey: false,
    modelFromUser: false,
    hint: '选和本机已加载模型同名的 ID。对不上就用自定义',
  },
];

/** 某一区的厂商，末尾永远带「自定义」 */
export function vendorsIn(region: AiVendorRegion): AiVendor[] {
  return [...AI_VENDORS.filter((item) => item.region === region), CUSTOM_VENDOR];
}

export function findVendor(id: string): AiVendor | undefined {
  if (id === CUSTOM_VENDOR.id) return CUSTOM_VENDOR;
  return AI_VENDORS.find((item) => item.id === id);
}

/**
 * 聊天里某厂商能选的模型：预设在前，已经保存但不在预设里的接在后面。
 * 自定义没有预设，列表就是保存过的模型 ID。
 */
export function modelsForVendor(vendorId: string, savedModelIds: string[]): string[] {
  const preset = findVendor(vendorId)?.models.map((item) => item.id) ?? [];
  const extra: string[] = [];
  for (const id of savedModelIds) {
    if (id && !preset.includes(id) && !extra.includes(id)) extra.push(id);
  }
  return [...preset, ...extra];
}
