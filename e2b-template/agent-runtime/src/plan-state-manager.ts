/**
 * Plan 状态管理器
 *
 * 管理 Plan 的创建、更新、重规划。
 * 状态持久化到 Redis，事件推送到前端。
 * 如果连续 3 步未更新 Plan 状态，返回强制提醒。
 */

import type {
  Plan,
  PlanStep,
  EventEmitterInterface,
  RedisInterface,
  LoggerInterface,
} from "./types.js";

let nextId = 1;
function generateId(): string {
  return `plan-${Date.now()}-${nextId++}`;
}

export class PlanStateManager {
  private currentPlan: Plan | null = null;
  private runId: string;
  private redis: RedisInterface;
  private eventEmitter: EventEmitterInterface;
  private logger: LoggerInterface;
  private stepsSinceLastUpdate = 0;

  constructor(
    runId: string,
    redis: RedisInterface,
    eventEmitter: EventEmitterInterface,
    logger: LoggerInterface
  ) {
    this.runId = runId;
    this.redis = redis;
    this.eventEmitter = eventEmitter;
    this.logger = logger;
  }

  get plan(): Plan | null {
    return this.currentPlan;
  }

  get needsReminder(): boolean {
    return this.currentPlan !== null && this.stepsSinceLastUpdate >= 3;
  }

  incrementStepCounter(): void {
    if (this.currentPlan) {
      this.stepsSinceLastUpdate++;
    }
  }

  resetStepCounter(): void {
    this.stepsSinceLastUpdate = 0;
  }

  getReminderMessage(): string {
    if (!this.currentPlan) return "";
    const running = this.currentPlan.steps.find((s) => s.status === "running");
    const pending = this.currentPlan.steps.filter((s) => s.status === "pending");
    return `[系统提醒] 你正在执行计划模式。当前步骤: "${running?.title || "未知"}"。请在完成当前步骤后调用 update_plan_step 更新状态。剩余 ${pending.length} 个待执行步骤。`;
  }

  async createPlan(title: string, steps: Omit<PlanStep, "id" | "status" | "startedAt" | "completedAt">[]): Promise<Plan> {
    this.currentPlan = {
      id: generateId(),
      title,
      steps: steps.map((s, i) => ({
        ...s,
        id: i + 1,
        status: "pending" as const,
      })),
      version: 1,
      createdAt: Date.now(),
    };

    await this.persist();
    await this.eventEmitter.emitPlanCreated(this.currentPlan);
    this.logger.info("Plan created", { title, stepCount: steps.length });
    this.resetStepCounter();

    return this.currentPlan;
  }

  async updateStepStatus(
    stepId: number,
    status: PlanStep["status"],
    result?: string
  ): Promise<void> {
    if (!this.currentPlan) throw new Error("No active plan");

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);

    step.status = status;
    if (status === "running") step.startedAt = Date.now();
    if (status === "completed" || status === "failed") {
      step.completedAt = Date.now();
      step.result = result;
    }

    await this.persist();
    await this.eventEmitter.emitPlanStepUpdated(stepId, status, result);
    this.resetStepCounter();

    this.logger.info("Plan step updated", { stepId, status });
  }

  async addStep(
    afterStepId: number,
    step: { title: string; description: string }
  ): Promise<PlanStep> {
    if (!this.currentPlan) throw new Error("No active plan");

    const index = this.currentPlan.steps.findIndex((s) => s.id === afterStepId);
    if (index === -1) throw new Error(`Step ${afterStepId} not found`);

    const newId = Math.max(...this.currentPlan.steps.map((s) => s.id)) + 1;
    const newStep: PlanStep = {
      ...step,
      id: newId,
      status: "pending",
    };

    this.currentPlan.steps.splice(index + 1, 0, newStep);
    this.currentPlan.version++;

    await this.persist();
    this.logger.info("Plan step added", { afterStepId, newStep: step.title });
    this.resetStepCounter();

    return newStep;
  }

  async replanFromStep(
    fromStepId: number,
    reason: string,
    newSteps: { title: string; description: string }[]
  ): Promise<void> {
    if (!this.currentPlan) throw new Error("No active plan");

    const index = this.currentPlan.steps.findIndex((s) => s.id === fromStepId);
    if (index === -1) throw new Error(`Step ${fromStepId} not found`);

    const maxId = Math.max(...this.currentPlan.steps.map((s) => s.id));
    const replacementSteps: PlanStep[] = newSteps.map((s, i) => ({
      ...s,
      id: maxId + i + 1,
      status: "pending" as const,
    }));

    this.currentPlan.steps = [
      ...this.currentPlan.steps.slice(0, index),
      ...replacementSteps,
    ];
    this.currentPlan.version++;

    await this.persist();
    this.logger.info("Plan replanned", { fromStepId, reason, newStepCount: newSteps.length });
    this.resetStepCounter();
  }

  getStatus(): { plan: Plan | null; progress: string } {
    if (!this.currentPlan) {
      return { plan: null, progress: "No active plan" };
    }

    const total = this.currentPlan.steps.length;
    const completed = this.currentPlan.steps.filter((s) => s.status === "completed").length;
    const failed = this.currentPlan.steps.filter((s) => s.status === "failed").length;
    const running = this.currentPlan.steps.find((s) => s.status === "running");

    return {
      plan: this.currentPlan,
      progress: `${completed}/${total} completed${failed > 0 ? `, ${failed} failed` : ""}${running ? `, current: "${running.title}"` : ""}`,
    };
  }

  private async persist(): Promise<void> {
    if (!this.currentPlan) return;
    await this.redis.setex(
      `plan:${this.runId}`,
      3600,
      JSON.stringify(this.currentPlan)
    );
  }
}
