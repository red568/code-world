/**
 * BullMQ Worker — 沙盒架构
 *
 * 独立进程运行，消费 agent-tasks 队列。
 * Worker 只负责：乐观锁 (queued→running) + 调度到沙盒 + 错误处理。
 * Agent Loop 在 E2B 沙盒内运行，Worker 不等待完成。
 *
 * 启动命令: npm run worker
 */

import "dotenv/config";
import { Worker } from "bullmq";
import express from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Queue } from "bullmq";
import { redis } from "@/lib/redis";
import { QUEUE_NAME, type AgentJobData } from "@/lib/queue";
import { dispatchRun } from "@/lib/dispatcher";
import { prisma } from "@/lib/prisma";

// ─── Bull Board 监控面板 ────────────────────────────────────────────────────────

const monitorQueue = new Queue<AgentJobData>(QUEUE_NAME, { connection: redis });
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
  console.log(`[Worker] Bull Board: http://localhost:${MONITOR_PORT}/monitor`);
});

// ─── Worker 逻辑 ────────────────────────────────────────────────────────────────

const worker = new Worker<AgentJobData>(
  QUEUE_NAME,
  async (job) => {
    const { runId, projectId } = job.data;
    console.log(`[Worker] ▶ Job ${job.id} | run=${runId.slice(0, 8)} | project=${projectId.slice(0, 8)}`);

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      console.log(`[Worker] 项目 ${projectId.slice(0, 8)} 已删除，跳过`);
      return;
    }

    // 乐观锁：queued → running
    const claimed = await prisma.projectRun.updateMany({
      where: { id: runId, status: "queued" },
      data: { status: "running", startedAt: new Date() },
    });

    if (claimed.count === 0) {
      console.log(`[Worker] Run ${runId.slice(0, 8)} 不再是 queued，跳过`);
      return;
    }

    try {
      await dispatchRun(runId, projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Worker] ✗ Dispatch failed: ${message}`);
      await prisma.projectRun.update({
        where: { id: runId },
        data: { status: "failed", error: message, finishedAt: new Date() },
      }).catch(() => {});
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 50,
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] ✓ Job ${job.id} dispatched`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] ✗ Job ${job?.id} failed: ${err.message}`);
});

worker.on("ready", () => {
  console.log("[Worker] Ready | concurrency=50");
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
