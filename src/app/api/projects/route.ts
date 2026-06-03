/**
 * POST /api/projects — 创建项目并入队生成任务
 * GET  /api/projects — 获取当前用户的项目列表
 *
 * 所有意图分析和用户追问由 sandbox 内的 agent-runtime 完成（通过 ask_user 工具），
 * API 层只负责创建项目和入队。
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueRun } from "@/lib/queue";

const DEMO_USER_ID = "demo-user-001";

function generateTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/^(请|帮我|帮忙|我想要?|我需要|给我|做一个|生成一个|创建一个|搭建一个|建一个|写一个|开发一个|设计一个)/g, "")
    .trim();
  const title = cleaned.slice(0, 20);
  return title || prompt.slice(0, 20);
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const body = await request.json();
  const { prompt } = body;

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    console.log(`[API] POST /api/projects | 400 | missing prompt`);
    return Response.json(
      { error: "prompt is required" },
      { status: 400 }
    );
  }

  const trimmedPrompt = prompt.trim();

  // 确保 demo 用户存在
  await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    create: { id: DEMO_USER_ID, email: "demo@example.com", name: "Demo User" },
    update: {},
  });

  // 直接创建项目和 run，意图分析由 sandbox 内 agent 完成
  const { project, run } = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        userId: DEMO_USER_ID,
        originalPrompt: trimmedPrompt,
        title: generateTitle(trimmedPrompt),
        status: "created",
      },
    });

    await tx.message.create({
      data: {
        projectId: project.id,
        role: "user",
        content: trimmedPrompt,
      },
    });

    const run = await tx.projectRun.create({
      data: {
        projectId: project.id,
        userId: DEMO_USER_ID,
        type: "generate",
        status: "queued",
        prompt: trimmedPrompt,
      },
    });

    return { project, run };
  });

  await enqueueRun(run.id, project.id, DEMO_USER_ID);

  const duration = Date.now() - startTime;
  console.log(`[API] POST /api/projects | 201 | projectId=${project.id} | runId=${run.id} | ${duration}ms`);

  return Response.json({ projectId: project.id, runId: run.id }, { status: 201 });
}

export async function GET() {
  const startTime = Date.now();

  const projects = await prisma.project.findMany({
    where: { userId: DEMO_USER_ID },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      previewUrl: true,
      originalPrompt: true,
      createdAt: true,
    },
  });

  const duration = Date.now() - startTime;
  console.log(`[API] GET /api/projects | 200 | count=${projects.length} | ${duration}ms`);

  return Response.json({ projects });
}
