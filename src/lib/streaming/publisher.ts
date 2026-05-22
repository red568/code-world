/**
 * SSE 事件发布器
 *
 * Worker 端使用，将事件推送到 Redis pub/sub 频道。
 * SSE 端点订阅同一频道后转发给浏览器。
 */

import { redis } from "@/lib/redis";
import { type SSEEvent, getProjectChannel } from "./events";

/**
 * 向指定项目的事件频道发布一条 SSE 事件
 */
export async function publishEvent(
  projectId: string,
  event: SSEEvent
): Promise<void> {
  const channel = getProjectChannel(projectId);
  await redis.publish(channel, JSON.stringify(event));
}

/**
 * 快捷方法：发布状态变更事件
 */
export async function publishStatusChange(
  projectId: string,
  status: SSEEvent extends { type: "status_change" } ? SSEEvent["data"]["status"] : string,
  message: string
): Promise<void> {
  await publishEvent(projectId, {
    type: "status_change",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { status: status as any, message },
  });
}

/**
 * 快捷方法：发布构建日志
 */
export async function publishBuildLog(
  projectId: string,
  stream: "stdout" | "stderr",
  line: string
): Promise<void> {
  await publishEvent(projectId, {
    type: "build_log",
    data: { stream, line },
  });
}

/**
 * 快捷方法：发布错误事件
 */
export async function publishError(
  projectId: string,
  message: string,
  code: string = "UNKNOWN_ERROR"
): Promise<void> {
  await publishEvent(projectId, {
    type: "error",
    data: { message, code },
  });
}
