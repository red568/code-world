/**
 * 压缩触发条件检测
 *
 * 双阈值策略：轮数 OR token 累积，取较先触发者。
 */

import type OpenAI from "openai";

export interface CompressionTrigger {
  turnThreshold: number;
  tokenThreshold: number;
  currentTurns: number;
  currentTokens: number;
}

const DEFAULT_TURN_THRESHOLD = 35;
const DEFAULT_TOKEN_THRESHOLD = 500000;

export function createTrigger(): CompressionTrigger {
  return {
    turnThreshold: parseInt(process.env.COMPRESSION_TURN_THRESHOLD || String(DEFAULT_TURN_THRESHOLD), 10),
    tokenThreshold: parseInt(process.env.COMPRESSION_TOKEN_THRESHOLD || String(DEFAULT_TOKEN_THRESHOLD), 10),
    currentTurns: 0,
    currentTokens: 0,
  };
}

export function shouldTriggerCompression(trigger: CompressionTrigger): boolean {
  return (
    trigger.currentTurns >= trigger.turnThreshold ||
    trigger.currentTokens >= trigger.tokenThreshold
  );
}

export function updateTriggerAfterTurn(
  trigger: CompressionTrigger,
  messages: OpenAI.ChatCompletionMessageParam[]
): void {
  trigger.currentTurns++;
  trigger.currentTokens = estimateTokensForMessages(messages);
}

export function resetTrigger(trigger: CompressionTrigger): void {
  trigger.currentTurns = 0;
  trigger.currentTokens = 0;
}

export function estimateTokensForMessages(messages: OpenAI.ChatCompletionMessageParam[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    }
    if (msg.role === "assistant") {
      const assistantMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;
      if (typeof assistantMsg.content === "string") {
        chars += assistantMsg.content.length;
      }
      if (assistantMsg.tool_calls) {
        for (const tc of assistantMsg.tool_calls) {
          if (tc.type === "function") {
            chars += (tc.function.name?.length || 0) + (tc.function.arguments?.length || 0);
          }
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
