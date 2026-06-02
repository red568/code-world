/**
 * POST /api/projects/:id/stop — 立即停止运行中的 Agent
 *
 * 队列中 (queued): 直接取消
 * 运行中 (running/paused): sandbox.kill() 立即终止
 */

import { prisma } from "@/lib/prisma";
import { agentQueue } from "@/lib/queue";
import { publishStatusChange } from "@/lib/streaming";
import { Sandbox } from "@e2b/code-interpreter";
import { sandboxSessionManager } from "@/lib/sandbox-session";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId,
      status: { in: ["queued", "running", "paused"] },
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

  // ─── running/paused: kill 沙盒 ────────────────────────────────────────────
  if (activeRun.sandboxId) {
    try {
      const sandbox = await Sandbox.connect(activeRun.sandboxId);
      await sandbox.kill();
      console.log(`[Stop] Killed sandbox ${activeRun.sandboxId.slice(0, 8)}`);
    } catch (error) {
      console.warn("[Stop] Failed to kill sandbox (may already be dead):", error);
    }
  }

  await prisma.projectRun.update({
    where: { id: activeRun.id },
    data: {
      status: "cancelled",
      finishedAt: new Date(),
      error: "User cancelled",
    },
  });

  await sandboxSessionManager.terminateSession(projectId);

  await prisma.project.update({
    where: { id: projectId },
    data: { status: "stopped" },
  });

  await publishStatusChange(projectId, "stopped", "已停止");

  console.log(
    `[API] POST /stop | project=${projectId.slice(0, 8)} | run=${activeRun.id.slice(0, 8)}`
  );

  return Response.json({ success: true }, { status: 202 });
}
