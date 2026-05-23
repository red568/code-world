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

  console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 201 | content="${content.trim().slice(0, 40)}"`);
  return Response.json({ message }, { status: 201 });
}
