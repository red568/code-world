/**
 * 事件发射器
 *
 * 通过 Redis Pub/Sub 向两个频道发布事件：
 * 1. project:{projectId}:events — 单项目订阅（兼容现有 SSE）
 * 2. user:{userId}:events — 用户级订阅（新架构）
 */

import Redis from "ioredis";
import type {
  EventEmitterInterface,
  AgentEvent,
  AgentStatus,
  AskUserOption,
  Plan,
  PlanStep,
  RuntimeConfig,
} from "./types.js";

export class EventEmitter implements EventEmitterInterface {
  private redis: Redis;
  private userId: string;
  private projectId: string;
  private runId: string;
  private projectChannel: string;
  private userChannel: string;

  constructor(config: RuntimeConfig) {
    this.redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    this.userId = config.userId;
    this.projectId = config.projectId;
    this.runId = config.runId;
    this.projectChannel = `project:${config.projectId}:events`;
    this.userChannel = `user:${config.userId}:events`;
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  private async emit(type: string, data: Record<string, unknown>, step?: number): Promise<void> {
    const event: AgentEvent = {
      projectId: this.projectId,
      userId: this.userId,
      runId: this.runId,
      type,
      data,
      timestamp: Date.now(),
      step,
    };

    const message = JSON.stringify(event);

    await Promise.all([
      this.redis.publish(this.projectChannel, message),
      this.redis.publish(this.userChannel, message),
    ]);
  }

  async emitStatusChange(status: AgentStatus): Promise<void> {
    await this.emit("status_change", { status, message: status });
  }

  async emitStepStart(step: number): Promise<void> {
    await this.emit("agent_step_start", { step }, step);
  }

  async emitToolCall(tool: string, args: Record<string, unknown>): Promise<void> {
    const sanitizedArgs = { ...args };
    if (sanitizedArgs.content && typeof sanitizedArgs.content === "string") {
      sanitizedArgs.content = (sanitizedArgs.content as string).slice(0, 200) + "...";
    }
    await this.emit("tool_call", { tool, args: sanitizedArgs });
  }

  async emitToolCallComplete(tool: string, success: boolean, summary: string): Promise<void> {
    await this.emit("tool_result", { tool, success, summary: summary.slice(0, 300) });
  }

  async emitThinking(content: string): Promise<void> {
    await this.emit("agent_thinking", { content: content.slice(0, 500) });
  }

  async emitPreviewReady(previewUrl: string): Promise<void> {
    await this.emit("preview_ready", { previewUrl });
  }

  async emitHITLQuestion(
    question: string,
    options: AskUserOption[],
    askCount: number
  ): Promise<void> {
    await this.emit("HITL_QUESTION", { question, options, askCount });
  }

  async emitPlanCreated(plan: Plan): Promise<void> {
    await this.emit("plan_created", plan as unknown as Record<string, unknown>);
  }

  async emitPlanStepUpdated(
    stepId: number,
    status: PlanStep["status"],
    result?: string
  ): Promise<void> {
    await this.emit("plan_step_updated", { stepId, status, result });
  }

  async emitError(message: string, code?: string): Promise<void> {
    await this.emit("error", { message, code: code || "AGENT_ERROR" });
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
