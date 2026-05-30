/**
 * 项目取消信号（Redis flag）
 *
 * 协作式取消：stop/delete 设置 flag，agent loop 在安全点检查并退出。
 */

import { redis } from "@/lib/redis";

const CANCEL_PREFIX = "project-cancelled:";
const DEFAULT_TTL_SEC = 600;

export async function setCancelled(projectId: string, ttlSec = DEFAULT_TTL_SEC): Promise<void> {
  await redis.set(CANCEL_PREFIX + projectId, "1", "EX", ttlSec);
}

export async function isCancelled(projectId: string): Promise<boolean> {
  const val = await redis.get(CANCEL_PREFIX + projectId);
  return val === "1";
}

export async function clearCancelled(projectId: string): Promise<void> {
  await redis.del(CANCEL_PREFIX + projectId);
}
