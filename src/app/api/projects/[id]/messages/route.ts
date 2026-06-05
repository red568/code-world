/**
 * POST /api/projects/:id/messages — 用户发送后续消息，触发迭代
 *
 * 所有意图分析和追问由 sandbox 内 agent-runtime 自主完成。
 * API 层只负责保存消息、创建 run 和入队。
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
      status: { in: ["queued", "running", "cancelling", "waiting_for_user"] },
    },
  });

  if (activeRun) {
    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 409 | active run exists`);
    return Response.json(
      { error: "项目有正在执行的任务，请等待完成或先停止" },
      { status: 409 }
    );
  }

  const trimmedContent = content.trim();

  const { message, run } = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        projectId: id,
        role: "user",
        content: trimmedContent,
      },
    });

    const run = await tx.projectRun.create({
      data: {
        projectId: id,
        userId: DEMO_USER_ID,
        type: "iterate",
        status: "queued",
        prompt: trimmedContent,
      },
    });

    return { message, run };
  });

  await enqueueRun(run.id, id, DEMO_USER_ID);

  console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 201 | runId=${run.id}`);
  return Response.json({ message, runId: run.id }, { status: 201 });
}
