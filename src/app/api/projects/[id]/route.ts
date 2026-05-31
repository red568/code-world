/**
 * GET    /api/projects/:id — 获取项目详情
 * DELETE /api/projects/:id — 删除项目及所有关联资源
 */

import { prisma } from "@/lib/prisma";
import { Sandbox } from "@e2b/code-interpreter";
import { acquireProjectLock, releaseProjectLock, agentQueue } from "@/lib/queue";

const DEMO_USER_ID = "demo-user-001";

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

  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId: id,
      status: { in: ["queued", "running"] },
    },
    select: { id: true, status: true },
  });

  return Response.json({ project, activeRun });
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

  // 基于 active run 判断，而非 project.status
  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId: id,
      status: { in: ["queued", "running", "cancelling"] },
    },
  });

  if (activeRun) {
    return Response.json(
      { error: "项目有正在执行的任务，请先停止并等待完成" },
      { status: 409 }
    );
  }

  // 获取项目锁，防止与 Worker 竞态
  const { acquired, token } = await acquireProjectLock(id);
  if (!acquired) {
    return Response.json(
      { error: "项目正在处理中，请稍后再试" },
      { status: 409 }
    );
  }

  try {
    // 锁内 double-check：防止获取锁期间有新 run 创建
    const activeRunInLock = await prisma.projectRun.findFirst({
      where: {
        projectId: id,
        status: { in: ["queued", "running", "cancelling"] },
      },
    });

    if (activeRunInLock) {
      return Response.json(
        { error: "项目有正在执行的任务，请先停止并等待完成" },
        { status: 409 }
      );
    }

    // 移除队列中同 projectId 的待执行任务
    const waitingJobs = await agentQueue.getJobs(["waiting", "delayed"]);
    for (const job of waitingJobs) {
      if (job.data.projectId === id) {
        await job.remove();
      }
    }

    // best-effort 关闭沙箱
    if (project.sandboxSession?.sandboxId) {
      try {
        const sandbox = await Sandbox.connect(project.sandboxSession.sandboxId);
        await sandbox.kill();
      } catch { /* ignore */ }
    }

    // 级联删除项目及所有关联记录（包括 ProjectRun）
    await prisma.project.delete({ where: { id } });
  } finally {
    await releaseProjectLock(id, token);
  }

  return Response.json({ success: true });
}
