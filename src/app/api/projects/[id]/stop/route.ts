/**
 * POST /api/projects/:id/stop — 停止项目（取消 Agent + 关闭 sandbox）
 */

import { prisma } from "@/lib/prisma";
import { Sandbox } from "@e2b/code-interpreter";
import { setCancelled } from "@/lib/queue/cancel";
import { agentQueue } from "@/lib/queue";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: { sandboxSession: true },
  });

  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // 设置取消信号，agent loop 会在下一个检查点退出
  await setCancelled(id);

  // 移除队列中同 projectId 的待执行任务
  const waitingJobs = await agentQueue.getJobs(["waiting", "delayed"]);
  for (const job of waitingJobs) {
    if (job.data.projectId === id) {
      await job.remove();
    }
  }

  // 关闭沙箱
  if (project.sandboxSession?.sandboxId) {
    try {
      const sandbox = await Sandbox.connect(project.sandboxSession.sandboxId);
      await sandbox.kill();
    } catch {
      // 沙箱可能已过期或已停止
    }
  }

  // 更新沙箱会话状态
  if (project.sandboxSession) {
    await prisma.sandboxSession.update({
      where: { projectId: id },
      data: { status: "stopped", stoppedAt: new Date() },
    });
  }

  await prisma.project.update({
    where: { id },
    data: { status: "stopped" },
  });

  return Response.json({ success: true });
}
