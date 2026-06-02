/**
 * BullMQ Worker 入口 (v7 - 沙盒化架构)
 *
 * 独立进程运行，消费 agent-tasks 队列。
 * Worker 只负责：乐观锁 (queued→running) + 调度到沙盒 + 错误处理。
 * Agent Loop 在 E2B 沙盒内运行，Worker 不等待完成。
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
import { QUEUE_NAME, type AgentJobData } from "@/lib/queue";
import { dispatchRun } from "@/lib/dispatcher";
import { prisma } from "@/lib/prisma";

// ─── 环境变量开关：新旧架构切换 ──────────────────────────────────────────────────

const USE_SANDBOX_RUNTIME = process.env.USE_SANDBOX_RUNTIME === "true";

// 旧架构导入（Phase 3 并行运行时保留）
let orchestrateRunLegacy: ((runId: string, projectId: string) => Promise<void>) | null = null;
let withProjectLockLegacy: ((projectId: string, fn: () => Promise<void>) => Promise<void>) | null = null;
let finalizeRunLegacy: ((runId: string, projectId: string, result: "succeeded" | "failed", error?: string) => Promise<void>) | null = null;

if (!USE_SANDBOX_RUNTIME) {
  const { orchestrateRun } = await import("@/lib/queue/orchestrator");
  const { withProjectLock } = await import("@/lib/queue/lock");
  const { finalizeRun } = await import("@/lib/queue/run-fencing");
  orchestrateRunLegacy = orchestrateRun;
  withProjectLockLegacy = withProjectLock;
  finalizeRunLegacy = finalizeRun;
}

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
  res.json({ status: "ok", uptime: process.uptime(), mode: USE_SANDBOX_RUNTIME ? "sandbox" : "legacy" });
});

const MONITOR_PORT = parseInt(process.env.PORT || process.env.MONITOR_PORT || "3001", 10);
app.listen(MONITOR_PORT, () => {
  console.log(`[Worker] Bull Board 监控面板: http://localhost:${MONITOR_PORT}/monitor`);
  console.log(`[Worker] Mode: ${USE_SANDBOX_RUNTIME ? "SANDBOX (v7)" : "LEGACY (v6)"}`);
});

// ─── Worker 逻辑 ────────────────────────────────────────────────────────────────

const worker = new Worker<AgentJobData>(
  QUEUE_NAME,
  async (job) => {
    const { runId, projectId } = job.data;
    console.log(`[Worker] ▶ Job ${job.id} | run=${runId.slice(0, 8)} | project=${projectId.slice(0, 8)}`);

    // 防御性检查：项目可能已被删除
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

    if (USE_SANDBOX_RUNTIME) {
      // ─── 新架构：调度到沙盒 ─────────────────────────────────────────────
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
    } else {
      // ─── 旧架构：本地执行 ───────────────────────────────────────────────
      try {
        await withProjectLockLegacy!(projectId, () => orchestrateRunLegacy!(runId, projectId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Worker] ✗ Legacy run failed: ${message}`);
        await finalizeRunLegacy!(runId, projectId, "failed", message).catch(() => {});
        throw error;
      }
    }
  },
  {
    connection: redis,
    concurrency: USE_SANDBOX_RUNTIME ? 50 : 2,
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
});

worker.on("ready", () => {
  console.log(`[Worker] Ready | concurrency=${USE_SANDBOX_RUNTIME ? 50 : 2}`);
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
