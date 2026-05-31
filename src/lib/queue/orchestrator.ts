/**
 * Run 执行编排器
 *
 * 统一入口 orchestrateRun：根据 run.type 决定 generate/iterate 流程。
 * 检查点通过 assertRunWritable 拦截已取消的 run。
 * 结束时通过 finalizeRun 条件更新，防止覆盖 Stop。
 */

import { prisma } from "@/lib/prisma";
import {
  createSandbox,
  connectSandbox,
  writeTemplateFiles,
  keepAlive,
  stopSandbox,
} from "@/lib/sandbox";
import {
  publishStatusChange,
  publishError,
} from "@/lib/streaming";
import { agentLoop, type AgentLoopResult } from "@/lib/agent/loop";
import {
  BUILDER_SYSTEM_PROMPT,
  buildIteratePromptReused,
  buildIteratePromptWithContext,
} from "@/lib/agent/prompt";
import {
  estimateTokens,
  generateConversationSummary,
  compressMessagesIfNeeded,
} from "@/lib/agent/conversation";
import {
  finalizeRun,
  resetHeartbeatCounter,
  RunNotWritableError,
} from "@/lib/queue/run-fencing";
import type { Sandbox } from "@e2b/code-interpreter";
import type OpenAI from "openai";
import type { Prisma } from "@/generated/prisma/client";

type Messages = OpenAI.ChatCompletionMessageParam[];

function log(projectId: string, stage: string, message: string) {
  console.log(
    `[Orchestrator] [${projectId.slice(0, 8)}] [${stage}] ${message}`
  );
}

/**
 * 统一 run 执行入口
 */
export async function orchestrateRun(
  runId: string,
  projectId: string
): Promise<void> {
  resetHeartbeatCounter(runId);

  const run = await prisma.projectRun.findUnique({
    where: { id: runId },
    include: { project: true },
  });

  if (!run || run.status !== "running") {
    log(projectId, "start", `Run ${runId.slice(0, 8)} 状态异常，退出`);
    return;
  }

  // 检查是否是从 ask_user 恢复的 run
  const loopState = await prisma.loopState.findUnique({ where: { runId } });
  if (loopState) {
    const state = loopState.state as Record<string, unknown>;
    if (state.resumeReady) {
      await executeResume(runId, projectId, loopState);
      return;
    }
  }

  if (run.type === "generate") {
    await executeGenerate(runId, projectId, run.prompt);
  } else {
    await executeIterate(runId, projectId, run.prompt);
  }
}

// ─── Generate 流程 ───────────────────────────────────────────────────────────────

async function executeGenerate(
  runId: string,
  projectId: string,
  prompt: string
): Promise<void> {
  let sandbox: Sandbox | null = null;
  const totalStart = Date.now();
  log(projectId, "start", `开始生成 | run=${runId.slice(0, 8)}`);

  try {
    await prisma.project.update({
      where: { id: projectId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: "code_generating" as any },
    });
    await publishStatusChange(projectId, "code_generating", "Agent 开始工作...");

    log(projectId, "sandbox", "创建 E2B 沙箱...");
    const instance = await createSandbox();
    sandbox = instance.sandbox;
    log(projectId, "sandbox", `就绪 | id=${instance.sandboxId}`);

    await prisma.projectRun.update({
      where: { id: runId },
      data: { sandboxId: instance.sandboxId },
    });

    await writeTemplateFiles(sandbox);

    log(projectId, "agent", "启动 Agent Loop");
    const result: AgentLoopResult = await agentLoop({
      runId,
      projectId,
      sandbox,
      systemPrompt: BUILDER_SYSTEM_PROMPT,
      userMessage: prompt,
      maxSteps: 50,
    });

    if (result.suspended) {
      log(projectId, "agent", "Agent Loop 挂起等待用户");
      return;
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);
    await handleResult(runId, projectId, result, sandbox, instance.sandboxId, totalDuration, false);
  } catch (error) {
    await handleError(error, runId, projectId, sandbox, false);
  }
}

// ─── Iterate 流程 ────────────────────────────────────────────────────────────────

