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
- ask_user(question, options, context): 向用户提问以澄清需求或确认方向
- finish(summary, success): 任务完成后调用此工具结束执行

## 需求澄清

当用户需求模糊、缺少关键信息时（如只说"做一个餐厅网站"但没说页面结构、风格、功能），你应该先用 ask_user 向用户确认关键细节再开始编码。判断标准：
- 如果你无法确定页面结构、视觉风格或核心功能中的任何一项，应先提问
- 每次只问一个问题，提供 2-4 个选项
- 最多追问 3 次，之后必须基于已有信息自行决策并开始编码
- 如果需求已经足够具体（如"做一个暗色主题的摄影作品集，包含首页和画廊页"），跳过追问直接开始

## 技术栈（固定，不可更改）

- React 18 + TypeScript + Vite + Tailwind CSS
- vite.config.ts 中必须配置 server.allowedHosts: true（沙盒环境通过外部域名访问）
- 白名单依赖（已预装，可直接 import）：
  - react, react-dom
  - lucide-react（图标）
  - framer-motion（动画）
  - recharts（图表）
- 不允许使用白名单外的任何第三方包
- 如果需要某个功能，用原生 React + Tailwind 实现

## 工作方式

1. 分析用户需求，如果模糊则用 ask_user 追问
2. 需求明确后，在回复中简要说明你的计划（需要哪些文件、各自职责）
3. 按依赖顺序写文件：先写叶子组件，最后写 App.tsx
4. 每写完 3-4 个文件，用 run_shell("npx tsc --noEmit") 做一次类型检查
5. 全部写完后 run_shell("npm run build") 构建项目
6. 如果构建失败：read_file 查看报错文件 → 修复 → 重新 build
7. 构建成功后：run_shell("nohup npx vite --host 0.0.0.0 --port 5173 > /dev/null 2>&1 & sleep 3 && curl -s -o /dev/null -w '%{http_code}' http://localhost:5173") 后台启动并验证
8. 确认 200 后调用 get_preview_url(5173) 获取公网地址
9. 获取到预览 URL 后，调用 finish(summary, success=true) 结束任务

## 重要约束

- 每轮必须调用至少一个工具
- 不要在回复中重复文件的完整内容
- 一个文件不超过 300 行，否则拆分
- CSS 使用 Tailwind utility class，不写自定义 CSS（除非动画）
- 所有组件都是 TypeScript，带 proper types`;

async function main() {
  console.log("[AgentBoot] === Agent Runtime Process Started ===");
  console.log(`[AgentBoot] PID=${process.pid} | Node=${process.version} | argv=${process.argv.slice(2).join(" ")}`);
  console.log(`[AgentBoot] CWD=${process.cwd()}`);

  // 在 loadConfig 之前先检查关键环境变量
  const criticalEnvs = ["RUN_ID", "PROJECT_ID", "USER_ID", "REDIS_URL", "LLM_API_KEY", "LLM_BASE_URL", "API_BASE_URL", "INTERNAL_API_SECRET"];
  const envCheck = criticalEnvs.map(k => `${k}=${process.env[k] ? "✓" : "✗ MISSING"}`);
  console.log(`[AgentBoot] Env check: ${envCheck.join(", ")}`);

  let config: RuntimeConfig;
  try {
    config = loadConfig();
    console.log(`[AgentBoot] Config loaded OK | mode=${config.mode} | project=${config.projectId.slice(0, 8)} | run=${config.runId.slice(0, 8)}`);
  } catch (configErr) {
    console.error("[AgentBoot] ✗ loadConfig() FAILED:", configErr);
    process.exit(1);
  }

  const logger = new Logger(config.runId, config.projectId);
  const eventEmitter = new EventEmitter(config);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });

  try {
    // 连接 Redis
    console.log(`[AgentBoot] Connecting to Redis: ${config.redisUrl.replace(/\/\/.*@/, "//***@")}`);
    const redisStart = Date.now();
    await redis.connect();
    console.log(`[AgentBoot] Redis connected | took=${Date.now() - redisStart}ms`);

    const emitterStart = Date.now();
    await eventEmitter.connect();
    console.log(`[AgentBoot] EventEmitter connected | took=${Date.now() - emitterStart}ms`);

    logger.info("Agent Runtime starting", {
      runId: config.runId,
      projectId: config.projectId,
      mode: config.mode,
      resume: config.resume,
    });

    // 发射 running 状态
    await eventEmitter.emitStatusChange("running");
    console.log("[AgentBoot] Status 'running' emitted");

    // 加载 Skills
    const skillManager = new SkillManager(redis, logger, config);
    console.log("[AgentBoot] Loading skills...");
    await skillManager.loadSkills();
    console.log("[AgentBoot] Skills loaded");

    // 获取用户消息（从后端 API 或环境变量）
    const userMessage = process.env.USER_MESSAGE || "请根据项目需求继续工作";
    console.log(`[AgentBoot] User message (first 100): ${userMessage.slice(0, 100)}`);

    // 模式选择
    const client = createLLMClient(config);
    const model = getModel(config);
    console.log(`[AgentBoot] LLM client created | model=${model} | baseUrl=${config.llmBaseUrl}`);
    console.log("[AgentBoot] Selecting mode via LLM...");
    const modeStart = Date.now();
    const modeAnalysis = await selectMode(client, model, userMessage, config);
    console.log(`[AgentBoot] Mode selected: ${modeAnalysis.mode} | reason=${modeAnalysis.reason} | took=${Date.now() - modeStart}ms`);
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
        console.log(`[AgentBoot] Conversation cache loaded | messages=${existingMessages.length}`);
      } else {
        console.log("[AgentBoot] No conversation cache found (iterate mode)");
      }
    }

    // 运行 Agent Loop
    console.log(`[AgentBoot] Starting Agent Loop | maxSteps=${config.maxSteps}`);
    const loopStart = Date.now();
    const result = await agentLoop({
      config,
      systemPrompt,
      userMessage,
      existingMessages,
      eventEmitter,
      logger,
      redis,
    });

    const loopElapsed = Math.round((Date.now() - loopStart) / 1000);
    console.log(`[AgentBoot] Agent Loop finished | success=${result.success} | steps=${result.steps} | elapsed=${loopElapsed}s`);
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
    console.log("[AgentBoot] Conversation cached to Redis");

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
    const stack = error instanceof Error ? error.stack : "";
    console.error(`[AgentBoot] ✗ FATAL ERROR: ${msg}`);
    if (stack) console.error(`[AgentBoot] Stack: ${stack}`);
    logger.error("Agent Runtime fatal error", { error: msg, stack });

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
  console.error("[AgentBoot] ✗ Unhandled top-level error:");
  console.error(err);
  process.exit(1);
});
