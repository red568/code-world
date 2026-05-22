/**
 * LLM 客户端
 *
 * 使用 OpenAI SDK 调用所有兼容接口（Kimi、OpenAI、DeepSeek 等）。
 * 支持流式和非流式两种调用方式。
 */

import OpenAI from "openai";
import { getProviderConfig } from "./providers";

export interface LLMCallOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// 创建 OpenAI 兼容客户端实例
function createClient(options?: LLMCallOptions): OpenAI {
  const config = getProviderConfig(options?.provider);
  return new OpenAI({
    apiKey: options?.apiKey || process.env.LLM_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || config.baseURL,
  });
}

// 获取当前使用的模型名
function getModel(options?: LLMCallOptions): string {
  if (options?.model) return options.model;
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  const config = getProviderConfig(options?.provider);
  return config.defaultModel;
}

/**
 * 非流式调用 LLM，返回完整响应文本
 */
export async function chatCompletion(
  messages: LLMMessage[],
  options?: LLMCallOptions
): Promise<string> {
  const client = createClient(options);
  const response = await client.chat.completions.create({
    model: getModel(options),
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 4096,
  });
  return response.choices[0]?.message?.content || "";
}

/**
 * 流式调用 LLM，返回 AsyncIterable 逐 chunk 输出
 */
export async function* chatCompletionStream(
  messages: LLMMessage[],
  options?: LLMCallOptions
): AsyncGenerator<string> {
  const client = createClient(options);
  const stream = await client.chat.completions.create({
    model: getModel(options),
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 4096,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }
}
