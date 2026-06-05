/**
 * Internal API: 标记 Run 为 paused
 *
 * agent-runtime 触发 ask_user 时调用。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId, reason, askCount } = (await request.json()) as {
    runId: string;
    reason: string;
    askCount: number;
  };

  if (!runId || !reason) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  await prisma.projectRun.update({
    where: { id: runId },
    data: {
      status: "paused",
      pausedAt: new Date(),
      pauseReason: reason,
      currentAskCount: askCount,
    },
  });

  return NextResponse.json({ success: true });
}
