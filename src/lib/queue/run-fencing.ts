/**
 * Run 写权限 fencing 工具
 *
 * 核心机制：所有项目级写入必须通过 run.status 校验。
 * Stop 只改 run.status，Worker 在检查点和写入时自动感知。
 */

import { prisma } from "@/lib/prisma";

// ─── 错误类型 ────────────────────────────────────────────────────────────────────

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export class RunNotWritableError extends NonRetryableError {
  constructor(runId: string) {
    super(`Run ${runId.slice(0, 8)} is not writable (status != running)`);
    this.name = "RunNotWritableError";
  }
}

export class RunCancelledError extends NonRetryableError {
  constructor(runId: string) {
    super(`Run ${runId.slice(0, 8)} has been cancelled`);
    this.name = "RunCancelledError";
  }
}

export class ProjectDeletedError extends NonRetryableError {
  constructor(projectId: string) {
    super(`Project ${projectId.slice(0, 8)} has been deleted`);
    this.name = "ProjectDeletedError";
  }
}

// ─── Run 终态到 Project.status 映射 ──────────────────────────────────────────────

export const RUN_TO_PROJECT_STATUS: Record<string, string> = {
  succeeded: "running",
  cancelled: "stopped",
  failed: "failed",
};

// ─── assertRunWritable（检查点校验，省 token） ────────────────────────────────────

const heartbeatCounters = new Map<string, number>();
const HEARTBEAT_INTERVAL = 5;

export async function assertRunWritable(runId: string): Promise<void> {
  const run = await prisma.projectRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (!run || run.status !== "running") {
    heartbeatCounters.delete(runId);
    throw new RunNotWritableError(runId);
  }

  const count = (heartbeatCounters.get(runId) ?? 0) + 1;
  heartbeatCounters.set(runId, count);
  if (count % HEARTBEAT_INTERVAL === 0) {
    await prisma.projectRun.updateMany({
      where: { id: runId, status: "running" },
      data: { heartbeatAt: new Date() },
    });
  }
}

// ─── finalizeRun（条件更新，防止覆盖 Stop） ──────────────────────────────────────

export async function finalizeRun(
  runId: string,
  projectId: string,
  result: "succeeded" | "failed",
  error?: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.projectRun.updateMany({
      where: { id: runId, status: "running" },
      data: {
        status: result,
        error,
        finishedAt: new Date(),
      },
    });

    if (updated.count === 1) {
      await tx.project.update({
        where: { id: projectId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: RUN_TO_PROJECT_STATUS[result] as any },
      });
      return;
    }

    // count=0: Stop 或 Reaper 已经改过了
    const run = await tx.projectRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });

    if (run?.status === "cancelling") {
      await tx.projectRun.updateMany({
        where: { id: runId, status: "cancelling" },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      await tx.project.update({
        where: { id: projectId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: "stopped" as any },
      });
    }
  });
}

// ─── resetHeartbeatCounter（每次新 run 开始时重置） ───────────────────────────────

export function resetHeartbeatCounter(runId: string): void {
  heartbeatCounters.delete(runId);
}
