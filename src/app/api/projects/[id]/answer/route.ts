/**
 * POST /api/projects/:id/answer — 用户回答 ask_user 问题，恢复 Agent Loop
 */

import { prisma } from "@/lib/prisma";
import { agentQueue } from "@/lib/queue";

const DEMO_USER_ID = "demo-user-001";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { runId, answerToken, answer, isOther, skipAndContinue } = body;

  if (!runId || !answerToken) {
    return Response.json(
      { error: "runId and answerToken are required" },
      { status: 400 }
    );
  }

  // 原子 claim：检查 + 翻转状态合为一条 SQL，防止双击/重试导致双重执行
  // 设为 queued 而非 running，让 worker 走正常的 queued→running 路径
  const claimed = await prisma.projectRun.updateMany({
    where: { id: runId, projectId: id, status: "waiting_for_user" },
    data: { status: "queued" },
  });
  if (claimed.count === 0) {
    return Response.json(
      { error: "Run not found or not waiting for user input" },
      { status: 409 }
    );
  }

  // 幂等检查：确认 answerToken 匹配
  const loopState = await prisma.loopState.findUnique({ where: { runId } });
  if (!loopState || loopState.answerToken !== answerToken) {
    // answerToken 不匹配，回滚 run 状态
    await prisma.projectRun.update({
      where: { id: runId },
      data: { status: "waiting_for_user" },
    });
    return Response.json(
      { error: "Invalid or expired answerToken" },
      { status: 409 }
    );
  }

  // 构造用户回答的 tool result 内容
  let toolResultContent: string;
  if (skipAndContinue) {
    toolResultContent = "用户选择跳过，请自行选择最合理方案继续执行。";
  } else if (isOther && answer) {
    const sanitized = String(answer).slice(0, 200);
    toolResultContent = `用户选择了 [其他]，补充说明：${sanitized}`;
  } else if (answer) {
    toolResultContent = `用户选择了：${answer}`;
  } else {
    toolResultContent = "用户选择跳过，请自行选择最合理方案继续执行。";
  }

  // 将恢复信息写入 loopState，由 worker 恢复执行
  const state = loopState.state as Record<string, unknown>;
  await prisma.loopState.update({
    where: { runId },
    data: {
      state: {
        ...state,
        userAnswer: toolResultContent,
        resumeReady: true,
      },
    },
  });

  // 重新入队，用 answerToken 作为 jobId 避免与初始 job 的 runId 冲突
  await agentQueue.add("agent-run", {
    runId,
    projectId: id,
    userId: DEMO_USER_ID,
  }, {
    jobId: answerToken,
    attempts: 3,
    backoff: { type: "fixed", delay: 5000 },
  });

  console.log(`[API] POST /api/projects/${id.slice(0, 8)}/answer | 200 | runId=${runId.slice(0, 8)} | answer="${toolResultContent.slice(0, 50)}"`);
  return Response.json({ ok: true, runId });
}
