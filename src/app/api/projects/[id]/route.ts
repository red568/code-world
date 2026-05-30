/**
 * GET    /api/projects/:id — 获取项目详情
 * DELETE /api/projects/:id — 删除项目及所有关联资源
 */

import { prisma } from "@/lib/prisma";
import { Sandbox } from "@e2b/code-interpreter";
import { acquireProjectLock, releaseProjectLock, agentQueue, clearCancelled } from "@/lib/queue";

const DEMO_USER_ID = "demo-user-001";

const ACTIVE_STATUSES = [
  "spec_generating",
  "code_generating",
  "reviewing",
  "building",
  "fixing",
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      sandboxSession: true,
    },
  });

  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  return Response.json({ project });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id, userId: DEMO_USER_ID },
    include: { sandboxSession: true },
  });

  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  if (ACTIVE_STATUSES.includes(project.status)) {
    return Response.json(
      { error: "项目正在运行中，请先停止项目" },
      { status: 409 }
    );
  }

  // 尝试获取项目锁，防止与 Worker 竞态
  const { acquired, token } = await acquireProjectLock(id);
  if (!acquired) {
    return Response.json(
      { error: "项目正在处理中，请稍后再试" },
      { status: 409 }
    );
  }

  try {
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

    // 级联删除项目及所有关联记录
    await prisma.project.delete({ where: { id } });

    // 清理 cancel flag
    await clearCancelled(id);
  } finally {
    await releaseProjectLock(id, token);
  }

  return Response.json({ success: true });
}
