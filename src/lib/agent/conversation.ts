/**
 * Agent 对话管理
 *
 * 负责对话摘要生成和 messages 数组的 token 压缩。
 */

import OpenAI from "openai";
import { getProviderConfig } from "@/lib/llm/providers";

type Message = OpenAI.ChatCompletionMessageParam;

const MAX_TOKEN_ESTIMATE = 80000;

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * 沙箱过期时调用，从完整 messages 生成简短摘要
 */
export async function generateConversationSummary(
  messages: Message[]
): Promise<string | null> {
  const keyPoints: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      keyPoints.push(`用户: ${msg.content.slice(0, 200)}`);
    }
    if (msg.role === "assistant" && "content" in msg && typeof msg.content === "string" && msg.content.length > 0) {
      keyPoints.push(`Agent: ${msg.content.slice(0, 200)}`);
    }
  }

  if (keyPoints.length === 0) return null;

  const providerConfig = getProviderConfig();
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || providerConfig.baseURL,
  });
  const model = process.env.LLM_MODEL || providerConfig.defaultModel;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: "你是一个对话摘要助手。请将以下 Agent 对话历史压缩为一段简洁的项目摘要（200字以内），包含：1. 项目是什么 2. 做了哪些关键修改 3. 当前状态。不要包含代码细节。",
        },
        {
          role: "user",
          content: keyPoints.slice(0, 30).join("\n"),
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content || null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Conversation] 摘要生成失败: ${msg}`);
    return null;
  }
}

/**
 * 如果 messages 超过 token 预算，压缩早期轮次
 *
 * 规则：
 * - 保留 system prompt（第一条）
 * - 保留最近 3 轮完整内容
 * - 更早的轮次只保留 user + assistant content（去掉 tool_call/tool_result）
 */
export function compressMessagesIfNeeded(messages: Message[]): Message[] {
  const estimate = estimateTokens(messages);
  if (estimate <= MAX_TOKEN_ESTIMATE) return messages;

  console.log(`[Conversation] Token 超限 (${estimate} > ${MAX_TOKEN_ESTIMATE})，压缩历史`);

  if (messages.length < 4) return messages;

  const systemMsg = messages[0];
  const recentStart = findRecentRoundsStart(messages, 3);

  const compressed: Message[] = [systemMsg];

  for (let i = 1; i < recentStart; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      compressed.push(msg);
    } else if (msg.role === "assistant" && "content" in msg && typeof msg.content === "string" && msg.content) {
      compressed.push({ role: "assistant", content: msg.content });
    }
  }

  compressed.push(...messages.slice(recentStart));

  const newEstimate = estimateTokens(compressed);
  console.log(`[Conversation] 压缩完成: ${messages.length} → ${compressed.length} 条, ${estimate} → ${newEstimate} tokens`);

  return compressed;
}

/**
 * 从末尾往前找第 N 轮 user 消息的起始位置
 */
function findRecentRoundsStart(messages: Message[], rounds: number): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === "user") {
      count++;
      if (count >= rounds) return i;
    }
  }
  return 1;
}
