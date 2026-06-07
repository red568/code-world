/**
 * Context Assembler — 基于 Slot 的上下文组装器
 *
 * 每次调 LLM 前，按固定 Slot 顺序组装最优上下文：
 *   Slot A: System Prompt + Tool Definitions (~5000 token)
 *   Slot B: Compression Summary (~6000 token)
 *   Slot C: Repo Map 代码骨架 (~5000 token)
 *   Slot D: Task Summary (~500 token)
 *   Slot E: Retrieved Episodes (~10000 token)
 *   Slot F: Recent Messages (剩余空间)
 */

import type OpenAI from "openai";
import type { Episode } from "./episode-recorder.js";
import type { TaskSummarizer } from "./task-summary.js";

export interface AssemblerConfig {
  repoMapBudget: number;
  episodeBudget: number;
  autoInjectRepoMap: boolean;
  autoInjectEpisodes: boolean;
}

const DEFAULT_CONFIG: AssemblerConfig = {
  repoMapBudget: 5000,
  episodeBudget: 10000,
  autoInjectRepoMap: true,
  autoInjectEpisodes: true,
};

export class ContextAssembler {
  private config: AssemblerConfig;
  private cachedRepoMap: string | null = null;

  constructor(config?: Partial<AssemblerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setRepoMap(map: string): void {
    this.cachedRepoMap = map;
  }

  getRepoMap(): string | null {
    return this.cachedRepoMap;
  }

  /**
   * 压缩后重新组装 context
   */
  assemblePostCompression(
    systemPrompt: string,
    compressionSummary: string,
    recentMessages: OpenAI.ChatCompletionMessageParam[],
    taskSummarizer?: TaskSummarizer,
    episodes?: Episode[],
    currentMessage?: string
  ): OpenAI.ChatCompletionMessageParam[] {
    const assembled: OpenAI.ChatCompletionMessageParam[] = [];

    // Slot A: System prompt
    assembled.push({ role: "system", content: systemPrompt });

    // Slot B: Compression Summary
    if (compressionSummary) {
      assembled.push({
        role: "system",
        content: `[历史上下文摘要]\n${compressionSummary}`,
      });
    }

    // Slot C: Repo Map
    const slotC = this.assembleSlotC();
    if (slotC) {
      assembled.push(slotC);
    }

    // Slot D: Task Summary
    const slotD = this.assembleSlotD(taskSummarizer);
    if (slotD) {
      assembled.push(slotD);
    }

    // Slot E: Retrieved Episodes
    const slotE = this.assembleSlotE(episodes, recentMessages, currentMessage);
    if (slotE) {
      assembled.push(slotE);
    }

    // Slot F: Recent Messages
    assembled.push(...recentMessages);

    return assembled;
  }

  /**
   * 正常模式：在已有 messages 基础上注入 Slot C/D/E（首次或更新时）
   * 返回需要额外注入的 system messages
   */
  assembleSupplemental(
    taskSummarizer?: TaskSummarizer,
    episodes?: Episode[],
    recentMessages?: OpenAI.ChatCompletionMessageParam[],
    currentMessage?: string
  ): OpenAI.ChatCompletionMessageParam[] {
    const supplemental: OpenAI.ChatCompletionMessageParam[] = [];

    const slotC = this.assembleSlotC();
    if (slotC) supplemental.push(slotC);

    const slotD = this.assembleSlotD(taskSummarizer);
    if (slotD) supplemental.push(slotD);

    const slotE = this.assembleSlotE(episodes, recentMessages, currentMessage);
    if (slotE) supplemental.push(slotE);

    return supplemental;
  }

  private assembleSlotC(): OpenAI.ChatCompletionMessageParam | null {
    if (!this.config.autoInjectRepoMap || !this.cachedRepoMap) {
      return null;
    }

    let content = this.cachedRepoMap;
    const tokens = this.estimateTokens(content);

    if (tokens > this.config.repoMapBudget) {
      content = this.truncateToTokens(content, this.config.repoMapBudget);
    }

    return {
      role: "system",
      content: `[项目代码骨架]\n${content}`,
    };
  }

  private assembleSlotD(taskSummarizer?: TaskSummarizer): OpenAI.ChatCompletionMessageParam | null {
    if (!taskSummarizer) return null;

    const slotD = taskSummarizer.toSlotD();
    if (!slotD) return null;

    return {
      role: "system",
      content: `[任务状态]\n${slotD}`,
    };
  }

  private assembleSlotE(
    episodes?: Episode[],
    recentMessages?: OpenAI.ChatCompletionMessageParam[],
    currentMessage?: string
  ): OpenAI.ChatCompletionMessageParam | null {
    if (!this.config.autoInjectEpisodes || !episodes || episodes.length === 0) {
      return null;
    }

    const retrieved = this.retrieveRelevant(
      episodes,
      currentMessage || "",
      recentMessages || [],
      this.config.episodeBudget
    );

    if (retrieved.length === 0) return null;

    return {
      role: "system",
      content: `[相关历史操作]\n${retrieved.join("\n")}`,
    };
  }

  private retrieveRelevant(
    episodes: Episode[],
    currentMessage: string,
    recentMessages: OpenAI.ChatCompletionMessageParam[],
    budget: number
  ): string[] {
    const mentionedFiles = this.extractMentionedFiles(currentMessage, recentMessages);
    const mentionedSymbols = this.extractMentionedSymbols(currentMessage, recentMessages);

    const scored = episodes.map((ep) => {
      let score = 0;

      // 路径 1: 文件关联
      const fileOverlap = ep.relatedFiles.filter((f) => mentionedFiles.has(f)).length;
      score += fileOverlap * 10 * 0.35;

      // 路径 2: 符号关联
      const symbolOverlap = (ep.relatedSymbols || []).filter((s) => mentionedSymbols.has(s)).length;
      score += symbolOverlap * 8 * 0.25;

      // 路径 3: 错误关联
      if (this.isErrorContext(currentMessage)) {
        if (!ep.toolSuccess) score += 8 * 0.2;
        if (ep.toolName === "run_shell") score += 5 * 0.2;
      }

      // 路径 4: 代码变更关联
      if (ep.codeChange && mentionedFiles.has(ep.codeChange.file)) {
        score += 12 * 0.15;
      }

      // 路径 5: 时间衰减
      const recency = Math.exp(-0.05 * (episodes.length - ep.stepNumber));
      score += recency * 5 * 0.05;

      return { episode: ep, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // 按预算填充
    const results: string[] = [];
    let usedTokens = 0;

    for (const { episode, score } of scored) {
      if (score <= 0) break;

      const budgetLevel = usedTokens < budget * 0.5 ? "full" : usedTokens < budget * 0.8 ? "medium" : "minimal";
      const formatted = this.formatEpisodeAdaptive(episode, budgetLevel);
      const tokens = this.estimateTokens(formatted);

      if (usedTokens + tokens > budget) break;

      results.push(formatted);
      usedTokens += tokens;
    }

    return results;
  }

  private formatEpisodeAdaptive(ep: Episode, budget: "full" | "medium" | "minimal"): string {
    switch (budget) {
      case "full":
        return [
          `[Step ${ep.stepNumber}] ${ep.thinking}`,
          `  → ${ep.toolName}(${ep.relatedFiles.join(", ")})`,
          `  → ${ep.resultSummary}`,
          ep.relatedSymbols?.length ? `  → 符号: ${ep.relatedSymbols.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      case "medium":
        return `[Step ${ep.stepNumber}] ${ep.toolName}(${ep.relatedFiles[0] || ""}) → ${ep.resultSummary}`;
      case "minimal":
        return `[Step ${ep.stepNumber}] ${ep.toolSuccess ? "✓" : "✗"} ${ep.toolName}`;
    }
  }

  private extractMentionedFiles(
    currentMessage: string,
    recentMessages: OpenAI.ChatCompletionMessageParam[]
  ): Set<string> {
    const files = new Set<string>();
    const allText =
      currentMessage +
      recentMessages
        .slice(-4)
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join(" ");

    const matches = allText.match(/[\w\-\/]+\.\w{1,4}/g);
    if (matches) {
      for (const m of matches) {
        if (/\.(tsx?|jsx?|css|json|html|md)$/.test(m)) {
          files.add(m);
        }
      }
    }
    return files;
  }

  private extractMentionedSymbols(
    currentMessage: string,
    recentMessages: OpenAI.ChatCompletionMessageParam[]
  ): Set<string> {
    const symbols = new Set<string>();
    const allText =
      currentMessage +
      recentMessages
        .slice(-4)
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join(" ");

    // PascalCase (component names)
    const pascal = allText.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g);
    if (pascal) pascal.forEach((s) => symbols.add(s));

    // camelCase (function names, 4+ chars)
    const camel = allText.match(/\b[a-z][a-zA-Z0-9]{3,}\b/g);
    if (camel) camel.forEach((s) => symbols.add(s));

    return symbols;
  }

  private isErrorContext(message: string): boolean {
    const keywords = ["错误", "error", "Error", "失败", "fix", "bug", "问题", "报错", "TypeError", "Cannot"];
    return keywords.some((k) => message.includes(k));
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n... (truncated)";
  }
}
