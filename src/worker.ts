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
import { redis, redisSub } from "@/lib/redis";
import { QUEUE_NAME, type AgentJobData } from "@/lib/queue";
import { dispatchRun } from "@/lib/dispatcher";
import { prisma } from "@/lib/prisma";

// ─── Agent 事件日志订阅 ────────────────────────────────────────────────────────

function startAgentLogger() {
  redisSub.psubscribe("project:*:events").then(() => {
    console.log("[AgentLog] Subscribed to project:*:events");
  });

  redisSub.on("pmessage", (_pattern, channel, message) => {
    try {
      const projectId = channel.split(":")[1]?.slice(0, 8);
      const event = JSON.parse(message);
      const { type, data } = event;

      switch (type) {
        case "status_change":
          console.log(`[Agent] ${projectId} | status → ${data.status} | ${data.message}`);
          break;
        case "agent_thinking":
          console.log(`[Agent] ${projectId} | thinking | ${data.content.slice(0, 120)}`);
          break;
        case "tool_call":
          console.log(`[Agent] ${projectId} | tool_call | ${data.tool} | ${JSON.stringify(data.args).slice(0, 100)}`);
          break;
        case "tool_result":
          console.log(`[Agent] ${projectId} | tool_result | ${data.tool} | success=${data.success} | ${data.summary.slice(0, 80)}`);
          break;
        case "ask_user":
          console.log(`[Agent] ${projectId} | ask_user | ${data.question}`);
          break;
        case "preview_ready":
          console.log(`[Agent] ${projectId} | preview_ready | ${data.previewUrl}`);
          break;
        case "build_log":
          console.log(`[Agent] ${projectId} | ${data.stream} | ${data.line}`);
          break;
        case "error":
          console.error(`[Agent] ${projectId} | ERROR | ${data.code} | ${data.message}`);
          break;
        case "codegen_file_start":
          console.log(`[Agent] ${projectId} | codegen | start ${data.path}`);
          break;
        case "codegen_file_done":
          console.log(`[Agent] ${projectId} | codegen | done ${data.path}`);
          break;
        case "clarification_needed":
          console.log(`[Agent] ${projectId} | clarification | clarity=${data.clarity} | questions=${data.missing_info?.length}`);
          break;
        default:
          console.log(`[Agent] ${projectId} | ${type}`);
      }
    } catch {
      // ignore malformed messages
    }
  });
}

startAgentLogger();

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
