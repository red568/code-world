/**
 * Internal API: 存储沙盒销毁前剩余的未压缩 messages
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    projectId: string;
    runId: string;
    messages: unknown[];
    startStep: number;
    endStep: number;
  };

  const { projectId, runId, messages, startStep, endStep } = body;

  if (!projectId || !runId || !messages) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const tokenCount = Math.ceil(JSON.stringify(messages).length / 4);

  await prisma.conversationHistory.create({
    data: {
      projectId,
      runId,
      messages: messages as any,
      startStep,
      endStep,
      tokenCount,
      isFinal: true,
    },
  });

  return NextResponse.json({ success: true });
}
