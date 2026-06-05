/**
 * L1 运行时上下文压缩器
 *
 * 按 Tool 重要性分级，选择性丢弃早期轮次的工具结果。
 * 保留最近 N 轮完整，防止 Agent 丢失近期上下文。
 */

import type OpenAI from "openai";

interface CompressorConfig {
  checkInterval: number;
  maxTokens: number;
  recentRoundsToKeep: number;
}

export class InLoopCompressor {
  private config: CompressorConfig = {
    checkInterval: 10,
    maxTokens: 60000,
    recentRoundsToKeep: 5,
  };

  private discardableTools = new Set(["read_file", "get_preview_url", "list_files"]);
  private criticalTools = new Set(["ask_user"]);

  shouldCompress(messages: OpenAI.ChatCompletionMessageParam[], currentStep: number): boolean {
    if (currentStep % this.config.checkInterval !== 0) return false;
    return this.estimateTokens(messages) > this.config.maxTokens;
  }

  compress(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
    if (messages.length < 6) return messages;

    const systemMsg = messages[0];
    const recentStart = this.findRecentRoundsStart(messages);

    const compressed: OpenAI.ChatCompletionMessageParam[] = [systemMsg];

    for (let i = 1; i < recentStart; i++) {
      const msg = messages[i];

      if (msg.role === "user" && typeof msg.content === "string") {
        compressed.push({
          role: "user",
          content: msg.content.slice(0, 500),
        });
        continue;
      }

      if (msg.role === "assistant") {
        const filtered = this.filterAssistantContent(msg);
        if (filtered) compressed.push(filtered);
        continue;
      }

      if (msg.role === "tool") {
        const processed = this.processToolResult(msg as ToolMessage);
        if (processed) compressed.push(processed);
        continue;
      }

      compressed.push(msg);
    }

    compressed.push(...messages.slice(recentStart));
    return compressed;
  }

  private filterAssistantContent(
    msg: OpenAI.ChatCompletionMessageParam
  ): OpenAI.ChatCompletionMessageParam | null {
    if (msg.role !== "assistant") return msg;
    const assistantMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;

    // 保留 tool_calls 引用（ID 必须对应 tool 消息）和文本内容
    if (assistantMsg.content) {
      return {
        ...assistantMsg,
        content: typeof assistantMsg.content === "string"
          ? assistantMsg.content.slice(0, 300)
          : assistantMsg.content,
      };
    }
    return assistantMsg;
  }

  private processToolResult(msg: ToolMessage): OpenAI.ChatCompletionMessageParam | null {
    const toolName = this.inferToolName(msg);
    const content = typeof msg.content === "string" ? msg.content : "";

    // 可丢弃：完全跳过
    if (toolName && this.discardableTools.has(toolName)) {
      return {
        role: "tool",
        content: `[已执行 ${toolName}]`,
        tool_call_id: msg.tool_call_id,
      } as OpenAI.ChatCompletionToolMessageParam;
    }

    // 必须保留：完整保留
    if (toolName && this.criticalTools.has(toolName)) {
      return msg;
    }

    // 失败的调用：保留错误信息
    if (content.includes("Error") || content.includes("Failed") || content.includes("exit_code: 1")) {
      return {
        role: "tool",
        content: `[ERROR] ${content.slice(0, 300)}`,
        tool_call_id: msg.tool_call_id,
      } as OpenAI.ChatCompletionToolMessageParam;
    }

    // write_file（成功）：只保留路径
    if (toolName === "write_file" || content.startsWith("Written ")) {
      return {
        role: "tool",
        content: content.slice(0, 100),
        tool_call_id: msg.tool_call_id,
      } as OpenAI.ChatCompletionToolMessageParam;
    }

    // run_shell（成功）：只保留命令
    if (toolName === "run_shell" && content.includes("exit_code: 0")) {
      const cmdMatch = content.match(/stdout:\n(.+)/);
      return {
        role: "tool",
        content: `[已执行命令] → 成功${cmdMatch ? ` (${cmdMatch[1].slice(0, 80)})` : ""}`,
        tool_call_id: msg.tool_call_id,
      } as OpenAI.ChatCompletionToolMessageParam;
    }

    // 其他：截断
    return {
      role: "tool",
      content: content.slice(0, 200) + (content.length > 200 ? "..." : ""),
      tool_call_id: msg.tool_call_id,
    } as OpenAI.ChatCompletionToolMessageParam;
  }

  private inferToolName(msg: ToolMessage): string | null {
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.startsWith("Written ")) return "write_file";
    if (content.startsWith("File not found") || content.includes("import ")) return "read_file";
    if (content.includes("exit_code:")) return "run_shell";
    if (content.startsWith("http")) return "get_preview_url";
    if (content.includes("No source files")) return "list_files";
    return null;
  }

  private findRecentRoundsStart(messages: OpenAI.ChatCompletionMessageParam[]): number {
    let rounds = 0;
    for (let i = messages.length - 1; i >= 1; i--) {
      if (messages[i].role === "assistant") {
        rounds++;
        if (rounds >= this.config.recentRoundsToKeep) {
          return i;
        }
      }
    }
    return 1;
  }

  private estimateTokens(messages: OpenAI.ChatCompletionMessageParam[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (msg.role === "assistant") {
        const assistantMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;
        if (typeof assistantMsg.content === "string") {
          chars += assistantMsg.content.length;
        }
        if (assistantMsg.tool_calls) {
          for (const tc of assistantMsg.tool_calls) {
            if (tc.type === "function") {
              chars += tc.function.arguments?.length || 0;
            }
          }
        }
      }
    }
    return Math.ceil(chars / 4);
  }
}

interface ToolMessage extends OpenAI.ChatCompletionToolMessageParam {
  tool_call_id: string;
}
