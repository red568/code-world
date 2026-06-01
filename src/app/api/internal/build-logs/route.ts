/**
 * Internal API: 创建构建日志
 *
 * agent-runtime 执行 shell 命令后调用。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, runId, command, stdout, stderr, exitCode } = (await request.json()) as {
    projectId: string;
    runId: string;
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };

  if (!projectId || !command) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const log = await prisma.buildLog.create({
    data: {
      projectId,
      runId,
      command,
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: exitCode ?? null,
    },
  });

  return NextResponse.json({ success: true, id: log.id });
}
