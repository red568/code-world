/**
 * BullMQ 队列定义
 *
 * 所有后台任务通过此队列调度。
 * Web 端入队，Worker 端消费。
 * jobId = runId，防止重复入队。
 */

import { Queue } from "bullmq";
import { redis } from "@/lib/redis";

export const QUEUE_NAME = "agent-tasks";

export interface AgentJobData {
  runId: string;
  projectId: string;
  userId: string;
}

// 队列实例（Web 端用于入队）
const globalForQueue = globalThis as unknown as { agentQueue: Queue<AgentJobData> | undefined };

export const agentQueue =
  globalForQueue.agentQueue ??
  new Queue<AgentJobData>(QUEUE_NAME, { connection: redis });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.agentQueue = agentQueue;
}

export async function enqueueRun(
  runId: string,
  projectId: string,
  userId: string
): Promise<void> {
  await agentQueue.add("agent-run", {
    runId,
    projectId,
    userId,
  }, {
    jobId: runId,
    attempts: 3,
    backoff: { type: "fixed", delay: 5000 },
  });
}
