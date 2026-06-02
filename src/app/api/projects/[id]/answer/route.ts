/**
 * POST /api/projects/:id/answer — 用户回答 ask_user 问题
 *
 * 通过 Redis LPUSH 将答案推送到沙盒内 agent-runtime 的 BRPOP 队列。
 */

import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const body = await request.json();
  const { runId, answer, isOther, skipAndContinue, askCount } = body;

  if (!runId || askCount == null) {
    return Response.json(
      { error: "runId and askCount are required" },
      { status: 400 }
    );
  }

  // 构造回答内容
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
