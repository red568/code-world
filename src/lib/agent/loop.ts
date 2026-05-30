/**
 * Agent Loop 引擎
 *
 * 核心 ReAct 循环：LLM 思考 → 选择工具 → 执行 → 观察结果 → 继续
 */

import OpenAI from "openai";
import { getProviderConfig } from "@/lib/llm/providers";
import {
  AGENT_TOOLS,
  executeTool,
  type ToolContext,
  type ToolResult,
} from "./tools";
import { publishEvent } from "@/lib/streaming";
import { prisma } from "@/lib/prisma";
import { isCancelled } from "@/lib/queue/cancel";
import type { Sandbox } from "@e2b/code-interpreter";

// ─── 类型定义 ────────────────────────────────────────────────────────────────────

export interface AgentLoopConfig {
  projectId: string;
  sandbox: Sandbox;
  systemPrompt: string;
  userMessage: string;
  existingMessages?: OpenAI.ChatCompletionMessageParam[];
  maxSteps?: number;
  maxTokensPerTurn?: number;
}

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  steps: number;
  previewUrl: string | null;
  finalMessages: OpenAI.ChatCompletionMessageParam[];
}

// ─── Agent Loop 主函数 ───────────────────────────────────────────────────────────

export async function agentLoop(
  config: AgentLoopConfig
): Promise<AgentLoopResult> {
  const {
    projectId,
    sandbox,
    systemPrompt,
    userMessage,
    maxSteps = 50,
    maxTokensPerTurn = 8192,
  } = config;

  // 初始化 LLM 客户端
  const providerConfig = getProviderConfig();
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || providerConfig.baseURL,
  });
  const model = process.env.LLM_MODEL || providerConfig.defaultModel;

  // 工具执行上下文
  const toolCtx: ToolContext = {
    sandbox,
    projectId,
    projectDir: "/home/user/app",
  };

  // 初始化消息
  const messages: OpenAI.ChatCompletionMessageParam[] = config.existingMessages
    ? [...config.existingMessages, { role: "user" as const, content: userMessage }]
    : [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userMessage },
      ];

  let previewUrl: string | null = null;
  let step = 0;
  const totalStart = Date.now();

  console.log(
    `[AgentLoop] [${projectId.slice(0, 8)}] 开始 | model=${model} | maxSteps=${maxSteps}`
  );

  for (step = 1; step <= maxSteps; step++) {
    const stepStart = Date.now();

    // ─── 取消检查 ──────────────────────────────────────────────────────────

    if (await isCancelled(projectId)) {
      console.log(`[AgentLoop] [${projectId.slice(0, 8)}] step=${step} 项目已取消，退出`);
      await publishEvent(projectId, {
        type: "status_change",
        data: { status: "stopped", message: "已取消" },
      });
      return {
        success: false,
        summary: "已取消",
        steps: step,
        previewUrl,
        finalMessages: messages,
      };
    }

    // ─── 调用 LLM ──────────────────────────────────────────────────────────

    let response: OpenAI.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools: AGENT_TOOLS as unknown as OpenAI.ChatCompletionTool[],
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: maxTokensPerTurn,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} LLM 调用失败: ${msg}`
      );

      // 重试一次
      try {
        await new Promise((r) => setTimeout(r, 2000));
        response = await client.chat.completions.create({
          model,
          messages,
          tools: AGENT_TOOLS as unknown as OpenAI.ChatCompletionTool[],
          tool_choice: "auto",
          temperature: 0.3,
          max_tokens: maxTokensPerTurn,
        });
      } catch (retryError) {
        const retryMsg =
          retryError instanceof Error ? retryError.message : String(retryError);
        console.error(
          `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} LLM 重试失败: ${retryMsg}`
        );
        return {
          success: false,
          summary: `LLM 调用失败: ${retryMsg}`,
          steps: step,
          previewUrl,
          finalMessages: messages,
        };
      }
    }

    const choice = response.choices[0];
    if (!choice) {
      console.error(
        `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} LLM 返回空 choices`
      );
      return {
        success: false,
        summary: "LLM 返回空响应",
        steps: step,
        previewUrl,
        finalMessages: messages,
      };
    }

    const assistantMessage = choice.message;

    // ─── 推送 Agent 思考内容 ────────────────────────────────────────────────

    if (assistantMessage.content) {
      await publishEvent(projectId, {
        type: "agent_thinking",
        data: { content: assistantMessage.content },
      });

      console.log(
        `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} 💭 ${assistantMessage.content.slice(0, 120)}`
      );
    }

    // ─── 追加 assistant 消息到历史 ──────────────────────────────────────────

    messages.push(assistantMessage);

    // ─── 无 tool_calls → Agent 认为完成 ─────────────────────────────────────

    if (
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      const duration = ((Date.now() - totalStart) / 1000).toFixed(1);
      console.log(
        `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} 无 tool_call，隐式结束 | total=${duration}s`
      );
      return {
        success: !!previewUrl,
        summary: assistantMessage.content || "Agent 结束",
        steps: step,
        previewUrl,
        finalMessages: messages,
      };
    }

    // ─── 执行每个 tool_call ──────────────────────────────────────────────────

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      // 每个 tool 执行前检查取消
      if (await isCancelled(projectId)) {
        console.log(`[AgentLoop] [${projectId.slice(0, 8)}] step=${step} 项目已取消（tool 执行前），退出`);
        await publishEvent(projectId, {
          type: "status_change",
          data: { status: "stopped", message: "已取消" },
        });
        return {
          success: false,
          summary: "已取消",
          steps: step,
          previewUrl,
          finalMessages: messages,
        };
      }

      const fn = toolCall.function;
      const fnName = fn.name;
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(fn.arguments || "{}");
      } catch {
        // JSON 解析失败，返回错误让 Agent 重试
        messages.push({
          role: "tool",
          content: `Error: Invalid JSON in tool arguments. Please retry with valid JSON.\nRaw: ${fn.arguments?.slice(0, 200)}`,
          tool_call_id: toolCall.id,
        });
        console.log(
          `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} ⚠️ ${fnName} JSON parse error`
        );
        continue;
      }

      // 推送 tool_call 事件给前端
      await publishToolCallEvent(projectId, fnName, args);

      // ─── 执行工具 ──────────────────────────────────────────────────────────

      const toolStart = Date.now();
      const result = await executeTool(fnName, args, toolCtx);
      const toolDuration = ((Date.now() - toolStart) / 1000).toFixed(1);

      // 推送 tool_result 事件
      await publishToolResultEvent(projectId, fnName, result);

      // 特殊事件：preview_ready
      if (fnName === "get_preview_url" && result.success) {
        previewUrl = result.output;
        await publishEvent(projectId, {
          type: "preview_ready",
          data: { previewUrl },
        });
      }

      // 特殊事件：文件写入完成
      if (fnName === "write_file" && result.success) {
        await publishEvent(projectId, {
          type: "codegen_file_done",
          data: { path: args.path as string },
        });
      }

      // 记录构建日志
      if (fnName === "run_shell") {
        const command = args.command as string;
        if (command.includes("build") || command.includes("tsc")) {
          await prisma.buildLog.create({
            data: {
              projectId,
              command,
              stdout: result.output.slice(0, 10000),
              stderr: "",
              exitCode: result.success ? 0 : 1,
              attempt: step,
            },
          });
        }
      }

      // 追加 tool result 到 messages（截断防止 context 溢出）
      messages.push({
        role: "tool",
        content: truncateOutput(result.output, 4000),
        tool_call_id: toolCall.id,
      });

      const icon = result.success ? "✓" : "✗";
      console.log(
        `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} ${icon} ${fnName} | ${toolDuration}s`
      );
    }

    const stepDuration = ((Date.now() - stepStart) / 1000).toFixed(1);
    console.log(
      `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} 完成 | ${stepDuration}s`
    );
  }

  // ─── 超过 maxSteps 兜底 ────────────────────────────────────────────────────

  const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(
    `[AgentLoop] [${projectId.slice(0, 8)}] 达到最大步数 ${maxSteps} | total=${totalDuration}s`
  );

  return {
    success: !!previewUrl,
    summary: `达到最大步数限制 (${maxSteps})`,
    steps: maxSteps,
    previewUrl,
    finalMessages: messages,
  };
}

// ─── SSE 事件推送辅助 ────────────────────────────────────────────────────────────

async function publishToolCallEvent(
  projectId: string,
  tool: string,
  args: Record<string, unknown>
): Promise<void> {
  // 不暴露完整文件内容给前端
  const sanitizedArgs = { ...args };
  if (tool === "write_file" && typeof sanitizedArgs.content === "string") {
    const lines = (sanitizedArgs.content as string).split("\n").length;
    sanitizedArgs.content = `(${lines} lines)`;
  }

  // 复用 codegen_file_start 事件（前端已有处理）
  if (tool === "write_file" && args.path) {
    await publishEvent(projectId, {
      type: "codegen_file_start",
      data: { path: args.path as string },
    });
  }

  // 复用 build_log 事件
  if (tool === "run_shell") {
    const cmd = args.command as string;
    await publishEvent(projectId, {
      type: "build_log",
      data: { stream: "stdout", line: `$ ${cmd}` },
    });
  }
}

async function publishToolResultEvent(
  projectId: string,
  tool: string,
  result: ToolResult
): Promise<void> {
  // 构建命令的输出推送为 build_log
  if (tool === "run_shell") {
    const summary = result.output.slice(0, 500);
    const stream = result.success ? "stdout" : "stderr";
    await publishEvent(projectId, {
      type: "build_log",
      data: { stream, line: summary },
    });
  }
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────────

function truncateOutput(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return (
    str.slice(0, maxLen) +
    `\n...(truncated, total ${str.length} chars)`
  );
}
