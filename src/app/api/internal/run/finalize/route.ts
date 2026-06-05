/**
 * Internal API: 标记 Run 完成/失败
 *
 * agent-runtime 退出前调用，设置最终状态。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId, projectId, status, error, summary, previewUrl } = (await request.json()) as {
    runId: string;
    projectId: string;
    status: "succeeded" | "failed" | "paused";
    error?: string;
    summary?: string;
    previewUrl?: string;
  };

  if (!runId || !status) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  await prisma.projectRun.update({
    where: { id: runId },
    data: {
      status,
      error: error || null,
      finishedAt: status !== "paused" ? new Date() : undefined,
      previewUrl: previewUrl || undefined,
    },
  });

  // 如果成功，更新项目 previewUrl
  if (status === "succeeded" && previewUrl) {
    await prisma.project.update({
      where: { id: projectId },
      data: { previewUrl, status: "running" },
    });
  }

  return NextResponse.json({ success: true });
}
