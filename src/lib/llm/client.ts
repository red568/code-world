/**
 * LLM 客户端
 *
 * 使用 OpenAI SDK 调用所有兼容接口（DeepSeek、OpenAI、Anthropic、Kimi 等）。
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
  jsonMode?: boolean; // 启用 response_format: json_object
  label?: string; // 调用标识，用于日志
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
  const model = getModel(options);
  const label = options?.label || "chat";
  const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const startTime = Date.now();

  console.log(`[LLM] ${label} | model=${model} | inputChars=${inputChars} | maxTokens=${options?.maxTokens ?? 4096}`);

  const client = createClient(options);
  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: options?.temperature ?? 0.3,
    max_tokens: options?.maxTokens ?? 4096,
    ...(options?.jsonMode && { response_format: { type: "json_object" as const } }),
  });

  const content = response.choices[0]?.message?.content || "";
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const usage = response.usage;

  console.log(`[LLM] ${label} | done in ${duration}s | outputChars=${content.length} | tokens=${usage?.total_tokens ?? "N/A"} (prompt=${usage?.prompt_tokens ?? "?"} completion=${usage?.completion_tokens ?? "?"})`);

  return content;
}

/**
 * 流式调用 LLM，返回 AsyncIterable 逐 chunk 输出
 */
export async function* chatCompletionStream(
  messages: LLMMessage[],
  options?: LLMCallOptions
): AsyncGenerator<string> {
  const model = getModel(options);
  const label = options?.label || "stream";
  const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const startTime = Date.now();
  let outputChars = 0;
  let chunkCount = 0;

  console.log(`[LLM] ${label} | model=${model} | inputChars=${inputChars} | maxTokens=${options?.maxTokens ?? 4096} | stream=true`);

  const client = createClient(options);
  const stream = await client.chat.completions.create({
    model,
    messages,
    temperature: options?.temperature ?? 0.3,
    max_tokens: options?.maxTokens ?? 4096,
    stream: true,
    ...(options?.jsonMode && { response_format: { type: "json_object" as const } }),
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      outputChars += content.length;
      chunkCount++;
      yield content;
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[LLM] ${label} | done in ${duration}s | outputChars=${outputChars} | chunks=${chunkCount}`);
}
