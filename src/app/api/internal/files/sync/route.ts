/**
 * Internal API: 批量同步项目文件
 *
 * POST: agent-runtime 任务完成后调用，批量 upsert 所有项目文件。
 * GET:  新 run 启动时调用，获取项目所有文件用于恢复沙盒文件系统。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  // 鉴权
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, files } = (await request.json()) as {
    projectId: string;
    files: { path: string; content: string }[];
  };

  if (!projectId || !files || !Array.isArray(files)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  let synced = 0;

  for (const file of files) {
    await prisma.projectFile.upsert({
      where: {
        projectId_path: { projectId, path: file.path },
      },
      create: {
        projectId,
        path: file.path,
        content: file.content,
      },
      update: {
        content: file.content,
        version: { increment: 1 },
      },
    });
    synced++;
  }

  return NextResponse.json({ success: true, synced });
}

export async function GET(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) {
    return NextResponse.json({ error: "Missing projectId" }, { status: 400 });
  }

  const projectFiles = await prisma.projectFile.findMany({
    where: { projectId },
    select: { path: true, content: true },
  });

  return NextResponse.json({ files: projectFiles });
}
