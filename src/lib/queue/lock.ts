/**
 * 项目级并发锁（Redis SET NX EX）
 *
 * 保证同一项目同时只有一个 Agent Loop 在运行。
 */

import { redis } from "@/lib/redis";

const LOCK_PREFIX = "project-lock:";
const DEFAULT_TTL_SEC = 600; // 10 分钟自动过期兜底

export async function acquireProjectLock(
  projectId: string,
  ttlSec = DEFAULT_TTL_SEC
): Promise<boolean> {
  const key = LOCK_PREFIX + projectId;
  const result = await redis.set(key, Date.now().toString(), "EX", ttlSec, "NX");
  return result === "OK";
}

export async function releaseProjectLock(projectId: string): Promise<void> {
  const key = LOCK_PREFIX + projectId;
  await redis.del(key);
}

export async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  ttlSec = DEFAULT_TTL_SEC
): Promise<T> {
  const acquired = await acquireProjectLock(projectId, ttlSec);
  if (!acquired) {
    throw new Error(`项目 ${projectId.slice(0, 8)} 正在处理中，请稍后再试`);
  }
  try {
    return await fn();
  } finally {
    await releaseProjectLock(projectId);
  }
}
