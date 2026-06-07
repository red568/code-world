/**
 * 上下文管理器 v2
 *
 * 全量落盘 + 动态组装。替换旧的 InLoopCompressor。
 * - 达到阈值时调用外部压缩服务
 * - 压缩后用 summary 替换旧 messages，保留结构化索引
 * - 管理与外部系统的数据交换
 */

import type OpenAI from "openai";
import type { RuntimeConfig, LoggerInterface } from "./types.js";
import {
  CompressionTrigger,
  createTrigger,
  shouldTriggerCompression,
  updateTriggerAfterTurn,
  resetTrigger,
  estimateTokensForMessages,
} from "./context-trigger.js";

export interface ContextManagerState {
  compressionSummary: string;
  lastCompressedStep: number;
  lastSummaryVersion: number;
  totalCompressions: number;
  startedWithSummary: boolean;
}

export class ContextManager {
  private trigger: CompressionTrigger;
  private state: ContextManagerState;
  private config: RuntimeConfig;
  private logger: LoggerInterface;

  constructor(config: RuntimeConfig, logger: LoggerInterface) {
    this.config = config;
    this.logger = logger;
    this.trigger = createTrigger();
    this.state = {
      compressionSummary: "",
      lastCompressedStep: 0,
      lastSummaryVersion: 0,
      totalCompressions: 0,
      startedWithSummary: false,
    };
  }

  getState(): ContextManagerState {
    return { ...this.state };
  }

  getCompressionSummary(): string {
    return this.state.compressionSummary;
  }

  getLastCompressedStep(): number {
    return this.state.lastCompressedStep;
  }

  setInitialSummary(summary: string, coversStepEnd: number, version: number): void {
    this.state.compressionSummary = summary;
    this.state.lastCompressedStep = coversStepEnd;
    this.state.lastSummaryVersion = version;
    this.state.startedWithSummary = true;
  }

  /**
   * 每轮结束后检查是否需要压缩
   */
  async checkAndCompress(
    messages: OpenAI.ChatCompletionMessageParam[],
    currentStep: number
  ): Promise<{ compressed: boolean; messages: OpenAI.ChatCompletionMessageParam[] }> {
    updateTriggerAfterTurn(this.trigger, messages);

    if (!shouldTriggerCompression(this.trigger)) {
      return { compressed: false, messages };
    }

    this.logger.info("Compression triggered", {
      turns: this.trigger.currentTurns,
      tokens: this.trigger.currentTokens,
      step: currentStep,
    });

    try {
      const summary = await this.callExternalCompress(messages, currentStep);
      const newMessages = this.replaceHistoryWithSummary(messages, summary, currentStep);

      this.state.compressionSummary = summary;
      this.state.lastCompressedStep = currentStep;
      this.state.totalCompressions++;
      this.state.lastSummaryVersion++;

      resetTrigger(this.trigger);

      this.logger.info("Compression completed", {
        summaryLength: summary.length,
        messagesBefore: messages.length,
        messagesAfter: newMessages.length,
        step: currentStep,
      });

      return { compressed: true, messages: newMessages };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn("Compression failed, continuing without compression", { error: msg });
      return { compressed: false, messages };
    }
  }

  /**
   * 调用外部压缩服务
   */
  private async callExternalCompress(
    messages: OpenAI.ChatCompletionMessageParam[],
    currentStep: number
  ): Promise<string> {
    const url = `${this.config.apiBaseUrl}/api/internal/context/compress`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": this.config.internalApiSecret,
      },
      body: JSON.stringify({
        projectId: this.config.projectId,
        runId: this.config.runId,
        messages,
        previousSummary: this.state.compressionSummary || undefined,
        startStep: this.state.lastCompressedStep + 1,
        endStep: currentStep,
        preserveHints: {
          recentErrors: true,
          keyDecisions: true,
          fileModifications: true,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Compress API failed: ${response.status} ${text}`);
    }

    const { summary } = await response.json();
    return summary;
  }

  /**
   * 用 summary 替换旧 messages，保留 system prompt 和最近几轮
   */
  private replaceHistoryWithSummary(
    messages: OpenAI.ChatCompletionMessageParam[],
    summary: string,
    _currentStep: number
  ): OpenAI.ChatCompletionMessageParam[] {
    const systemMsg = messages[0];
    const recentCount = 6; // 保留最近 3 轮（每轮 ~2 条消息）

    const recentMessages = messages.slice(-recentCount);

    return [
      systemMsg,
      {
        role: "system" as const,
        content: `[历史上下文摘要 - 覆盖 step 1~${this.state.lastCompressedStep + this.trigger.currentTurns}]\n\n${summary}`,
      },
      ...recentMessages,
    ];
  }

  /**
   * 获取上次压缩后的 messages（销毁前存储用）
   *
   * messages 结构取决于是否经历过压缩：
   * - 从未压缩，无恢复 summary: [system, repo_map?, ...对话]
   * - 从恢复的 summary 开始: [system, summary_system, repo_map?, ...recent]
   * - 本 run 内压缩过: [system, summary_system, repo_map?, ...recent]
   *
   * 我们只需要存储"新产生的对话"部分，跳过固定的 system 类 messages。
   */
  getMessagesAfterLastCompression(
    messages: OpenAI.ChatCompletionMessageParam[]
  ): OpenAI.ChatCompletionMessageParam[] {
    // 找到第一条非-system 消息的位置
    // system messages 包括: system prompt, summary, repo map, task summary
    let startIdx = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "system") {
        startIdx = i;
        break;
      }
    }

    // 如果全是 system messages（不太可能），返回空
    if (startIdx === 0 && messages.length > 0 && messages[0].role === "system") {
      // 所有消息都是 system，检查是否只有 system
      const allSystem = messages.every((m) => m.role === "system");
      if (allSystem) return [];
      // 找到第一个非 system 的
      startIdx = messages.findIndex((m) => m.role !== "system");
      if (startIdx === -1) return [];
    }

    return messages.slice(startIdx);
  }

  /**
   * 存储销毁前剩余 messages
   */
  async storeRemainingMessages(
    messages: OpenAI.ChatCompletionMessageParam[],
    currentStep: number
  ): Promise<void> {
    const remaining = this.getMessagesAfterLastCompression(messages);
    if (remaining.length === 0) return;

    const url = `${this.config.apiBaseUrl}/api/internal/context/store-remaining`;

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": this.config.internalApiSecret,
        },
        body: JSON.stringify({
          projectId: this.config.projectId,
          runId: this.config.runId,
          messages: remaining,
          startStep: this.state.lastCompressedStep + 1,
          endStep: currentStep,
        }),
      });
    } catch (error) {
      this.logger.warn("Failed to store remaining messages", { error: String(error) });
    }
  }
}
