/**
 * POST /api/projects/:id/messages — 用户继续输入修改需求，触发迭代
 */

import { prisma } from "@/lib/prisma";
import { enqueueRun } from "@/lib/queue";

const DEMO_USER_ID = "demo-user-001";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { content } = body;

  if (!content || typeof content !== "string" || content.trim().length === 0) {
    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 400 | missing content`);
    return Response.json(
      { error: "content is required" },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 404`);
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // 检查是否存在 active run
  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId: id,
      status: { in: ["queued", "running", "cancelling"] },
    },
  });

  if (activeRun) {
    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 409 | active run exists`);
    return Response.json(
      { error: "项目有正在执行的任务，请等待完成或先停止" },
      { status: 409 }
    );
  }

  // 创建消息 + run（事务）
  const { message, run } = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        projectId: id,
        role: "user",
        content: content.trim(),
      },
    });

    const run = await tx.projectRun.create({
      data: {
        projectId: id,
        userId: DEMO_USER_ID,
        type: "iterate",
        status: "queued",
        prompt: content.trim(),
      },
    });

    return { message, run };
  });

  await enqueueRun(run.id, id, DEMO_USER_ID);

  console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 201 | runId=${run.id}`);
  return Response.json({ message, runId: run.id }, { status: 201 });
}
