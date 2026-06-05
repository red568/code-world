/**
 * Agent Runtime 共享类型定义
 */

import type OpenAI from "openai";

// ─── Runtime 配置 ────────────────────────────────────────────────────────────

export interface RuntimeConfig {
  runId: string;
  projectId: string;
  userId: string;
  mode: "generate" | "iterate";
  skipFileRestore: boolean;
  resume: boolean;
  redisUrl: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  apiBaseUrl: string;
  internalApiSecret: string;
  maxSteps: number;
  maxTokensPerTurn: number;
  projectDir: string;
}

// ─── Agent 事件 ──────────────────────────────────────────────────────────────

export interface AgentEvent {
  projectId: string;
  userId: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
  step?: number;
}

export type AgentStatus =
  | "initializing"
  | "running"
  | "paused"
  | "succeeded"
  | "failed";

// ─── 工具相关 ────────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface ToolContext {
  projectId: string;
  runId: string;
  projectDir: string;
  eventEmitter: EventEmitterInterface;
  logger: LoggerInterface;
  redis: RedisInterface;
  config: RuntimeConfig;
  askUserCount: number;
}

// ─── Plan 相关 ────────────────────────────────────────────────────────────────

export interface PlanStep {
  id: number;
  title: string;
  description: string;
  dependencies?: number[];
  estimatedTime?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: number;
  completedAt?: number;
  result?: string;
}

export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  version: number;
  createdAt: number;
}

// ─── Skill 相关 ──────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  displayName: string;
  description: string;
  category: string;
  schema: Record<string, unknown>;
  type: "builtin" | "composite" | "mcp";
  implementation?: CompositeStep[];
  mcpConfig?: { server: string; method: string };
}

export interface CompositeStep {
  tool: string;
  args: Record<string, unknown>;
  outputVar?: string;
}

// ─── Memory 相关 ─────────────────────────────────────────────────────────────

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  id?: string;
  type: MemoryType;
  name: string;
  content: string;
  projectId?: string;
  userId?: string;
}

// ─── Loop 结果 ───────────────────────────────────────────────────────────────

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  steps: number;
  previewUrl: string | null;
  finalMessages: OpenAI.ChatCompletionMessageParam[];
}

// ─── 接口抽象 ────────────────────────────────────────────────────────────────

export interface EventEmitterInterface {
  emitStatusChange(status: AgentStatus): Promise<void>;
  emitStepStart(step: number): Promise<void>;
  emitToolCall(tool: string, args: Record<string, unknown>): Promise<void>;
  emitToolCallComplete(tool: string, success: boolean, summary: string): Promise<void>;
  emitThinking(content: string): Promise<void>;
  emitPreviewReady(previewUrl: string): Promise<void>;
  emitHITLQuestion(question: string, options: AskUserOption[], askCount: number): Promise<void>;
  emitPlanCreated(plan: Plan): Promise<void>;
  emitPlanStepUpdated(stepId: number, status: PlanStep["status"], result?: string): Promise<void>;
  emitError(message: string, code?: string): Promise<void>;
  close(): Promise<void>;
}

export interface AskUserOption {
  label: string;
  description: string;
  value?: string;
}

export interface LoggerInterface {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export interface RedisInterface {
  publish(channel: string, message: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  lpush(key: string, ...values: string[]): Promise<number>;
  brpop(...args: unknown[]): Promise<[string, string] | null>;
  quit(): Promise<string>;
}
