/**
 * POST /api/projects/:id/answer — 用户回答 ask_user 问题
 *
 * 新架构 (v7)：Redis LPUSH 直接推送答案到沙盒内 agent-runtime 的 BRPOP。
 * 旧架构 (v6)：LoopState + 重新入队方式。
 */

import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { agentQueue } from "@/lib/queue";

const USE_SANDBOX_RUNTIME = process.env.USE_SANDBOX_RUNTIME === "true";
const DEMO_USER_ID = "demo-user-001";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const body = await request.json();
  const { runId, answer, isOther, skipAndContinue, askCount, answerToken } = body;

  if (!runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }

  // 构造用户回答内容
  let answerContent: string;
  if (skipAndContinue) {
    answerContent = "用户选择跳过，请自行选择最合理方案继续执行。";
  } else if (isOther && answer) {
    answerContent = `用户选择了 [其他]，补充说明：${String(answer).slice(0, 200)}`;
  } else if (answer) {
    answerContent = `用户选择了：${answer}`;
  } else {
    answerContent = "用户选择跳过，请自行选择最合理方案继续执行。";
  }

  if (USE_SANDBOX_RUNTIME) {
    return handleSandboxAnswer(projectId, runId, askCount, answerContent);
  } else {
    return handleLegacyAnswer(projectId, runId, answerToken, answerContent);
  }
}

// ─── 新架构：Redis LPUSH ──────────────────────────────────────────────────────

async function handleSandboxAnswer(
  projectId: string,
  runId: string,
  askCount: number | undefined,
  answerContent: string
) {
  if (askCount == null) {
    return Response.json({ error: "askCount is required" }, { status: 400 });
  }

  // 验证 run 状态
  const run = await prisma.projectRun.findFirst({
    where: { id: runId, projectId, status: "paused" },
  });

  if (!run) {
    return Response.json(
      { error: "Run not found or not paused" },
      { status: 409 }
    );
  }

  // 验证 askCount 匹配
  if (run.currentAskCount !== askCount) {
    return Response.json(
      { error: "askCount mismatch, question may have expired" },
      { status: 409 }
    );
  }

  // 原子防双击：SET NX
  const dedupeKey = `answer:dedup:${runId}:${askCount}`;
  const claimed = await redis.set(dedupeKey, "1", "EX", 300, "NX");
  if (!claimed) {
    return Response.json(
      { error: "Answer already submitted" },
      { status: 409 }
    );
  }

  // 推送答案到 agent-runtime 的 BRPOP 队列
  const answerKey = `loop:${runId}:answer:${askCount}`;
  await redis.lpush(answerKey, answerContent);

  console.log(
    `[API] POST /answer | project=${projectId.slice(0, 8)} | run=${runId.slice(0, 8)} | askCount=${askCount}`
  );

  return Response.json({ ok: true, runId });
}

// ─── 旧架构：LoopState + 重新入队 ────────────────────────────────────────────

async function handleLegacyAnswer(
  projectId: string,
  runId: string,
  answerToken: string | undefined,
  answerContent: string
) {
  if (!answerToken) {
    return Response.json(
      { error: "answerToken is required" },
      { status: 400 }
    );
  }

  const claimed = await prisma.projectRun.updateMany({
    where: { id: runId, projectId, status: "waiting_for_user" },
    data: { status: "queued" },
  });
  if (claimed.count === 0) {
    return Response.json(
      { error: "Run not found or not waiting for user input" },
      { status: 409 }
    );
  }

  const loopState = await prisma.loopState.findUnique({ where: { runId } });
  if (!loopState || loopState.answerToken !== answerToken) {
    await prisma.projectRun.update({
      where: { id: runId },
      data: { status: "waiting_for_user" },
    });
    return Response.json(
      { error: "Invalid or expired answerToken" },
      { status: 409 }
    );
  }

  const state = loopState.state as Record<string, unknown>;
  await prisma.loopState.update({
    where: { runId },
    data: {
      state: {
        ...state,
        userAnswer: answerContent,
        resumeReady: true,
      },
    },
  });

  await agentQueue.add("agent-run", {
    runId,
    projectId,
    userId: DEMO_USER_ID,
  }, {
    jobId: answerToken,
    attempts: 3,
    backoff: { type: "fixed", delay: 5000 },
  });

  console.log(
    `[API] POST /answer (legacy) | project=${projectId.slice(0, 8)} | run=${runId.slice(0, 8)}`
  );

  return Response.json({ ok: true, runId });
}
