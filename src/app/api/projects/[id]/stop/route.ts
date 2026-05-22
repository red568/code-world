/**
 * POST /api/projects/:id/stop — 停止 E2B sandbox
 */

import { prisma } from "@/lib/prisma";
import { Sandbox } from "@e2b/code-interpreter";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await prisma.sandboxSession.findUnique({
    where: { projectId: id },
  });

  if (!session) {
    return Response.json({ error: "No active sandbox" }, { status: 404 });
  }

  try {
    const sandbox = await Sandbox.connect(session.sandboxId);
    await sandbox.kill();
  } catch {
    // sandbox 可能已经过期或被停止
  }

  await prisma.sandboxSession.update({
    where: { projectId: id },
    data: { status: "stopped", stoppedAt: new Date() },
  });

  await prisma.project.update({
    where: { id },
    data: { status: "stopped" },
  });

  return Response.json({ success: true });
}
