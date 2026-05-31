/**
 * POST /api/projects/:id/answer — 用户回答 ask_user 问题，恢复 Agent Loop
 */

import { prisma } from "@/lib/prisma";
import { enqueueRun } from "@/lib/queue";

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

  const run = await prisma.projectRun.findUnique({ where: { id: runId } });
  if (!run || run.projectId !== id) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  if (run.status !== "waiting_for_user") {
    return Response.json(
      { error: "Run is not waiting for user input" },
      { status: 409 }
    );
  }

  // 幂等检查：确认 answerToken 匹配
  const loopState = await prisma.loopState.findUnique({ where: { runId } });
  if (!loopState || loopState.answerToken !== answerToken) {
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

  // 更新 run 状态为 running，准备恢复
  await prisma.projectRun.update({
    where: { id: runId },
    data: { status: "running" },
  });

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

  // 重新入队，orchestrator 检测到 resumeReady 后恢复 loop
  await enqueueRun(runId, id, DEMO_USER_ID);

  console.log(`[API] POST /api/projects/${id.slice(0, 8)}/answer | 200 | runId=${runId.slice(0, 8)} | answer="${toolResultContent.slice(0, 50)}"`);
  return Response.json({ ok: true, runId });
}
