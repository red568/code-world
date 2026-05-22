/**
 * GET /api/projects/:id/files — 获取项目当前文件树和内容
 */

import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const files = await prisma.projectFile.findMany({
    where: { projectId: id },
    orderBy: { path: "asc" },
    select: {
      path: true,
      content: true,
      version: true,
      updatedAt: true,
    },
  });

  return Response.json({ files });
}
