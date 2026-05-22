/**
 * BullMQ Worker 入口
 *
 * 独立进程运行，消费 agent-tasks 队列中的任务。
 * 部署时作为 Railway 的 Worker 服务运行。
 *
 * 启动命令: npx tsx src/worker.ts
 */

import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "@/lib/redis";
import { QUEUE_NAME, type JobData } from "@/lib/queue";
import { orchestrateGenerate, orchestrateIterate } from "@/lib/queue/orchestrator";

const worker = new Worker<JobData>(
  QUEUE_NAME,
  async (job) => {
    console.log(`[Worker] Processing job ${job.id}: ${job.data.type} for project ${job.data.projectId}`);

    switch (job.data.type) {
      case "generate":
        await orchestrateGenerate(job.data.projectId, job.data.prompt);
        break;
      case "iterate":
        await orchestrateIterate(job.data.projectId, job.data.prompt);
        break;
      default:
        console.error(`[Worker] Unknown job type: ${(job.data as JobData).type}`);
    }
  },
  {
    connection: redis,
    concurrency: 2,
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed:`, err.message);
});

worker.on("ready", () => {
  console.log("[Worker] Ready and waiting for jobs...");
});

// 优雅退出
process.on("SIGTERM", async () => {
  console.log("[Worker] Shutting down...");
  await worker.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Worker] Shutting down...");
  await worker.close();
  process.exit(0);
});
