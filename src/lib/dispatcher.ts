/**
 * 轻量调度器
 *
 * 职责：获取/创建沙盒 → 启动 agent-runtime 进程 → 异步监听退出。
 * Worker 调用 dispatchRun 后立即返回，不阻塞等待沙盒完成。
 */

import { prisma } from "@/lib/prisma";
import { sandboxSessionManager } from "./sandbox-session";

const AGENT_RUNTIME_TIMEOUT = 10 * 60 * 1000; // 10 分钟

export async function dispatchRun(runId: string, projectId: string): Promise<void> {
  const run = await prisma.projectRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Run ${runId} not found`);

  const mode = run.type === "generate" ? "generate" : "iterate";

  const { sandbox, isReused } = await sandboxSessionManager.acquireForProject(projectId);

  const skipFileRestore = isReused && mode === "iterate";

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  });

  if (!project) throw new Error(`Project ${projectId} not found`);

  const cmd = [
    "node /agent-runtime/dist/main.js",
    `--runId=${runId}`,
    `--projectId=${projectId}`,
    `--mode=${mode}`,
    `--skipFileRestore=${skipFileRestore}`,
  ].join(" ");

  const envs: Record<string, string> = {
    USER_ID: project.userId,
    RUN_ID: runId,
    PROJECT_ID: projectId,
    USER_MESSAGE: run.prompt,
    REDIS_URL: process.env.REDIS_URL!,
    LLM_API_KEY: process.env.LLM_API_KEY!,
    LLM_BASE_URL: process.env.LLM_BASE_URL || "",
    LLM_MODEL: process.env.LLM_MODEL || "",
    API_BASE_URL: process.env.API_BASE_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET!,
    SANDBOX_ID: sandbox.sandboxId,
    AXIOM_TOKEN: process.env.AXIOM_TOKEN || "",
  };

  // 异步执行（不 await），Worker 不阻塞等待完成
  sandbox.commands
    .run(cmd, { timeoutMs: AGENT_RUNTIME_TIMEOUT, envs })
    .then((result) => {
      if (result.exitCode !== 0) {
        console.log(
          `[Dispatcher] Agent exited with code ${result.exitCode}, terminating sandbox | run=${runId.slice(0, 8)}`
        );
        sandboxSessionManager.terminateSession(projectId);
      } else {
        console.log(
          `[Dispatcher] Agent completed successfully, keeping sandbox for reuse | run=${runId.slice(0, 8)}`
        );
      }
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Dispatcher] Agent process error: ${msg} | run=${runId.slice(0, 8)}`);
      sandboxSessionManager.terminateSession(projectId);
    });

  // 保存 sandboxId（用于停止功能）
  await prisma.projectRun.update({
    where: { id: runId },
    data: { sandboxId: sandbox.sandboxId },
  });

  console.log(
    `[Dispatcher] Dispatched run | run=${runId.slice(0, 8)} | project=${projectId.slice(0, 8)} | mode=${mode} | reused=${isReused}`
  );
}

/**
 * 从快照恢复执行（超时后用户点击"恢复"）
 */
export async function dispatchResumeRun(
  runId: string,
  projectId: string
): Promise<void> {
  const { sandbox } = await sandboxSessionManager.acquireForProject(projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  });

  if (!project) throw new Error(`Project ${projectId} not found`);

  const run = await prisma.projectRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Run ${runId} not found`);

  const cmd = [
    "node /agent-runtime/dist/main.js",
    `--runId=${runId}`,
    `--projectId=${projectId}`,
    `--mode=iterate`,
    `--resume=true`,
  ].join(" ");

  const envs: Record<string, string> = {
    USER_ID: project.userId,
    RUN_ID: runId,
    PROJECT_ID: projectId,
    USER_MESSAGE: run.prompt,
    REDIS_URL: process.env.REDIS_URL!,
    LLM_API_KEY: process.env.LLM_API_KEY!,
    LLM_BASE_URL: process.env.LLM_BASE_URL || "",
    LLM_MODEL: process.env.LLM_MODEL || "",
    API_BASE_URL: process.env.API_BASE_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET!,
    SANDBOX_ID: sandbox.sandboxId,
    AXIOM_TOKEN: process.env.AXIOM_TOKEN || "",
  };

  sandbox.commands
    .run(cmd, { timeoutMs: AGENT_RUNTIME_TIMEOUT, envs })
    .then((result) => {
      if (result.exitCode !== 0) {
        sandboxSessionManager.terminateSession(projectId);
      }
    })
    .catch(() => {
      sandboxSessionManager.terminateSession(projectId);
    });

  await prisma.projectRun.update({
    where: { id: runId },
    data: { sandboxId: sandbox.sandboxId, status: "running", pausedAt: null, pauseReason: null },
  });

  console.log(`[Dispatcher] Resumed run | run=${runId.slice(0, 8)} | project=${projectId.slice(0, 8)}`);
}
