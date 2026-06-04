/**
 * GET /api/projects/:id/stream — SSE 实时事件流
 *
 * 订阅 Redis pub/sub 频道，将 Worker 推送的事件实时转发给浏览器。
 * 连接建立时回放当前 run 状态，避免因时序竞态丢失早期事件。
 */

import { prisma } from "@/lib/prisma";
import { redisSub } from "@/lib/redis";
import { getProjectChannel } from "@/lib/streaming";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = getProjectChannel(id);
  const encoder = new TextEncoder();

  // 为每个 SSE 连接创建独立的 Redis 订阅客户端
  const subscriber = redisSub.duplicate();

  const stream = new ReadableStream({
    async start(controller) {
      // 发送初始连接确认
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ projectId: id })}\n\n`)
      );

      // 回放当前 run 状态（解决 SSE 订阅 vs 事件发射的竞态）
      try {
        const activeRun = await prisma.projectRun.findFirst({
          where: {
            projectId: id,
            status: { in: ["queued", "running", "paused"] },
          },
          orderBy: { createdAt: "desc" },
        });

        if (activeRun) {
          const status = activeRun.status === "queued" ? "code_generating" : activeRun.status;
          const message = activeRun.status === "queued"
            ? "排队中..."
            : activeRun.status === "running"
              ? "Agent 执行中..."
              : activeRun.status === "paused"
                ? "等待用户回答..."
                : activeRun.status;
          controller.enqueue(
            encoder.encode(`event: status_change\ndata: ${JSON.stringify({ status, message })}\n\n`)
          );
        }
      } catch {
        // best effort，不阻塞连接
      }

      const messageHandler = (receivedChannel: string, message: string) => {
        if (receivedChannel === channel) {
          try {
            const event = JSON.parse(message);
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
            );
          } catch {
            // 忽略格式错误的消息
          }
        }
      };

      subscriber.on("message", messageHandler);
      await subscriber.subscribe(channel);

      // 客户端断开时清理订阅
      request.signal.addEventListener("abort", () => {
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
