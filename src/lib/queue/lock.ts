/**
 * 项目级并发锁（Redis SET NX EX + owner token）
 *
 * DELETE 路由用于防止删除项目时与 Worker 竞态。
 */

import { redis } from "@/lib/redis";
import { randomUUID } from "crypto";

const LOCK_PREFIX = "project-lock:";
const DEFAULT_TTL_SEC = 600;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
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