async function executeIterate(
  runId: string,
  projectId: string,
  prompt: string
): Promise<void> {
  let sandbox: Sandbox | null = null;
  let isReused = false;
  let sandboxId: string | undefined;
  const totalStart = Date.now();
  log(projectId, "start", `开始迭代 | run=${runId.slice(0, 8)}`);

  try {
    await prisma.project.update({
      where: { id: projectId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: "code_generating" as any },
    });
    await publishStatusChange(projectId, "code_generating", "Agent 开始修改...");

    const conversation = await loadConversation(projectId);

    sandbox = await tryReuseSandbox(projectId);
    if (sandbox) {
      isReused = true;
      log(projectId, "sandbox", "复用沙箱");
    }

    if (!sandbox) {
      log(projectId, "sandbox", "创建 E2B 沙箱...");
      const instance = await createSandbox();
      sandbox = instance.sandbox;
      sandboxId = instance.sandboxId;
      log(projectId, "sandbox", `就绪 | id=${instance.sandboxId}`);

      await writeTemplateFiles(sandbox);

      const dbFiles = await prisma.projectFile.findMany({
        where: { projectId },
      });
      for (const file of dbFiles) {
        const fullPath = `/home/user/app/${file.path}`;
        const dir = fullPath.split("/").slice(0, -1).join("/");
        await sandbox.commands.run(`mkdir -p ${dir}`);
        await sandbox.files.write(fullPath, file.content);
      }
      log(projectId, "sandbox", `恢复文件 | count=${dbFiles.length}`);

      if (conversation?.messages && conversation.messages.length > 0) {
        await handleSandboxExpiredConversation(projectId, conversation.messages);
      }
    }

    const finalSandboxId = sandboxId || (isReused ? conversation?.sandboxId ?? undefined : undefined);
    if (finalSandboxId) {
      await prisma.projectRun.update({
        where: { id: runId },
        data: { sandboxId: finalSandboxId },
      });
    }

    let existingMessages: Messages | undefined;
    let userMessage: string;

    if (isReused && conversation?.messages && conversation.messages.length > 0) {
      existingMessages = conversation.messages;
      userMessage = buildIteratePromptReused(prompt);
      log(projectId, "conversation", `复用对话 | msgs=${existingMessages.length}`);
    } else if (!isReused) {
      const conv = await loadConversation(projectId);
      userMessage = buildIteratePromptWithContext(prompt, conv?.summary ?? null);
    } else {
      userMessage = buildIteratePromptReused(prompt);
    }

    log(projectId, "agent", `启动 Agent Loop（${isReused ? "复用" : "新建"}模式）`);
    const result: AgentLoopResult = await agentLoop({
      runId,
      projectId,
      sandbox,
      systemPrompt: BUILDER_SYSTEM_PROMPT,
      userMessage,
      existingMessages,
      maxSteps: 50,
    });

    if (result.suspended) {
      log(projectId, "agent", "Agent Loop 挂起等待用户");
      return;
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);
    await handleResult(runId, projectId, result, sandbox, finalSandboxId, totalDuration, isReused);
  } catch (error) {
    await handleError(error, runId, projectId, sandbox, isReused);
  }
}

// ─── Resume 流程（从 ask_user 恢复）─────────────────────────────────────────────

async function executeResume(
  runId: string,
  projectId: string,
  loopState: { messages: unknown; step: number; state: unknown }
): Promise<void> {
  let sandbox: Sandbox | null = null;
  const totalStart = Date.now();
  const state = loopState.state as Record<string, unknown>;
  const userAnswer = state.userAnswer as string;
  const completedToolResults = (state.completedToolResults || []) as { tool_call_id: string; content: string }[];
  const pendingToolCallId = state.pendingToolCallId as string;
  const savedStep = loopState.step;
  const askUserCount = (state.askUserCount || 0) as number;
  const savedPreviewUrl = (state.previewUrl || null) as string | null;

  log(projectId, "resume", `恢复 Agent Loop | run=${runId.slice(0, 8)} | step=${savedStep}`);

  try {
    await publishStatusChange(projectId, "code_generating", "Agent 继续工作...");

    // 重建 messages
    const savedMessages = loopState.messages as Messages;
    const messages: Messages = [...savedMessages];
    for (const result of completedToolResults) {
      messages.push({ role: "tool", content: result.content, tool_call_id: result.tool_call_id });
    }
    messages.push({ role: "tool", content: userAnswer, tool_call_id: pendingToolCallId });

    // 恢复沙箱
    sandbox = await tryReuseSandbox(projectId);
    if (!sandbox) {
      log(projectId, "sandbox", "创建 E2B 沙箱...");
      const instance = await createSandbox();
      sandbox = instance.sandbox;
      await writeTemplateFiles(sandbox);

      const dbFiles = await prisma.projectFile.findMany({ where: { projectId } });
      for (const file of dbFiles) {
        const fullPath = `/home/user/app/${file.path}`;
        const dir = fullPath.split("/").slice(0, -1).join("/");
        await sandbox.commands.run(`mkdir -p ${dir}`);
        await sandbox.files.write(fullPath, file.content);
      }
      log(projectId, "sandbox", `恢复文件 | count=${dbFiles.length}`);
    }

    const result = await agentLoop({
      runId,
      projectId,
      sandbox,
      systemPrompt: BUILDER_SYSTEM_PROMPT,
      userMessage: "",
      existingMessages: messages,
      maxSteps: 50,
      initialStep: savedStep,
      initialAskUserCount: askUserCount,
    });

    // 清理 loopState
    await prisma.loopState.delete({ where: { runId } }).catch(() => {});

    if (result.suspended) {
      log(projectId, "resume", "再次挂起等待用户");
      return;
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);
    await handleResult(runId, projectId, result, sandbox, undefined, totalDuration, true);
  } catch (error) {
    await handleError(error, runId, projectId, sandbox, true);
  }
}

