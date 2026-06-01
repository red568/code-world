/**
 * POST /api/projects/:id/stop — 立即停止
 *
 * 新架构 (v7)：直接 kill 沙盒，不等待优雅退出。
 * 旧架构 (v6)：保留 soft stop 兼容（cancelling 状态）。
 */

import { prisma } from "@/lib/prisma";
import { agentQueue } from "@/lib/queue";
import { publishStatusChange } from "@/lib/streaming";
import { Sandbox } from "@e2b/code-interpreter";
import { sandboxSessionManager } from "@/lib/sandbox-session";

const USE_SANDBOX_RUNTIME = process.env.USE_SANDBOX_RUNTIME === "true";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // 查找当前 active run
  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId,
      status: { in: ["queued", "running", "paused", "waiting_for_user"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!activeRun) {
    return Response.json({ success: true, message: "No active run to stop" });
  }

  // ─── queued: 直接取消 ──────────────────────────────────────────────────────
  if (activeRun.status === "queued") {
    await prisma.projectRun.update({
      where: { id: activeRun.id },
      data: { status: "cancelled", finishedAt: new Date() },
    });

    // 尝试移除队列中的 job
    try {
      const waitingJobs = await agentQueue.getJobs(["waiting", "delayed"]);
      for (const job of waitingJobs) {
        if (job.data.runId === activeRun.id) {
          await job.remove();
        }
      }
    } catch { /* ignore */ }

    await publishStatusChange(projectId, "stopped", "已停止");
    return Response.json({ success: true, message: "Cancelled queued run" });
  }

  // ─── running/paused: 根据架构选择停止方式 ──────────────────────────────────
  if (USE_SANDBOX_RUNTIME) {
    // 新架构：直接 kill 沙盒
    if (activeRun.sandboxId) {
      try {
        const sandbox = await Sandbox.connect(activeRun.sandboxId);
        await sandbox.kill();
        console.log(`[Stop] Killed sandbox ${activeRun.sandboxId.slice(0, 8)}`);
      } catch (error) {
        console.warn("[Stop] Failed to kill sandbox (may already be dead):", error);
      }
    }

    // 标记取消
    await prisma.projectRun.update({
      where: { id: activeRun.id },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        error: "User cancelled",
      },
    });

    // 立即清理沙盒会话
    await sandboxSessionManager.terminateSession(projectId);
  } else {
    // 旧架构：soft stop (cancelling)
    await prisma.projectRun.update({
      where: { id: activeRun.id },
      data: { status: "cancelling" },
    });
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { status: "stopped" },
  });

  await publishStatusChange(projectId, "stopped", "已停止");

  console.log(
    `[API] POST /stop | project=${projectId.slice(0, 8)} | run=${activeRun.id.slice(0, 8)} | mode=${USE_SANDBOX_RUNTIME ? "kill" : "soft"}`
  );

  return Response.json({ success: true }, { status: 202 });
}
