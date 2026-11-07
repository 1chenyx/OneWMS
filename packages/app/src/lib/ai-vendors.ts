/**
 * AI 厂商预设（只活在页面上，不进 @one/ai）。
 *
 * 服务端只存 kind / baseUrl / model / apiKey，不认识厂商。
 * 这里把常见厂商的 OpenAI 兼容地址和一批稳定模型 ID 铺好，
 * 用户要填的通常只剩密钥。模型 ID 换得很快，列表是常用项，
 * 页面上始终可以再手填一条。
 *
 * 只收 OpenAI 兼容接口。Anthropic 原生接口不是这一种，Claude 走 OpenRouter。
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
  /** 没有能通用的模型 ID（豆包接入点、本地当场加载的模型） */
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
  hint: '自己填兼容接口地址',
};

export const AI_VENDORS: AiVendor[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
    ],
    needsKey: true,
    modelFromUser: false,
    hint: '对话与推理两个常用 ID',
  },
  {
    id: 'dashscope',
    name: '通义千问',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-plus', label: 'qwen-plus' },
      { id: 'qwen-turbo', label: 'qwen-turbo' },
      { id: 'qwen-max', label: 'qwen-max' },
      { id: 'qwen-flash', label: 'qwen-flash' },
    ],
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
    models: [
      { id: 'qwen-plus', label: 'qwen-plus' },
      { id: 'qwen-turbo', label: 'qwen-turbo' },
      { id: 'qwen-flash', label: 'qwen-flash' },
    ],
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
    models: [
      { id: 'moonshot-v1-auto', label: 'moonshot-v1-auto' },
      { id: 'moonshot-v1-8k', label: 'moonshot-v1-8k' },
      { id: 'moonshot-v1-32k', label: 'moonshot-v1-32k' },
      { id: 'moonshot-v1-128k', label: 'moonshot-v1-128k' },
      { id: 'kimi-latest', label: 'kimi-latest' },
    ],
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
    models: [
      { id: 'glm-4-flash', label: 'glm-4-flash' },
      { id: 'glm-4-plus', label: 'glm-4-plus' },
      { id: 'glm-4-air', label: 'glm-4-air' },
    ],
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
    models: [],
    needsKey: true,
    modelFromUser: true,
    hint: '模型 ID 是接入点，通常 ep- 或 doubao- 开头',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    region: 'cn',
    kind: 'openai-compatible',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: [
      { id: 'hunyuan-turbos-latest', label: 'hunyuan-turbos-latest' },
      { id: 'hunyuan-lite', label: 'hunyuan-lite' },
    ],
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
    models: [{ id: 'ernie-4.0-turbo-8k', label: 'ernie-4.0-turbo-8k' }],
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
    models: [
      { id: 'step-2-16k', label: 'step-2-16k' },
      { id: 'step-1-8k', label: 'step-1-8k' },
    ],
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
    models: [
      { id: 'MiniMax-Text-01', label: 'MiniMax-Text-01' },
      { id: 'MiniMax-M2', label: 'MiniMax-M2' },
    ],
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
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', label: 'deepseek-ai/DeepSeek-V3' },
      { id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen/Qwen2.5-7B-Instruct' },
    ],
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
    models: [
      { id: 'generalv3.5', label: 'generalv3.5' },
      { id: '4.0Ultra', label: '4.0Ultra' },
    ],
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
    models: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      { id: 'gpt-4o', label: 'gpt-4o' },
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
      { id: 'gpt-4.1', label: 'gpt-4.1' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],
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
    models: [
      { id: 'grok-4', label: 'grok-4' },
      { id: 'grok-3', label: 'grok-3' },
      { id: 'grok-3-mini', label: 'grok-3-mini' },
    ],
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
    models: [
      { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
    ],
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
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile' },
      { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant' },
    ],
    needsKey: true,
    modelFromUser: false,
    hint: '控制台里的新模型 ID 可以直接填',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    models: [
      { id: 'mistral-small-latest', label: 'mistral-small-latest' },
      { id: 'mistral-large-latest', label: 'mistral-large-latest' },
    ],
    needsKey: true,
    modelFromUser: false,
    hint: '官方 api.mistral.ai',
  },
  {
    id: 'moonshot-intl',
    name: 'Kimi（国际）',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: [
      { id: 'moonshot-v1-auto', label: 'moonshot-v1-auto' },
      { id: 'moonshot-v1-128k', label: 'moonshot-v1-128k' },
      { id: 'kimi-latest', label: 'kimi-latest' },
    ],
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
    models: [
      { id: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini' },
      { id: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4' },
      { id: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash' },
    ],
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
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', label: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo' },
      { id: 'Qwen/Qwen2.5-7B-Instruct-Turbo', label: 'Qwen/Qwen2.5-7B-Instruct-Turbo' },
    ],
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
    models: [{ id: 'accounts/fireworks/models/llama-v3p1-8b-instruct', label: 'accounts/fireworks/models/llama-v3p1-8b-instruct' }],
    needsKey: true,
    modelFromUser: false,
    hint: '模型 ID 一般是 accounts/fireworks/models/…',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    region: 'global',
    kind: 'openai-compatible',
    baseUrl: 'https://api.perplexity.ai',
    models: [
      { id: 'sonar', label: 'sonar' },
      { id: 'sonar-pro', label: 'sonar-pro' },
    ],
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
    models: [
      { id: 'llama3.1-8b', label: 'llama3.1-8b' },
      { id: 'llama-3.3-70b', label: 'llama-3.3-70b' },
    ],
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
    models: [
      { id: 'qwen3:8b', label: 'qwen3:8b' },
      { id: 'llama3.1:8b', label: 'llama3.1:8b' },
      { id: 'deepseek-r1:8b', label: 'deepseek-r1:8b' },
    ],
    needsKey: false,
    modelFromUser: false,
    hint: '本机已拉取的模型，不需要密钥',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    region: 'local',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    models: [],
    needsKey: false,
    modelFromUser: true,
    hint: '先在 LM Studio 里加载模型，再填它的 ID',
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