// ─── 结果处理 ────────────────────────────────────────────────────────────────────

async function handleResult(
  runId: string,
  projectId: string,
  result: AgentLoopResult,
  sandbox: Sandbox,
  sandboxId: string | undefined,
  totalDuration: string,
  isReused: boolean
): Promise<void> {
  if (result.summary === "已取消") {
    log(projectId, "end", `已取消 | steps=${result.steps} | total=${totalDuration}s`);
    await finalizeRun(runId, projectId, "failed", "已取消");
    if (sandbox && !isReused) {
      try { await stopSandbox(sandbox); } catch { /* ignore */ }
    }
    return;
  }

  if (result.success) {
    try {
      await keepAlive(sandbox, 15 * 60 * 1000);
    } catch { /* ignore */ }

    await saveConversation(projectId, result.finalMessages, sandboxId ?? undefined);
    await finalizeRun(runId, projectId, "succeeded");
    await publishStatusChange(projectId, "running", "预览就绪");
    log(projectId, "end", `成功 | steps=${result.steps} | total=${totalDuration}s`);
  } else {
    await saveConversation(projectId, result.finalMessages, sandboxId ?? undefined);
    await finalizeRun(runId, projectId, "failed", result.summary || "执行失败");
    await publishStatusChange(projectId, "failed", result.summary || "执行失败");
    log(projectId, "end", `失败 | steps=${result.steps} | total=${totalDuration}s`);

    if (sandbox && !isReused) {
      try { await stopSandbox(sandbox); } catch { /* ignore */ }
    }
  }
}

async function handleError(
  error: unknown,
  runId: string,
  projectId: string,
  sandbox: Sandbox | null,
  isReused: boolean
): Promise<void> {
  if (error instanceof RunNotWritableError) {
    log(projectId, "end", "Run 已失去写权限，退出");
    await finalizeRun(runId, projectId, "failed", "Run lost write permission");
    return;
  }

  const message = error instanceof Error ? error.message : "未知错误";
  log(projectId, "error", `异常: ${message}`);
  await publishError(projectId, message, "ORCHESTRATION_ERROR");
  await finalizeRun(runId, projectId, "failed", message);

  if (sandbox && !isReused) {
    try { await stopSandbox(sandbox); } catch { /* ignore */ }
  }
}

// ─── Sandbox 复用 ────────────────────────────────────────────────────────────────

async function tryReuseSandbox(projectId: string): Promise<Sandbox | null> {
  const lastRun = await prisma.projectRun.findFirst({
    where: {
      projectId,
      status: { in: ["succeeded", "failed"] },
      sandboxId: { not: null },
    },
    orderBy: { finishedAt: "desc" },
  });

  if (!lastRun?.sandboxId) return null;

  try {
    const instance = await connectSandbox(lastRun.sandboxId);
    return instance.sandbox;
  } catch {
    return null;
  }
}

// ─── 对话持久化辅助 ──────────────────────────────────────────────────────────────

async function saveConversation(
  projectId: string,
  messages: Messages,
  sandboxId?: string
): Promise<void> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { userId: true },
  });

  const compressed = compressMessagesIfNeeded(messages);
  const tokenEstimate = estimateTokens(compressed);

  await prisma.agentConversation.upsert({
    where: { projectId },
    create: {
      projectId,
      userId: project.userId,
      sandboxId: sandboxId ?? null,
      messages: compressed as unknown as Prisma.InputJsonValue,
      tokenEstimate,
    },
    update: {
      sandboxId: sandboxId ?? undefined,
      messages: compressed as unknown as Prisma.InputJsonValue,
      tokenEstimate,
      updatedAt: new Date(),
    },
  });

  log(projectId, "conversation", `已保存 | tokens≈${tokenEstimate} | msgs=${compressed.length}`);
}

async function loadConversation(
  projectId: string
): Promise<{ messages: Messages; summary: string | null; sandboxId: string | null } | null> {
  const conv = await prisma.agentConversation.findUnique({
    where: { projectId },
  });
  if (!conv) return null;

  return {
    messages: conv.messages as unknown as Messages,
    summary: conv.summary,
    sandboxId: conv.sandboxId,
  };
}

async function handleSandboxExpiredConversation(
  projectId: string,
  oldMessages: Messages
): Promise<void> {
  const summary = await generateConversationSummary(oldMessages);

  await prisma.agentConversation.update({
    where: { projectId },
    data: {
      summary,
      messages: [] as unknown as Prisma.InputJsonValue,
      sandboxId: null,
      tokenEstimate: 0,
    },
  });

  log(projectId, "conversation", `沙箱过期，已生成摘要`);
}
