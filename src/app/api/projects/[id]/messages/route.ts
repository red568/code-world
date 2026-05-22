/**
 * POST /api/projects/:id/messages — 用户继续输入修改需求，触发迭代
 */

import { prisma } from "@/lib/prisma";
import { enqueueIterate } from "@/lib/queue";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { content } = body;

  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return Response.json(
      { error: "content is required" },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // 保存用户消息
  const message = await prisma.message.create({
    data: {
      projectId: id,
      role: "user",
      content: content.trim(),
    },
  });

  // 入队迭代任务
  await enqueueIterate(id, content.trim());

  return Response.json({ message }, { status: 201 });
}
