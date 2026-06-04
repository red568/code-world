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

  // 二次校验：如果在 Worker 消费到 dispatch 之间 run 已被取消，直接返回
  if (run.status !== "running") {
    console.log(`[Dispatcher] Run ${runId.slice(0, 8)} status=${run.status}, skip dispatch`);
    return;
  }

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
    USER_MESSAGE: run.prompt || "",
    SANDBOX_ID: sandbox.sandboxId,
  };

  // 捕获当前 sandboxId，用于退出回调的安全检查
  const currentSandboxId = sandbox.sandboxId;

  // 异步执行（不 await），Worker 不阻塞等待完成
  console.log(`[Dispatcher] Launching agent | run=${runId.slice(0, 8)} | sandbox=${sandbox.sandboxId} | mode=${mode} | reused=${isReused}`);
  console.log(`[Dispatcher] CMD: ${cmd}`);
  console.log(`[Dispatcher] Envs: ${Object.entries(envs).map(([k, v]) => `${k}=${k === "USER_MESSAGE" ? v.slice(0, 50) : v.slice(0, 20)}`).join(" | ")}`);

  const launchTime = Date.now();

  sandbox.commands
    .run(cmd, { timeoutMs: AGENT_RUNTIME_TIMEOUT, envs })
    .then((result) => {
      const elapsed = Math.round((Date.now() - launchTime) / 1000);
      if (result.exitCode !== 0) {
        console.error(
          `[Dispatcher] ✗ Agent FAILED | exitCode=${result.exitCode} | elapsed=${elapsed}s | run=${runId.slice(0, 8)}`
        );
        if (result.stdout) {
          console.log(`[Dispatcher] stdout (last 2000 chars):\n${result.stdout.slice(-2000)}`);
        }
        if (result.stderr) {
          console.error(`[Dispatcher] stderr (last 2000 chars):\n${result.stderr.slice(-2000)}`);
        }
        sandboxSessionManager.terminateSession(projectId, currentSandboxId);
      } else {
        console.log(
          `[Dispatcher] ✓ Agent completed | elapsed=${elapsed}s | run=${runId.slice(0, 8)}`
        );
        if (result.stdout) {
          console.log(`[Dispatcher] stdout (last 500 chars): ${result.stdout.slice(-500)}`);
        }
      }
    })
    .catch((error: unknown) => {
      const elapsed = Math.round((Date.now() - launchTime) / 1000);
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : "";
      console.error(`[Dispatcher] ✗ Agent process EXCEPTION | elapsed=${elapsed}s | run=${runId.slice(0, 8)}`);
      console.error(`[Dispatcher] Error: ${msg}`);
      if (stack) console.error(`[Dispatcher] Stack: ${stack}`);
      sandboxSessionManager.terminateSession(projectId, currentSandboxId);
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
  // 校验 run 仍然有效
  const runCheck = await prisma.projectRun.findUnique({ where: { id: runId } });
  if (!runCheck || runCheck.status === "cancelled") {
    console.log(`[Dispatcher] Resume skipped: run ${runId.slice(0, 8)} status=${runCheck?.status}`);
    return;
  }

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
    USER_MESSAGE: run.prompt || "",
    SANDBOX_ID: sandbox.sandboxId,
  };

  const currentSandboxId = sandbox.sandboxId;

  console.log(`[Dispatcher] Resuming agent | run=${runId.slice(0, 8)} | sandbox=${sandbox.sandboxId} | cmd=${cmd}`);

  const resumeLaunchTime = Date.now();

  sandbox.commands
    .run(cmd, { timeoutMs: AGENT_RUNTIME_TIMEOUT, envs })
    .then((result) => {
      const elapsed = Math.round((Date.now() - resumeLaunchTime) / 1000);
      if (result.exitCode !== 0) {
        console.error(`[Dispatcher] ✗ Resumed agent FAILED | exitCode=${result.exitCode} | elapsed=${elapsed}s | run=${runId.slice(0, 8)}`);
        if (result.stdout) {
          console.log(`[Dispatcher] Resume stdout (last 2000 chars):\n${result.stdout.slice(-2000)}`);
        }
        if (result.stderr) {
          console.error(`[Dispatcher] Resume stderr (last 2000 chars):\n${result.stderr.slice(-2000)}`);
        }
        sandboxSessionManager.terminateSession(projectId, currentSandboxId);
      } else {
        console.log(`[Dispatcher] ✓ Resumed agent completed | elapsed=${elapsed}s | run=${runId.slice(0, 8)}`);
      }
    })
    .catch((error: unknown) => {
      const elapsed = Math.round((Date.now() - resumeLaunchTime) / 1000);
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : "";
      console.error(`[Dispatcher] ✗ Resumed agent EXCEPTION | elapsed=${elapsed}s | run=${runId.slice(0, 8)}`);
      console.error(`[Dispatcher] Error: ${msg}`);
      if (stack) console.error(`[Dispatcher] Stack: ${stack}`);
      sandboxSessionManager.terminateSession(projectId, currentSandboxId);
    });

  await prisma.projectRun.update({
    where: { id: runId },
    data: { sandboxId: sandbox.sandboxId, status: "running", pausedAt: null, pauseReason: null },
  });

  console.log(`[Dispatcher] Resumed run | run=${runId.slice(0, 8)} | project=${projectId.slice(0, 8)}`);
}
