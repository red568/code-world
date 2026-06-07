/**
 * Internal API: 获取最新压缩摘要
 *
 * 新 run 启动时调用，获取该项目最近的 compression summary。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

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

  const latest = await prisma.compressionSummary.findFirst({
    where: { projectId },
    orderBy: { version: "desc" },
  });

  if (!latest) {
    return NextResponse.json({ summary: null });
  }

  return NextResponse.json({
    summary: latest.summary,
    summaryTokens: latest.summaryTokens,
    coversStepStart: latest.coversStepStart,
    coversStepEnd: latest.coversStepEnd,
    version: latest.version,
    runId: latest.runId,
  });
}
