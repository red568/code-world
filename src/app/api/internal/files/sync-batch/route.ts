/**
 * Internal API: 批量增量同步代码文件
 *
 * 沙盒周期性调用（每 10 步或每 5 分钟），仅同步 dirty files。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
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

  // 批量 upsert（事务）
  await prisma.$transaction(
    files.map((file) =>
      prisma.projectFile.upsert({
        where: {
          projectId_path: { projectId, path: file.path },
        },
        create: {
          projectId,
          path: file.path,
          content: file.content,
          size: Buffer.byteLength(file.content, "utf-8"),
          syncSource: "periodic",
        },
        update: {
          content: file.content,
          size: Buffer.byteLength(file.content, "utf-8"),
          syncSource: "periodic",
          version: { increment: 1 },
        },
      })
    )
  );
  synced = files.length;

  return NextResponse.json({ success: true, synced });
}
