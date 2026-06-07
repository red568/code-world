/**
 * Agent Loop 核心 v2
 *
 * ReAct 循环：LLM 思考 → 选择工具 → 执行 → 观察结果 → 继续
 *
 * v2 改动：
 * - 替换 InLoopCompressor，使用 ContextManager（全量落盘 + 外部压缩）
 * - 集成 EpisodeRecorder（结构化元数据记录）
 * - 集成 TaskSummarizer（任务状态聚合）
 * - 集成 CodeSyncScheduler（周期性代码同步）
 * - 集成 ContextAssembler（Slot 化上下文组装）
 */

import OpenAI from "openai";
import { createLLMClient, getModel, chatCompletionWithTools } from "./llm-client.js";
import { AGENT_TOOLS, executeTool, callInternalAPI } from "./tools.js";
import { ContextManager } from "./context-manager.js";
import { ContextAssembler } from "./context-assembler.js";
import { EpisodeRecorder } from "./episode-recorder.js";
import { TaskSummarizer } from "./task-summary.js";
import { CodeSyncScheduler } from "./code-sync.js";
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
  // v2: 恢复时注入
  initialSummary?: string;
  initialSummaryCoversStep?: number;
  initialSummaryVersion?: number;
  pendingMessages?: OpenAI.ChatCompletionMessageParam[];
  repoMap?: string;
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

  // ─── 初始化 v2 模块 ──────────────────────────────────────────────────
  const contextManager = new ContextManager(config, logger);
  const contextAssembler = new ContextAssembler();
  const episodeRecorder = new EpisodeRecorder();
  const taskSummarizer = new TaskSummarizer();
  const codeSyncScheduler = new CodeSyncScheduler(config, logger);

  // 恢复状态（如果有）
  if (loopConfig.initialSummary) {
    contextManager.setInitialSummary(
      loopConfig.initialSummary,
      loopConfig.initialSummaryCoversStep || 0,
      loopConfig.initialSummaryVersion || 0
    );
  }
  if (loopConfig.repoMap) {
    contextAssembler.setRepoMap(loopConfig.repoMap);
  }

  // 设置用户目标
  taskSummarizer.setUserGoal(userMessage.slice(0, 200));

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

  // ─── 初始化消息 ──────────────────────────────────────────────────────
  // 优先级：
  //   1. existingMessages（沙盒复用，Redis 缓存的完整对话）
  //   2. initialSummary + pendingMessages（跨 run 恢复，有压缩历史）
  //   3. pendingMessages only（跨 run 恢复，短 run 未触发压缩）
  //   4. 全新对话（首次 generate）
  let messages: OpenAI.ChatCompletionMessageParam[];

  if (loopConfig.existingMessages) {
    // 场景：沙盒未销毁，iterate 复用（Redis 缓存命中）
    messages = [
      ...loopConfig.existingMessages,
      ...(userMessage ? [{ role: "user" as const, content: userMessage }] : []),
    ];
  } else if (loopConfig.initialSummary) {
    // 场景：沙盒重建，上次 run 触发过压缩
    // recentMessages = pending（压缩后到销毁前的对话）+ 本次新 user message
    const pendingMsgs = (loopConfig.pendingMessages || []) as OpenAI.ChatCompletionMessageParam[];
    const recentMessages: OpenAI.ChatCompletionMessageParam[] = [
      ...pendingMsgs,
      ...(userMessage ? [{ role: "user" as const, content: userMessage }] : []),
    ];

    messages = contextAssembler.assemblePostCompression(
      systemPrompt,
      loopConfig.initialSummary,
      recentMessages,
      taskSummarizer,
      episodeRecorder.getAll()
    );
  } else if (loopConfig.pendingMessages && loopConfig.pendingMessages.length > 0) {
    // 场景：沙盒重建，上次 run 未触发压缩但有落盘的历史对话
    // 将 pending messages 作为上下文注入（它们包含了完整的上次对话记录）
    const pendingMsgs = loopConfig.pendingMessages as OpenAI.ChatCompletionMessageParam[];

    // pending messages 的第一条可能是 system prompt（如果是从完整对话落盘的）
    // 检查是否已有 system，没有则补上
    const hasSystem = pendingMsgs.length > 0 && pendingMsgs[0].role === "system";
    messages = [
      ...(hasSystem ? [] : [{ role: "system" as const, content: systemPrompt }]),
      ...pendingMsgs,
      ...(userMessage ? [{ role: "user" as const, content: userMessage }] : []),
    ];
  } else {
    // 场景：全新项目，首次 generate
    messages = [
      { role: "system" as const, content: systemPrompt },
      ...(userMessage ? [{ role: "user" as const, content: userMessage }] : []),
    ];
  }

  // 注入 Repo Map（如果有且消息中尚未包含）
  if (loopConfig.repoMap && !messages.some((m) => typeof m.content === "string" && m.content.includes("[项目代码骨架]"))) {
    // 在 system prompt 之后注入
    const insertIdx = messages[0]?.role === "system" ? 1 : 0;
    messages.splice(insertIdx, 0, {
      role: "system" as const,
      content: `[项目代码骨架]\n${loopConfig.repoMap}`,
    });
  }

  let previewUrl: string | null = null;
  const totalStart = Date.now();

  logger.info("Agent Loop v2 started", {
    model,
    maxSteps: config.maxSteps,
    mode: config.mode,
    messageCount: messages.length,
    hasSummary: !!loopConfig.initialSummary,
    hasRepoMap: !!loopConfig.repoMap,
  });

  for (let step = initialStep + 1; step <= config.maxSteps; step++) {
    await eventEmitter.emitStepStart(step);

    // ─── 上下文压缩检查（v2: 外部服务） ─────────────────────────────────
    const compressionResult = await contextManager.checkAndCompress(messages, step);
    if (compressionResult.compressed) {
      messages = compressionResult.messages;

      // 压缩后重新注入 Repo Map 和 Task Summary
      const slotC = contextAssembler.getRepoMap();
      if (slotC && !messages.some((m) => typeof m.content === "string" && m.content.includes("[项目代码骨架]"))) {
        messages.splice(2, 0, { role: "system" as const, content: `[项目代码骨架]\n${slotC}` });
      }

      logger.info("Context compressed via external service", { step, messagesNow: messages.length });
    }

    // ─── 周期性代码同步 ────────────────────────────────────────────────
    await codeSyncScheduler.checkAndSync(step);

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
        await finalizeBeforeExit(contextManager, codeSyncScheduler, messages, step, logger);
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
      await finalizeBeforeExit(contextManager, codeSyncScheduler, messages, step, logger);
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

        // 销毁前同步
        await finalizeBeforeExit(contextManager, codeSyncScheduler, messages, step, logger);

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

      // ─── Episode 记录 ─────────────────────────────────────────────────
      const episode = episodeRecorder.record({
        stepNumber: step,
        toolName: fnName,
        toolSuccess: result.success,
        toolArgs: args,
        toolResult: result.output,
        thinking: assistantMessage.content || undefined,
      });
      taskSummarizer.update(episode);

      // ─── 标记脏文件（代码同步用） ─────────────────────────────────────
      if (fnName === "write_file" && result.success && args.path) {
        codeSyncScheduler.markDirty(String(args.path));
      }

      // 特殊处理：preview_ready
      if (fnName === "get_preview_url" && result.success) {
        previewUrl = result.output;
        await eventEmitter.emitPreviewReady(previewUrl);
      }

      // ask_user 超时导致任务暂停
      if (fnName === "ask_user" && !result.success && result.output.includes("暂停")) {
        await finalizeBeforeExit(contextManager, codeSyncScheduler, messages, step, logger);
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
  await finalizeBeforeExit(contextManager, codeSyncScheduler, messages, config.maxSteps, logger);

  return {
    success: false,
    summary: `已达到最大步数限制 (${config.maxSteps})`,
    steps: config.maxSteps,
    previewUrl,
    finalMessages: messages,
  };
}

/**
 * 退出前的清理：存储剩余 messages + 全量代码同步
 */
async function finalizeBeforeExit(
  contextManager: ContextManager,
  codeSyncScheduler: CodeSyncScheduler,
  messages: OpenAI.ChatCompletionMessageParam[],
  currentStep: number,
  logger: LoggerInterface
): Promise<void> {
  try {
    await Promise.all([
      contextManager.storeRemainingMessages(messages, currentStep),
      codeSyncScheduler.syncFinal(),
    ]);
  } catch (error) {
    logger.warn("Finalize before exit partially failed", { error: String(error) });
  }
}
