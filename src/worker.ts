/**
 * BullMQ Worker 入口
 *
 * 独立进程运行，消费 agent-tasks 队列中的任务。
 * 内置 Bull Board 监控面板（端口 3001）。
 *
 * 启动命令: npx tsx src/worker.ts
 */

import "dotenv/config";
import { Worker } from "bullmq";
import express from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Queue } from "bullmq";
import { redis } from "@/lib/redis";
import { QUEUE_NAME, type JobData } from "@/lib/queue";
import { orchestrateGenerate, orchestrateIterate } from "@/lib/queue/orchestrator";
import { withProjectLock } from "@/lib/queue/lock";
import { prisma } from "@/lib/prisma";

// ─── Bull Board 监控面板 ────────────────────────────────────────────────────────

const monitorQueue = new Queue<JobData>(QUEUE_NAME, { connection: redis });
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/monitor");

createBullBoard({
  queues: [new BullMQAdapter(monitorQueue)],
  serverAdapter,
});

const app = express();
app.use("/monitor", serverAdapter.getRouter());
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const MONITOR_PORT = parseInt(process.env.PORT || process.env.MONITOR_PORT || "3001", 10);
app.listen(MONITOR_PORT, () => {
  console.log(`[Worker] Bull Board 监控面板: http://localhost:${MONITOR_PORT}/monitor`);
});

// ─── Worker 逻辑 ────────────────────────────────────────────────────────────────

const worker = new Worker<JobData>(
  QUEUE_NAME,
  async (job) => {
    const startTime = Date.now();
    const { projectId } = job.data;
    console.log(`[Worker] ▶ Job ${job.id} started: ${job.data.type} | project: ${projectId}`);

    // 防御性检查：项目可能已被删除
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      console.log(`[Worker] 项目 ${projectId.slice(0, 8)} 已删除，跳过`);
      return;
    }

    try {
      switch (job.data.type) {
        case "generate":
          await withProjectLock(projectId, () =>
            orchestrateGenerate(projectId, job.data.prompt)
          );
          break;
        case "iterate":
          await withProjectLock(projectId, () =>
            orchestrateIterate(projectId, job.data.prompt)
          );
          break;
        default:
          console.error(`[Worker] Unknown job type: ${(job.data as JobData).type}`);
      }
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Worker] ✓ Job ${job.id} finished in ${duration}s`);
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Worker] ✗ Job ${job.id} threw after ${duration}s: ${message}`);
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 2,
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed (${job.data.type})`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
  if (err.stack) {
    console.error(`[Worker] Stack: ${err.stack.split("\n").slice(1, 4).join("\n")}`);
  }
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
