/**
 * Agent Loop 核心
 *
 * ReAct 循环：LLM 思考 → 选择工具 → 执行 → 观察结果 → 继续
 * 与 v6 的区别：
 * - 无 assertRunWritable（停止靠 sandbox.kill()）
 * - 无 prisma 依赖（DB 操作通过 HTTP 回调）
 * - ask_user 使用 Redis BRPOP 阻塞（沙盒保持运行）
 * - 集成上下文压缩
 */

import OpenAI from "openai";
import { createLLMClient, getModel, chatCompletionWithTools } from "./llm-client.js";
import { AGENT_TOOLS, executeTool, callInternalAPI } from "./tools.js";
import { InLoopCompressor } from "./context-compressor.js";
import type {
  RuntimeConfig,
  ToolContext,
  AgentLoopResult,
  EventEmitterInterface,
  LoggerInterface,
  RedisInterface,
} from "./types.js";

export interface AgentLoopConfig {
  config: RuntimeConfig;
  systemPrompt: string;
  userMessage: string;
  existingMessages?: OpenAI.ChatCompletionMessageParam[];
  eventEmitter: EventEmitterInterface;
  logger: LoggerInterface;
  redis: RedisInterface;
  initialStep?: number;
  initialAskUserCount?: number;
}

export async function agentLoop(loopConfig: AgentLoopConfig): Promise<AgentLoopResult> {
  const {
    config,
    systemPrompt,
    userMessage,
    eventEmitter,
    logger,
    redis,
    initialStep = 0,
    initialAskUserCount = 0,
  } = loopConfig;

  const client = createLLMClient(config);
  const model = getModel(config);
  const compressor = new InLoopCompressor();

  const toolCtx: ToolContext = {
    projectId: config.projectId,
    runId: config.runId,
    projectDir: config.projectDir,
    eventEmitter,
    logger,
    redis,
    config,
    askUserCount: initialAskUserCount,
  };

  // 初始化消息
  const messages: OpenAI.ChatCompletionMessageParam[] = loopConfig.existingMessages
    ? [
        ...loopConfig.existingMessages,
        ...(userMessage ? [{ role: "user" as const, content: userMessage }] : []),
      ]
    : [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userMessage },
      ];

  let previewUrl: string | null = null;
  const totalStart = Date.now();

  logger.info("Agent Loop started", {
    model,
    maxSteps: config.maxSteps,
    mode: config.mode,
    messageCount: messages.length,
  });

  for (let step = initialStep + 1; step <= config.maxSteps; step++) {
    await eventEmitter.emitStepStart(step);

    // ─── 上下文压缩检查 ─────────────────────────────────────────────────
    if (compressor.shouldCompress(messages, step)) {
      const before = messages.length;
      const compressed = compressor.compress(messages);
      messages.length = 0;
      messages.push(...compressed);
      logger.info("Context compressed", { step, before, after: messages.length });
    }

    // ─── 调用 LLM ──────────────────────────────────────────────────────
    let response: OpenAI.ChatCompletion;
    try {
      response = await chatCompletionWithTools(
        client,
        model,
        messages,
        AGENT_TOOLS as unknown as OpenAI.ChatCompletionTool[],
        { maxTokens: config.maxTokensPerTurn }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`LLM call failed, retrying...`, { step, error: msg });

      await new Promise((r) => setTimeout(r, 2000));

      try {
        response = await chatCompletionWithTools(
          client,
          model,
          messages,
          AGENT_TOOLS as unknown as OpenAI.ChatCompletionTool[],
          { maxTokens: config.maxTokensPerTurn }
        );
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        logger.error("LLM retry failed", { step, error: retryMsg });
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
      logger.error("LLM returned empty choices", { step });
      return {
        success: false,
        summary: "LLM 返回空响应",
        steps: step,
        previewUrl,
        finalMessages: messages,
      };
    }

    const assistantMessage = choice.message;

    // ─── 推送思考内容 ───────────────────────────────────────────────────
    if (assistantMessage.content) {
      await eventEmitter.emitThinking(assistantMessage.content);
      logger.info(`step=${step} thinking`, { content: assistantMessage.content.slice(0, 120) });
    }

    messages.push(assistantMessage);

    // ─── 无 tool_calls → 继续循环 ──────────────────────────────────────
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      logger.info(`step=${step} no tool_call, continuing`);
      continue;
    }

    // ─── 执行每个 tool_call ─────────────────────────────────────────────
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

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
        logger.warn(`step=${step} ${fnName} JSON parse error`);
        continue;
      }

      // ─── finish 处理 ───────────────────────────────────────────────────
      if (fnName === "finish") {
        const finishArgs = args as { summary: string; success: boolean };
        const duration = ((Date.now() - totalStart) / 1000).toFixed(1);

        messages.push({
          role: "tool",
          content: `任务已完成: ${finishArgs.summary}`,
          tool_call_id: toolCall.id,
        });

        logger.info(`step=${step} finish called`, { duration, success: finishArgs.success });

        return {
          success: finishArgs.success,
          summary: finishArgs.summary,
          steps: step,
          previewUrl,
          finalMessages: messages,
        };
      }

      // ─── 正常工具执行 ─────────────────────────────────────────────────
      await eventEmitter.emitToolCall(fnName, args);

      const toolStart = Date.now();
      const result = await executeTool(fnName, args, toolCtx);
      const toolDuration = ((Date.now() - toolStart) / 1000).toFixed(1);

      await eventEmitter.emitToolCallComplete(fnName, result.success, result.output);

      // 特殊处理：preview_ready
      if (fnName === "get_preview_url" && result.success) {
        previewUrl = result.output;
        await eventEmitter.emitPreviewReady(previewUrl);
      }

      // ask_user 超时导致任务暂停
      if (fnName === "ask_user" && !result.success && result.output.includes("暂停")) {
        return {
          success: false,
          summary: result.output,
          steps: step,
          previewUrl,
          finalMessages: messages,
        };
      }

      messages.push({
        role: "tool",
        content: result.output.slice(0, 4000),
        tool_call_id: toolCall.id,
      });

      logger.info(`step=${step} tool=${fnName} done`, {
        success: result.success,
        duration: toolDuration,
      });
    }
  }

  // 超过最大步数
  const duration = ((Date.now() - totalStart) / 1000).toFixed(1);
  logger.warn("Max steps reached", { maxSteps: config.maxSteps, duration });

  return {
    success: false,
    summary: `已达到最大步数限制 (${config.maxSteps})`,
    steps: config.maxSteps,
    previewUrl,
    finalMessages: messages,
  };
}
