/**
 * POST /api/projects — 创建项目并入队生成任务
 * GET  /api/projects — 获取当前用户的项目列表
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueGenerate } from "@/lib/queue";

// 第一版暂用固定用户 ID，后续接入认证
const DEMO_USER_ID = "demo-user-001";

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

  // 确保 demo 用户存在
  await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    create: { id: DEMO_USER_ID, email: "demo@example.com", name: "Demo User" },
    update: {},
  });

  // 创建项目
  const project = await prisma.project.create({
    data: {
      userId: DEMO_USER_ID,
      originalPrompt: prompt.trim(),
      status: "created",
    },
  });

  // 保存用户消息
  await prisma.message.create({
    data: {
      projectId: project.id,
      role: "user",
      content: prompt.trim(),
    },
  });

  // 入队生成任务
  await enqueueGenerate(project.id, prompt.trim());

  const duration = Date.now() - startTime;
  console.log(`[API] POST /api/projects | 201 | projectId=${project.id} | prompt="${prompt.trim().slice(0, 40)}" | ${duration}ms`);

  return Response.json({ projectId: project.id }, { status: 201 });
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
