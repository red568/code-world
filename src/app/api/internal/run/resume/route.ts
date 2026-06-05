/**
 * Internal API: 恢复 Run 为 running
 *
 * 用户回答后，agent-runtime 恢复执行时调用。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = (await request.json()) as { runId: string };

  if (!runId) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  await prisma.projectRun.update({
    where: { id: runId },
    data: {
      status: "running",
      pausedAt: null,
      pauseReason: null,
    },
  });

  return NextResponse.json({ success: true });
}
