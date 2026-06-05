/**
 * GET /api/projects/states — 返回用户所有项目的当前状态
 *
 * 用于 SSE 连接建立后的初始化，前端拿到所有项目状态后
 * 再通过 user-level SSE 接收增量更新。
 */

import { prisma } from "@/lib/prisma";

const DEMO_USER_ID = "demo-user-001";

export async function GET() {
  const userId = DEMO_USER_ID;

  const projects = await prisma.project.findMany({
    where: { userId },
    select: {
      id: true,
      title: true,
      status: true,
      previewUrl: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  // 查找每个项目的活跃 run（如果有）
  const projectIds = projects.map((p) => p.id);
  const activeRuns = await prisma.projectRun.findMany({
    where: {
      projectId: { in: projectIds },
      status: { in: ["queued", "running", "paused", "waiting_for_user"] },
    },
    select: {
      id: true,
      projectId: true,
      status: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // 每个项目只取最新的活跃 run
  const activeRunByProject = new Map<string, (typeof activeRuns)[0]>();
  for (const run of activeRuns) {
    if (!activeRunByProject.has(run.projectId)) {
      activeRunByProject.set(run.projectId, run);
    }
  }

  const states = projects.map((project) => {
    const activeRun = activeRunByProject.get(project.id);
    return {
      projectId: project.id,
      title: project.title,
      status: project.status,
      previewUrl: project.previewUrl,
      updatedAt: project.updatedAt,
      activeRun: activeRun
        ? {
            runId: activeRun.id,
            status: activeRun.status,
          }
        : null,
    };
  });

  return Response.json({ states });
}
