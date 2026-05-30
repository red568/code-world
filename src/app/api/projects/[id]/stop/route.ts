/**
 * POST /api/projects/:id/stop — Soft Stop：让当前 run 失去写权限
 *
 * 不强制中断 Worker/LLM/tool。Worker 在下一个 assertRunWritable 检查点感知并退出。
 */

import { prisma } from "@/lib/prisma";
import { agentQueue } from "@/lib/queue";
import { publishStatusChange } from "@/lib/streaming";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // 查找当前 active run
  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId: id,
      status: { in: ["queued", "running"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!activeRun) {
    // 没有活跃 run，直接返回成功（幂等）
    return Response.json({ success: true, message: "No active run to stop" });
  }

  // 事务内条件更新 run 状态
  await prisma.$transaction(async (tx) => {
    const run = await tx.projectRun.findFirst({
      where: {
        id: activeRun.id,
        projectId: id,
        status: { in: ["queued", "running"] },
      },
    });

    if (!run) return;

    if (run.status === "queued") {
      // queued run 直接取消，不需要等 Worker
      await tx.projectRun.update({
        where: { id: run.id },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      await tx.project.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: "stopped" as any },
      });
    } else {
      // running → cancelling，Worker 在检查点自行退出
      await tx.projectRun.update({
        where: { id: run.id },
        data: { status: "cancelling" },
      });
      await tx.project.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: "stopped" as any },
      });
    }
  });

  // 尝试移除 queued job（best-effort）
  if (activeRun.status === "queued") {
    try {
      const waitingJobs = await agentQueue.getJobs(["waiting", "delayed"]);
      for (const job of waitingJobs) {
        if (job.data.runId === activeRun.id) {
          await job.remove();
        }
      }
    } catch { /* ignore */ }
  }

  await publishStatusChange(id, "stopped", "已停止");

  console.log(`[API] POST /api/projects/${id.slice(0, 8)}/stop | run=${activeRun.id.slice(0, 8)} | ${activeRun.status} → stop`);
  return Response.json({ success: true }, { status: 202 });
}
