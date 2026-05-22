/**
 * GET /api/projects/:id/logs — 获取构建日志
 */

import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const logs = await prisma.buildLog.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "asc" },
    select: {
      command: true,
      stdout: true,
      stderr: true,
      exitCode: true,
      diagnosis: true,
      attempt: true,
      createdAt: true,
    },
  });

  return Response.json({ logs });
}
