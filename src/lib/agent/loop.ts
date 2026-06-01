/**
 * Agent Loop 引擎
 *
 * 核心 ReAct 循环：LLM 思考 → 选择工具 → 执行 → 观察结果 → 继续
 * 使用 assertRunWritable 做检查点校验（替代旧的 Redis cancel flag）。
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
import { assertRunWritable, RunNotWritableError } from "@/lib/queue/run-fencing";
import type { Sandbox } from "@e2b/code-interpreter";
import type { Prisma } from "@/generated/prisma/client";

// ─── 类型定义 ────────────────────────────────────────────────────────────────────

export interface AgentLoopConfig {
  runId: string;
  projectId: string;
  sandbox: Sandbox;
  systemPrompt: string;
  userMessage: string;
  existingMessages?: OpenAI.ChatCompletionMessageParam[];
  maxSteps?: number;
  maxTokensPerTurn?: number;
  initialStep?: number;
  initialAskUserCount?: number;
}

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  steps: number;
  previewUrl: string | null;
  finalMessages: OpenAI.ChatCompletionMessageParam[];
  suspended?: boolean;
}

export interface LoopSuspendState {
  messages: OpenAI.ChatCompletionMessageParam[];
  completedToolResults: { tool_call_id: string; content: string }[];
  pendingToolCallId: string;
  pendingArgs: { question: string; options: { label: string; description: string }[]; context: string };
  step: number;
  askUserCount: number;
  previewUrl: string | null;
  answerToken: string;
}

// ─── Agent Loop 主函数 ───────────────────────────────────────────────────────────

export async function agentLoop(
  config: AgentLoopConfig
): Promise<AgentLoopResult> {
  const {
    runId,
    projectId,
    sandbox,
    systemPrompt,
    userMessage,
    maxSteps = 50,
    maxTokensPerTurn = 8192,
    initialStep = 0,
    initialAskUserCount = 0,
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
    ? [...config.existingMessages, ...(userMessage ? [{ role: "user" as const, content: userMessage }] : [])]
    : [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userMessage },
      ];

  let previewUrl: string | null = null;
  let step = 0;
  let askUserCount = initialAskUserCount;
  const totalStart = Date.now();

  console.log(
    `[AgentLoop] [${projectId.slice(0, 8)}] 开始 | run=${runId.slice(0, 8)} | model=${model} | maxSteps=${maxSteps}`
  );

  for (step = initialStep + 1; step <= maxSteps; step++) {
    const stepStart = Date.now();

    // ─── 检查点 1：每轮 LLM 调用前 ──────────────────────────────────────────
    try {
      await assertRunWritable(runId);
    } catch (e) {
      if (e instanceof RunNotWritableError) {
        console.log(`[AgentLoop] [${projectId.slice(0, 8)}] step=${step} Run 已失去写权限，退出`);
        return {
          success: false,
          summary: "已取消",
          steps: step,
          previewUrl,
          finalMessages: messages,
        };
      }
      throw e;
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

    // ─── 无 tool_calls → 继续循环（可能是在回答用户问题）─────────────────────

    if (
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      console.log(
        `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} 无 tool_call，继续等待（可能在回答用户问题）`
      );
      // 不终止，继续下一轮循环
      continue;
    }

    // ─── 执行每个 tool_call ──────────────────────────────────────────────────

    const completedToolResults: { tool_call_id: string; content: string }[] = [];

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      // ─── 检查点 2：每个 tool 执行前 ────────────────────────────────────────
      try {
        await assertRunWritable(runId);
      } catch (e) {
        if (e instanceof RunNotWritableError) {
          console.log(`[AgentLoop] [${projectId.slice(0, 8)}] step=${step} Run 已失去写权限（tool 执行前），退出`);
          return {
            success: false,
            summary: "已取消",
            steps: step,
            previewUrl,
            finalMessages: messages,
          };
        }
        throw e;
      }

      const fn = toolCall.function;
      const fnName = fn.name;
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(fn.arguments || "{}");
      } catch {
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

      // ─── ask_user 特殊处理：挂起 loop ─────────────────────────────────────
      if (fnName === "ask_user") {
        if (askUserCount >= 3) {
          messages.push({
            role: "tool",
            content: "系统限制：本次任务已多次向用户提问。请基于现有信息自行做出最佳判断，继续执行。",
            tool_call_id: toolCall.id,
          });
          console.log(
            `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} ⚠️ ask_user 被 failsafe 拒绝（count=${askUserCount}）`
          );
          continue;
        }

        askUserCount++;
        const answerToken = `${runId}-ask-${askUserCount}-${Date.now()}`;
        const askArgs = args as { question: string; options: { label: string; description: string }[]; context: string };

        // 推送 ask_user 事件给前端
        await publishEvent(projectId, {
          type: "ask_user",
          data: {
            runId,
            question: askArgs.question,
            options: askArgs.options,
            context: askArgs.context,
            answerToken,
          },
        });

        // 构造挂起状态：裁剪 assistant message 中 ask_user 之后的 tool_calls
        const askUserIndex = assistantMessage.tool_calls.indexOf(toolCall);
        const trimmedAssistantMessage = {
          ...assistantMessage,
          tool_calls: assistantMessage.tool_calls.slice(0, askUserIndex + 1),
        };
        const suspendMessages = [...messages.slice(0, -1), trimmedAssistantMessage];

        const suspendState: LoopSuspendState = {
          messages: suspendMessages,
          completedToolResults,
          pendingToolCallId: toolCall.id,
          pendingArgs: askArgs,
          step,
          askUserCount,
          previewUrl,
          answerToken,
        };

        // 保存到 DB
        await prisma.loopState.upsert({
          where: { runId },
          create: {
            runId,
            messages: suspendMessages as unknown as Prisma.InputJsonValue,
            step,
            state: {
              completedToolResults,
              pendingToolCallId: toolCall.id,
              pendingArgs: askArgs,
              askUserCount,
              previewUrl,
            } as unknown as Prisma.InputJsonValue,
            answerToken,
          },
          update: {
            messages: suspendMessages as unknown as Prisma.InputJsonValue,
            step,
            state: {
              completedToolResults,
              pendingToolCallId: toolCall.id,
              pendingArgs: askArgs,
              askUserCount,
              previewUrl,
            } as unknown as Prisma.InputJsonValue,
            answerToken,
          },
        });

        await prisma.projectRun.update({
          where: { id: runId },
          data: { status: "waiting_for_user" },
        });

        console.log(
          `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} ⏸️ ask_user 挂起 | question="${askArgs.question.slice(0, 50)}"`
        );

        return {
          success: false,
          summary: "等待用户确认",
          steps: step,
          previewUrl,
          finalMessages: messages,
          suspended: true,
        };
      }

      // ─── finish 特殊处理：终止 loop ─────────────────────────────────────────
      if (fnName === "finish") {
        const finishArgs = args as { summary: string; success: boolean };
        const duration = ((Date.now() - totalStart) / 1000).toFixed(1);

        console.log(
          `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} ✓ finish 调用，任务结束 | total=${duration}s`
        );

        // 追加 finish 工具的结果到消息历史
        messages.push({
          role: "tool",
          content: `任务已完成: ${finishArgs.summary}`,
          tool_call_id: toolCall.id,
        });

        return {
          success: finishArgs.success,
          summary: finishArgs.summary,
          steps: step,
          previewUrl,
          finalMessages: messages,
        };
      }

      // ─── 正常工具执行 ──────────────────────────────────────────────────────

      // 推送 tool_call 事件给前端
      await publishToolCallEvent(projectId, fnName, args);

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
              runId,
              command,
              stdout: result.output.slice(0, 10000),
              stderr: "",
              exitCode: result.success ? 0 : 1,
              attempt: step,
            },
          });
        }
      }

      // 追加 tool result 到 messages
      const toolResultContent = truncateOutput(result.output, 4000);
      messages.push({
        role: "tool",
        content: toolResultContent,
        tool_call_id: toolCall.id,
      });
      completedToolResults.push({ tool_call_id: toolCall.id, content: toolResultContent });

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
  const sanitizedArgs = { ...args };
  if (tool === "write_file" && typeof sanitizedArgs.content === "string") {
    const lines = (sanitizedArgs.content as string).split("\n").length;
    sanitizedArgs.content = `(${lines} lines)`;
  }

  if (tool === "write_file" && args.path) {
    await publishEvent(projectId, {
      type: "codegen_file_start",
      data: { path: args.path as string },
    });
  }

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
