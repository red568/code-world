/**
 * 项目级并发锁（Redis SET NX EX + owner token + heartbeat 续租）
 *
 * 保证同一项目同时只有一个 Agent Loop 或删除操作在运行。
 * 释放时通过 Lua compare-and-delete 确保只有持有者能释放。
 * 长任务通过 heartbeat 自动续租，防止 TTL 过期导致锁丢失。
 */

import { redis } from "@/lib/redis";
import { randomUUID } from "crypto";
import { setCancelled } from "@/lib/queue/cancel";

const LOCK_PREFIX = "project-lock:";
const DEFAULT_TTL_SEC = 600;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface LockResult {
  acquired: boolean;
  token: string;
}

export async function acquireProjectLock(
  projectId: string,
  ttlSec = DEFAULT_TTL_SEC
): Promise<LockResult> {
  const token = randomUUID();
  const key = LOCK_PREFIX + projectId;
  const result = await redis.set(key, token, "EX", ttlSec, "NX");
  return { acquired: result === "OK", token };
}

export async function releaseProjectLock(
  projectId: string,
  token: string
): Promise<boolean> {
  const key = LOCK_PREFIX + projectId;
  const result = await redis.eval(RELEASE_SCRIPT, 1, key, token);
  return result === 1;
}

async function renewProjectLock(
  projectId: string,
  token: string,
  ttlSec: number
): Promise<boolean> {
  const key = LOCK_PREFIX + projectId;
  const result = await redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlSec));
  return result === 1;
}

export async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  ttlSec = DEFAULT_TTL_SEC
): Promise<T> {
  const { acquired, token } = await acquireProjectLock(projectId, ttlSec);
  if (!acquired) {
    throw new Error(`项目 ${projectId.slice(0, 8)} 正在处理中，请稍后再试`);
  }

  // 每 TTL/3 续租一次，保证长任务不会锁过期
  const renewInterval = setInterval(async () => {
    try {
      const renewed = await renewProjectLock(projectId, token, ttlSec);
      if (!renewed) {
        // 锁已丢失（TTL 过期被其他人获取），设置取消信号让 agent loop 退出
        clearInterval(renewInterval);
        await setCancelled(projectId).catch(() => {});
      }
    } catch {
      // 续租失败不中断主任务，依赖剩余 TTL 兜底
    }
  }, (ttlSec / 3) * 1000);

  try {
    return await fn();
  } finally {
    clearInterval(renewInterval);
    await releaseProjectLock(projectId, token);
  }
}
