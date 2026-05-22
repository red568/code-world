/**
 * GET /api/projects/:id/stream — SSE 实时事件流
 *
 * 订阅 Redis pub/sub 频道，将 Worker 推送的事件实时转发给浏览器。
 */

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
