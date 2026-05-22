/**
 * BullMQ 队列定义
 *
 * 所有后台任务通过此队列调度。
 * Web 端入队，Worker 端消费。
 */

import { Queue } from "bullmq";
import { redis } from "@/lib/redis";

export const QUEUE_NAME = "agent-tasks";

// 任务数据类型
export interface GenerateJobData {
  type: "generate";
  projectId: string;
  prompt: string;
}

export interface IterateJobData {
  type: "iterate";
  projectId: string;
  prompt: string;
}

export type JobData = GenerateJobData | IterateJobData;

// 队列实例（Web 端用于入队）
const globalForQueue = globalThis as unknown as { agentQueue: Queue<JobData> | undefined };

export const agentQueue =
  globalForQueue.agentQueue ??
  new Queue<JobData>(QUEUE_NAME, { connection: redis });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.agentQueue = agentQueue;
}

/**
 * 添加生成任务到队列
 */
export async function enqueueGenerate(
  projectId: string,
  prompt: string
): Promise<void> {
  await agentQueue.add("generate", {
    type: "generate",
    projectId,
    prompt,
  });
}

/**
 * 添加迭代修改任务到队列
 */
export async function enqueueIterate(
  projectId: string,
  prompt: string
): Promise<void> {
  await agentQueue.add("iterate", {
    type: "iterate",
    projectId,
    prompt,
  });
}
