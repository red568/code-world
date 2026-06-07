/**
 * Internal API: 沙盒销毁前全量文件同步
 *
 * 强制全量同步所有项目文件，标记 syncSource 为 "final"。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, files, isFinal } = (await request.json()) as {
    projectId: string;
    files: { path: string; content: string }[];
    isFinal?: boolean;
  };

  if (!projectId || !files || !Array.isArray(files)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const syncSource = isFinal ? "final" : "periodic";

  // 批量 upsert
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
          syncSource,
        },
        update: {
          content: file.content,
          size: Buffer.byteLength(file.content, "utf-8"),
          syncSource,
          version: { increment: 1 },
        },
      })
    )
  );

  return NextResponse.json({ success: true, synced: files.length });
}
