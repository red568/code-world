/**
 * LLM 客户端
 *
 * OpenAI SDK 兼容调用（DeepSeek、OpenAI、Anthropic 等）。
 * 简化版：直接从 RuntimeConfig 读取配置，无 provider 层。
 */

import OpenAI from "openai";
import type { RuntimeConfig } from "./types.js";

let clientInstance: OpenAI | null = null;

export function createLLMClient(config: RuntimeConfig): OpenAI {
  if (!clientInstance) {
    clientInstance = new OpenAI({
      apiKey: config.llmApiKey,
      baseURL: config.llmBaseUrl,
    });
  }
  return clientInstance;
}

export function getModel(config: RuntimeConfig): string {
  return config.llmModel;
}

export async function chatCompletionWithTools(
  client: OpenAI,
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<OpenAI.ChatCompletion> {
  const maxTokens = options?.maxTokens ?? 8192;
  const temperature = options?.temperature ?? 0.3;

  const response = await client.chat.completions.create({
    model,
    messages,
    tools,
    tool_choice: "auto",
    temperature,
    max_tokens: maxTokens,
  });

  return response;
}

export async function chatCompletionJSON(
  client: OpenAI,
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: options?.temperature ?? 0.3,
    max_tokens: options?.maxTokens ?? 4096,
    response_format: { type: "json_object" },
  });

  return response.choices[0]?.message?.content || "";
}
