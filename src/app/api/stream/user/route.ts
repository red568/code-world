/**
 * 用户级 SSE 端点
 *
 * 订阅 user:{userId}:events Redis 频道，单连接接收所有项目事件。
 * 前端只需建立一个 EventSource 即可接收用户所有项目的实时状态。
 */

import { redis } from "@/lib/redis";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 临时获取用户 ID（demo 阶段使用固定用户）
function getUserId(request: Request): string | null {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");
  return userId || "demo-user-001";
}

export async function GET(request: Request) {
  const userId = getUserId(request);

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const subscriber = redis.duplicate();
      const channel = `user:${userId}:events`;

      await subscriber.subscribe(channel);

      console.log(`[SSE] User stream connected | user=${userId.slice(0, 8)}`);

      // 发送连接确认
      const connectMessage = formatSSE({
        type: "connected",
        data: { userId, timestamp: Date.now() },
      });
      controller.enqueue(encoder.encode(connectMessage));

      // 监听 Redis 消息
      subscriber.on("message", (ch: string, message: string) => {
        if (ch === channel) {
          try {
            const event = JSON.parse(message);
            const sseMessage = formatSSE(event);
            controller.enqueue(encoder.encode(sseMessage));
          } catch (error) {
            console.error("[SSE] Failed to parse message:", error);
          }
        }
      });

      // 心跳（每 30 秒）
      const heartbeatInterval = setInterval(() => {
        const heartbeat = formatSSE({
          type: "heartbeat",
          data: { timestamp: Date.now() },
        });
        controller.enqueue(encoder.encode(heartbeat));
      }, 30000);

      // 清理
      request.signal.addEventListener("abort", async () => {
        console.log(`[SSE] User stream disconnected | user=${userId.slice(0, 8)}`);
        clearInterval(heartbeatInterval);
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
        controller.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function formatSSE(event: Record<string, unknown>): string {
  const lines: string[] = [];
  if (event.type) {
    lines.push(`event: ${event.type}`);
  }
  const data = JSON.stringify(event);
  lines.push(`data: ${data}`);
  lines.push("");
  lines.push("");
  return lines.join("\n");
}
