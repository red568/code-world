/**
 * Agent Runtime 入口
 *
 * CLI 参数解析 → 初始化模块 → 运行 Loop → 完成后同步文件 → 退出。
 */

import Redis from "ioredis";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { EventEmitter } from "./event-emitter.js";
import { agentLoop } from "./loop.js";
import { SkillManager } from "./skill-manager.js";
import { MemoryManager } from "./memory-manager.js";
import { createLLMClient, getModel } from "./llm-client.js";
import { selectMode, getPlanModeSystemAddition } from "./mode-selector.js";
import { PlanStateManager } from "./plan-state-manager.js";
import { callInternalAPI } from "./tools.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext, RuntimeConfig, LoggerInterface } from "./types.js";

const SYSTEM_PROMPT = `你是一个高级全栈网站开发 Agent。用户描述想要的网站，你通过工具自主完成从规划到部署的全过程。

## 你的工具

- write_file(path, content): 创建或覆盖项目文件
- read_file(path): 读取文件内容
- list_files(): 列出 src/ 下所有源码文件
- run_shell(command): 在项目目录执行 shell 命令
- get_preview_url(port): 获取公网预览地址（启动 dev server 后调用）
- ask_user(question, options, context): 向用户提问（最后手段，每次任务最多 3 次）
- finish(summary, success): 任务完成后调用此工具结束执行

## 技术栈（固定，不可更改）

- React 18 + TypeScript + Vite + Tailwind CSS
- 白名单依赖（已预装，可直接 import）：
  - react, react-dom
  - lucide-react（图标）
  - framer-motion（动画）
  - recharts（图表）
- 不允许使用白名单外的任何第三方包
- 如果需要某个功能，用原生 React + Tailwind 实现

## 工作方式

1. 分析用户需求，在回复中简要说明你的计划（需要哪些文件、各自职责）
2. 按依赖顺序写文件：先写叶子组件，最后写 App.tsx
3. 每写完 3-4 个文件，用 run_shell("npx tsc --noEmit") 做一次类型检查
4. 全部写完后 run_shell("npm run build") 构建项目
5. 如果构建失败：read_file 查看报错文件 → 修复 → 重新 build
6. 构建成功后：run_shell("nohup npx vite --host 0.0.0.0 --port 5173 > /dev/null 2>&1 & sleep 3 && curl -s -o /dev/null -w '%{http_code}' http://localhost:5173") 后台启动并验证
7. 确认 200 后调用 get_preview_url(5173) 获取公网地址
8. 获取到预览 URL 后，调用 finish(summary, success=true) 结束任务

## 重要约束

- 每轮必须调用至少一个工具
- 不要在回复中重复文件的完整内容
- 一个文件不超过 300 行，否则拆分
- CSS 使用 Tailwind utility class，不写自定义 CSS（除非动画）
- 所有组件都是 TypeScript，带 proper types
- ask_user 是最后手段，尽量自行决策`;

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.runId, config.projectId);
  const eventEmitter = new EventEmitter(config);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });

  try {
    // 连接 Redis
    await redis.connect();
    await eventEmitter.connect();

    logger.info("Agent Runtime starting", {
      runId: config.runId,
      projectId: config.projectId,
      mode: config.mode,
      resume: config.resume,
    });

    // 发射 running 状态
    await eventEmitter.emitStatusChange("running");

    // 加载 Skills
    const skillManager = new SkillManager(redis, logger, config);
    await skillManager.loadSkills();

    // 获取用户消息（从后端 API 或环境变量）
    const userMessage = process.env.USER_MESSAGE || "请根据项目需求继续工作";

    // 模式选择
    const client = createLLMClient(config);
    const model = getModel(config);
    const modeAnalysis = await selectMode(client, model, userMessage, config);
    logger.info("Mode selected", { mode: modeAnalysis.mode, reason: modeAnalysis.reason });

    // 构建 system prompt
    let systemPrompt = SYSTEM_PROMPT;
    if (modeAnalysis.mode === "plan") {
      systemPrompt += getPlanModeSystemAddition();
    }

    // 加载对话历史缓存（如果是 iterate 且沙盒复用）
    let existingMessages = undefined;
    if (config.mode === "iterate" && config.skipFileRestore) {
      const cached = await redis.get(`conversation:${config.projectId}`);
      if (cached) {
        existingMessages = JSON.parse(cached);
        logger.info("Loaded conversation from cache", { messageCount: existingMessages.length });
      }
    }

    // 运行 Agent Loop
    const result = await agentLoop({
      config,
      systemPrompt,
      userMessage,
      existingMessages,
      eventEmitter,
      logger,
      redis,
    });

    logger.info("Agent Loop completed", {
      success: result.success,
      steps: result.steps,
      summary: result.summary.slice(0, 200),
    });

    // 缓存对话历史（供下次 iterate 复用）
    await redis.setex(
      `conversation:${config.projectId}`,
      900, // 15 分钟 TTL，与沙盒生命周期一致
      JSON.stringify(result.finalMessages)
    );

    // 同步文件到后端
    if (result.success) {
      await syncFilesToBackend(config, logger);
    }

    // 通知后端完成
    const toolCtx: ToolContext = {
      projectId: config.projectId,
      runId: config.runId,
      projectDir: config.projectDir,
      eventEmitter,
      logger,
      redis,
      config,
      askUserCount: 0,
    };

    await callInternalAPI(toolCtx, "/api/internal/run/finalize", {
      runId: config.runId,
      projectId: config.projectId,
      status: result.success ? "succeeded" : "failed",
      error: result.success ? undefined : result.summary,
      summary: result.summary,
      previewUrl: result.previewUrl,
    });

    // 发射最终状态
    await eventEmitter.emitStatusChange(result.success ? "succeeded" : "failed");

    // 清理
    await logger.close();
    await eventEmitter.close();
    await redis.quit();

    process.exit(result.success ? 0 : 1);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Agent Runtime fatal error", { error: msg });

    try {
      await eventEmitter.emitError(msg, "RUNTIME_ERROR");
      await eventEmitter.emitStatusChange("failed");

      const toolCtx: ToolContext = {
        projectId: config.projectId,
        runId: config.runId,
        projectDir: config.projectDir,
        eventEmitter,
        logger,
        redis,
        config,
        askUserCount: 0,
      };

      await callInternalAPI(toolCtx, "/api/internal/run/finalize", {
        runId: config.runId,
        projectId: config.projectId,
        status: "failed",
        error: msg,
      });
    } catch {
      // best effort
    }

    await logger.close();
    await eventEmitter.close();
    await redis.quit();
    process.exit(1);
  }
}

async function syncFilesToBackend(config: RuntimeConfig, logger: LoggerInterface): Promise<void> {
  const srcDir = join(config.projectDir, "src");
  const files: { path: string; content: string }[] = [];

  try {
    await collectFiles(srcDir, config.projectDir, files);
  } catch {
    logger.warn("Failed to collect files for sync");
    return;
  }

  if (files.length === 0) return;

  try {
    const url = `${config.apiBaseUrl}/api/internal/files/sync`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": config.internalApiSecret,
      },
      body: JSON.stringify({ projectId: config.projectId, files }),
    });

    if (response.ok) {
      logger.info("Files synced to backend", { count: files.length });
    } else {
      logger.warn("File sync failed", { status: response.status });
    }
  } catch (error) {
    logger.error("File sync error", { error: String(error) });
  }
}

async function collectFiles(
  dir: string,
  baseDir: string,
  files: { path: string; content: string }[]
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await collectFiles(fullPath, baseDir, files);
    } else if (/\.(tsx?|css|json|html|js)$/.test(entry.name)) {
      const content = await readFile(fullPath, "utf-8");
      const relativePath = fullPath.replace(baseDir + "/", "").replace(baseDir + "\\", "");
      files.push({ path: relativePath, content });
    }
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
