/**
 * POST /api/projects/:id/messages — 用户继续输入修改需求，触发迭代
 *
 * 支持前置意图分析：模糊需求会返回 clarification_needed 事件让用户选择。
 */

import { prisma } from "@/lib/prisma";
import { enqueueRun } from "@/lib/queue";
import { publishEvent } from "@/lib/streaming";
import {
  shouldSkipIntentAnalysis,
  analyzeIntent,
  buildEnhancedPrompt,
} from "@/lib/agent/intent";

const DEMO_USER_ID = "demo-user-001";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { content, clarification_response } = body;

  if (!content || typeof content !== "string" || content.trim().length === 0) {
    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 400 | missing content`);
    return Response.json(
      { error: "content is required" },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) {
    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 404`);
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  // 检查是否存在 active run（包括 waiting_for_user）
  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId: id,
      status: { in: ["queued", "running", "cancelling", "waiting_for_user"] },
    },
  });

  if (activeRun) {
    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 409 | active run exists`);
    return Response.json(
      { error: "项目有正在执行的任务，请等待完成或先停止" },
      { status: 409 }
    );
  }

  const trimmedContent = content.trim();

  // ─── 分支 1：用户回答了 clarification 选项 ─────────────────────────────────
  if (clarification_response) {
    const { selections, skip, rewritten_query } = clarification_response as {
      selections?: Record<string, string>;
      skip?: boolean;
      rewritten_query?: string;
    };

    let finalPrompt: string;
    if (skip) {
      finalPrompt = trimmedContent;
    } else if (selections && rewritten_query) {
      finalPrompt = buildEnhancedPrompt(trimmedContent, rewritten_query, selections);
    } else {
      finalPrompt = trimmedContent;
    }

    const { message, run } = await createMessageAndRun(id, trimmedContent, finalPrompt);
    await enqueueRun(run.id, id, DEMO_USER_ID);

    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 201 | clarification resolved | runId=${run.id}`);
    return Response.json({ message, runId: run.id }, { status: 201 });
  }

  // ─── 分支 2：检查是否需要意图分析 ─────────────────────────────────────────

  const messageCount = await prisma.message.count({ where: { projectId: id } });
  const isFirstMessage = messageCount === 0;

  if (shouldSkipIntentAnalysis(trimmedContent, isFirstMessage)) {
    const { message, run } = await createMessageAndRun(id, trimmedContent, trimmedContent);
    await enqueueRun(run.id, id, DEMO_USER_ID);

    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 201 | skipped analysis | runId=${run.id}`);
    return Response.json({ message, runId: run.id }, { status: 201 });
  }

  // ─── 分支 3：执行意图分析 ─────────────────────────────────────────────────

  try {
    const analysis = await analyzeIntent(trimmedContent);

    if (analysis.clarity === "high") {
      const { message, run } = await createMessageAndRun(id, trimmedContent, analysis.rewritten_query);
      await enqueueRun(run.id, id, DEMO_USER_ID);

      console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 201 | clarity=high | runId=${run.id}`);
      return Response.json({ message, runId: run.id }, { status: 201 });
    }

    // clarity: medium 或 low → 推送选项让用户选择
    // 不在此处保存 message，等用户确认后由 branch 1 的 createMessageAndRun 统一保存
    // 避免重复写入

    await publishEvent(id, {
      type: "clarification_needed",
      data: {
        clarity: analysis.clarity,
        rewritten_query: analysis.rewritten_query,
        missing_info: analysis.missing_info,
      },
    });

    console.log(`[API] POST /api/projects/${id.slice(0, 8)}/messages | 202 | clarity=${analysis.clarity} | awaiting clarification`);
    return Response.json(
      { clarification: analysis, awaiting_clarification: true },
      { status: 202 }
    );
  } catch (error) {
    // 意图分析失败时降级为直接执行
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[API] POST /api/projects/${id.slice(0, 8)}/messages | intent analysis failed: ${msg}, falling back`);

    const { message, run } = await createMessageAndRun(id, trimmedContent, trimmedContent);
    await enqueueRun(run.id, id, DEMO_USER_ID);

    return Response.json({ message, runId: run.id }, { status: 201 });
  }
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────────

async function createMessageAndRun(
  projectId: string,
  userContent: string,
  prompt: string
) {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        projectId,
        role: "user",
        content: userContent,
      },
    });

    const run = await tx.projectRun.create({
      data: {
        projectId,
        userId: DEMO_USER_ID,
        type: "iterate",
        status: "queued",
        prompt,
      },
    });

    return { message, run };
  });
}
