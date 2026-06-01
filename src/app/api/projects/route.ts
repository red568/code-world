/**
 * POST /api/projects — 创建项目并入队生成任务
 * GET  /api/projects — 获取当前用户的项目列表
 *
 * 支持前置意图分析：首次创建项目时，模糊需求会返回 clarification_needed 事件。
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueRun } from "@/lib/queue";
import { publishEvent } from "@/lib/streaming";
import {
  shouldSkipIntentAnalysis,
  analyzeIntent,
} from "@/lib/agent/intent";

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

  // ─── 检查是否需要意图分析 ─────────────────────────────────────────────────
  const isFirstMessage = true; // 创建项目时总是首次消息

  if (shouldSkipIntentAnalysis(trimmedPrompt, isFirstMessage)) {
    // 跳过意图分析，直接创建项目并入队
    const { project, run } = await createProjectAndRun(trimmedPrompt, trimmedPrompt);
    await enqueueRun(run.id, project.id, DEMO_USER_ID);

    const duration = Date.now() - startTime;
    console.log(`[API] POST /api/projects | 201 | skipped analysis | projectId=${project.id} | runId=${run.id} | ${duration}ms`);

    return Response.json({ projectId: project.id, runId: run.id }, { status: 201 });
  }

  // ─── 执行意图分析 ─────────────────────────────────────────────────────────
  try {
    const analysis = await analyzeIntent(trimmedPrompt);

    if (analysis.clarity === "high") {
      // 需求清晰，直接创建项目并入队
      const { project, run } = await createProjectAndRun(trimmedPrompt, analysis.rewritten_query);
      await enqueueRun(run.id, project.id, DEMO_USER_ID);

      const duration = Date.now() - startTime;
      console.log(`[API] POST /api/projects | 201 | clarity=high | projectId=${project.id} | runId=${run.id} | ${duration}ms`);

      return Response.json({ projectId: project.id, runId: run.id }, { status: 201 });
    }

    // clarity: medium 或 low → 先创建项目（不创建 run），推送澄清选项
    const project = await prisma.project.create({
      data: {
        userId: DEMO_USER_ID,
        originalPrompt: trimmedPrompt,
        title: generateTitle(trimmedPrompt),
        status: "created",
      },
    });

    // 保存用户消息
    await prisma.message.create({
      data: {
        projectId: project.id,
        role: "user",
        content: trimmedPrompt,
      },
    });

    // 推送澄清事件
    await publishEvent(project.id, {
      type: "clarification_needed",
      data: {
        clarity: analysis.clarity,
        rewritten_query: analysis.rewritten_query,
        missing_info: analysis.missing_info,
      },
    });

    const duration = Date.now() - startTime;
    console.log(`[API] POST /api/projects | 202 | clarity=${analysis.clarity} | projectId=${project.id} | awaiting clarification | ${duration}ms`);

    return Response.json(
      {
        projectId: project.id,
        clarification: analysis,
        awaiting_clarification: true,
      },
      { status: 202 }
    );
  } catch (error) {
    // 意图分析失败时降级为直接执行
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API] POST /api/projects | intent analysis failed: ${msg}, falling back`);

    const { project, run } = await createProjectAndRun(trimmedPrompt, trimmedPrompt);
    await enqueueRun(run.id, project.id, DEMO_USER_ID);

    const duration = Date.now() - startTime;
    console.log(`[API] POST /api/projects | 201 | fallback | projectId=${project.id} | runId=${run.id} | ${duration}ms`);

    return Response.json({ projectId: project.id, runId: run.id }, { status: 201 });
  }
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────────

async function createProjectAndRun(originalPrompt: string, finalPrompt: string) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        userId: DEMO_USER_ID,
        originalPrompt,
        title: generateTitle(originalPrompt),
        status: "created",
      },
    });

    await tx.message.create({
      data: {
        projectId: project.id,
        role: "user",
        content: originalPrompt,
      },
    });

    const run = await tx.projectRun.create({
      data: {
        projectId: project.id,
        userId: DEMO_USER_ID,
        type: "generate",
        status: "queued",
        prompt: finalPrompt,
      },
    });

    return { project, run };
  });
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
