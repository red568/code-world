/**
 * LLM Provider 配置
 *
 * 所有支持的模型都通过 OpenAI 兼容接口调用。
 * 默认使用 Kimi (moonshot)，可通过环境变量或运行时参数切换。
 */

export interface LLMProviderConfig {
  name: string;
  baseURL: string;
  defaultModel: string;
  models: string[];
}

// 预置 Provider 列表，新增模型只需在此追加
export const LLM_PROVIDERS: Record<string, LLMProviderConfig> = {
  kimi: {
    name: "Kimi (Moonshot)",
    baseURL: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  openai: {
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  },
  anthropic: {
    name: "Anthropic (via compatible proxy)",
    baseURL: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  },
  deepseek: {
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-coder"],
  },
};

export function getProviderConfig(provider?: string): LLMProviderConfig {
  const key = provider || process.env.LLM_PROVIDER || "kimi";
  const config = LLM_PROVIDERS[key];
  if (!config) {
    throw new Error(
      `Unknown LLM provider: ${key}. Available: ${Object.keys(LLM_PROVIDERS).join(", ")}`
    );
  }
  return config;
}
