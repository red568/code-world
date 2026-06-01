/**
 * 运行时配置
 *
 * 从 CLI 参数和环境变量读取配置。Dispatcher 启动 agent-runtime 时注入。
 */

import type { RuntimeConfig } from "./types.js";

export function loadConfig(): RuntimeConfig {
  const args = parseArgs(process.argv.slice(2));

  const config: RuntimeConfig = {
    runId: args.runId || requireEnv("RUN_ID"),
    projectId: args.projectId || requireEnv("PROJECT_ID"),
    userId: requireEnv("USER_ID"),
    mode: (args.mode as "generate" | "iterate") || "generate",
    skipFileRestore: args.skipFileRestore === "true",
    resume: args.resume === "true",
    redisUrl: requireEnv("REDIS_URL"),
    llmApiKey: requireEnv("LLM_API_KEY"),
    llmBaseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    llmModel: process.env.LLM_MODEL || "gpt-4o",
    apiBaseUrl: requireEnv("API_BASE_URL"),
    internalApiSecret: requireEnv("INTERNAL_API_SECRET"),
    maxSteps: parseInt(process.env.MAX_STEPS || "50", 10),
    maxTokensPerTurn: parseInt(process.env.MAX_TOKENS_PER_TURN || "8192", 10),
    projectDir: process.env.PROJECT_DIR || "/home/user/app",
  };

  return config;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of argv) {
    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}
