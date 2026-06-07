/**
 * Internal API: 获取未被压缩的剩余 messages
 *
 * 新 run 恢复时，获取上次压缩之后的对话历史。
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
  const afterStep = parseInt(searchParams.get("afterStep") || "0", 10);

  if (!projectId) {
    return NextResponse.json({ error: "Missing projectId" }, { status: 400 });
  }

  // 查找 isFinal=true 或 startStep > afterStep 的记录
  const remaining = await prisma.conversationHistory.findFirst({
    where: {
      projectId,
      startStep: { gt: afterStep },
    },
    orderBy: { startStep: "desc" },
  });

  if (!remaining) {
    return NextResponse.json({ messages: [] });
  }

  return NextResponse.json({
    messages: remaining.messages,
    startStep: remaining.startStep,
    endStep: remaining.endStep,
  });
}
