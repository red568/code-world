/**
 * Agent 工具定义 + 本地执行器
 *
 * 工具在沙盒内本地执行（fs + child_process），不依赖 E2B SDK。
 * ask_user 使用 Redis BRPOP 阻塞等待用户回答。
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import type { ToolContext, ToolResult, AskUserOption } from "./types.js";

const execAsync = promisify(exec);

// ─── Tool Schema（传递给 LLM）──────────────────────────────────────────────────

export const AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "创建或覆盖一个项目文件。用于生成组件、页面、样式、配置等。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "相对于项目根目录的路径，如 src/components/Hero.tsx",
          },
          content: {
            type: "string",
            description: "文件的完整内容",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "读取项目中一个文件的内容。用于查看现有代码或诊断构建错误。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径，如 src/App.tsx",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description:
        "列出项目 src/ 目录下所有源码文件路径（.tsx, .ts, .css）。",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_shell",
      description:
        "在项目目录执行 shell 命令。用于构建(npm run build)、类型检查(npx tsc --noEmit)、安装白名单依赖(npm install xxx)等。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的 shell 命令",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_preview_url",
      description:
        "获取 dev server 的公网预览 URL。在启动 dev server 之后调用。",
      parameters: {
        type: "object",
        properties: {
          port: {
            type: "number",
            description: "端口号，默认 5173",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_user",
      description:
        "暂停执行，向用户提出一个选择题。这是最后手段，不是默认行为。当你决定使用 ask_user 时，这一轮只调用 ask_user 一个工具，不要和其他工具一起调用。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "简洁明确的问题，一句话",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "选项名称，3-8字" },
                description: { type: "string", description: "选项含义说明" },
              },
              required: ["label", "description"],
            },
            description: "互斥的选项列表，2-4项",
          },
          context: {
            type: "string",
            description: "一句话解释为什么需要问这个问题",
          },
        },
        required: ["question", "options", "context"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finish",
      description:
        "任务已完成，结束 Agent Loop。当网站已成功构建并获取到预览 URL，或者任务已按用户要求完成时调用此工具。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "任务完成总结，简要说明完成了什么",
          },
          success: {
            type: "boolean",
            description: "任务是否成功完成",
          },
        },
        required: ["summary", "success"],
      },
    },
  },
] as const;

// ─── 安全限制 ────────────────────────────────────────────────────────────────

const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){:|:&};:",
];

// ─── 统一执行入口 ────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (name) {
    case "write_file":
      return executeWriteFile(args as { path: string; content: string }, ctx);
    case "read_file":
      return executeReadFile(args as { path: string }, ctx);
    case "list_files":
      return executeListFiles(ctx);
    case "run_shell":
      return executeRunShell(args as { command: string }, ctx);
    case "get_preview_url":
      return executeGetPreviewUrl(args as { port?: number }, ctx);
    case "ask_user":
      return executeAskUser(
        args as { question: string; options: AskUserOption[]; context: string },
        ctx
      );
    case "finish":
      return executeFinish(args as { summary: string; success: boolean });
    default:
      return { success: false, output: `Unknown tool: ${name}` };
  }
}

// ─── 工具实现 ────────────────────────────────────────────────────────────────

async function executeWriteFile(
  args: { path: string; content: string },
  ctx: ToolContext
): Promise<ToolResult> {
  const fullPath = join(ctx.projectDir, args.path);

  try {
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, args.content, "utf-8");

    const lines = args.content.split("\n").length;
    let output = `Written ${args.path}`;
    if (lines > 500) {
      output += ` (${lines} lines - 建议拆分为多个文件)`;
    }

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to write ${args.path}: ${msg}` };
  }
}

async function executeReadFile(
  args: { path: string },
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    const content = await readFile(join(ctx.projectDir, args.path), "utf-8");
    return { success: true, output: content };
  } catch {
    return { success: false, output: `File not found: ${args.path}` };
  }
}

async function executeListFiles(ctx: ToolContext): Promise<ToolResult> {
  try {
    const files = await listFilesRecursive(join(ctx.projectDir, "src"));
    const relative = files.map((f) => f.replace(ctx.projectDir + "/", ""));
    const output = relative.length > 0 ? relative.sort().join("\n") : "No source files found.";
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to list files: ${msg}` };
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        results.push(...(await listFilesRecursive(fullPath)));
      } else if (/\.(tsx?|css|json)$/.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // directory doesn't exist
  }
  return results;
}

async function executeRunShell(
  args: { command: string },
  ctx: ToolContext
): Promise<ToolResult> {
  if (BLOCKED_COMMANDS.some((b) => args.command.includes(b))) {
    return { success: false, output: "Command blocked for security reasons." };
  }

  // 兜底：启动 vite 前确保 allowedHosts: true
  if (args.command.includes("vite") && !args.command.includes("build")) {
    await ensureViteAllowedHosts(ctx.projectDir);
  }

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: ctx.projectDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parts: string[] = [];
    if (stdout) parts.push(`stdout:\n${stdout.slice(-3000)}`);
    if (stderr) parts.push(`stderr:\n${stderr.slice(-3000)}`);
    parts.push("exit_code: 0");

    return { success: true, output: parts.join("\n\n") };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    const parts: string[] = [];
    if (execError.stdout) parts.push(`stdout:\n${execError.stdout.slice(-3000)}`);
    if (execError.stderr) parts.push(`stderr:\n${execError.stderr.slice(-3000)}`);
    else if (execError.message) parts.push(`error: ${execError.message}`);
    parts.push(`exit_code: ${execError.code ?? 1}`);

    return { success: false, output: parts.join("\n\n") };
  }
}

async function executeGetPreviewUrl(
  args: { port?: number },
  ctx: ToolContext
): Promise<ToolResult> {
  const port = args.port || 5173;

  // 沙盒内通过环境变量获取公网 host
  const sandboxId = process.env.SANDBOX_ID;
  if (sandboxId) {
    const host = `${port}-${sandboxId}.e2b.dev`;
    const url = `https://${host}`;
    return { success: true, output: url };
  }

  // 本地开发：返回 localhost
  const url = `http://localhost:${port}`;
  return { success: true, output: url };
}

async function executeAskUser(
  args: { question: string; options: AskUserOption[]; context: string },
  ctx: ToolContext
): Promise<ToolResult> {
  // 检查提问次数限制
  if (ctx.askUserCount >= 3) {
    return {
      success: false,
      output: "系统限制：已达到最大提问次数（3 次），请自行判断",
    };
  }

  ctx.askUserCount++;
  const answerKey = `loop:${ctx.runId}:answer:${ctx.askUserCount}`;

  // 推送问题到前端
  await ctx.eventEmitter.emitHITLQuestion(
    args.question,
    args.options,
    ctx.askUserCount
  );

  // 通知后端：run 进入 paused 状态
  await callInternalAPI(ctx, "/api/internal/run/pause", {
    runId: ctx.runId,
    reason: "user_input",
    askCount: ctx.askUserCount,
  });

  ctx.logger.info("Waiting for user answer...", {
    question: args.question,
    askCount: ctx.askUserCount,
  });

  // Redis BRPOP 阻塞等待用户答案（30 分钟超时）
  const result = await ctx.redis.brpop(answerKey, 1800);

  if (!result) {
    // 超时
    await callInternalAPI(ctx, "/api/internal/run/finalize", {
      runId: ctx.runId,
      projectId: ctx.projectId,
      status: "paused",
      error: "User response timeout (30 minutes)",
    });

    return {
      success: false,
      output: "用户未在 30 分钟内回答，任务已暂停",
    };
  }

  const answer = result[1];
  ctx.logger.info("User answered", { answer, askCount: ctx.askUserCount });

  // 通知后端恢复
  await callInternalAPI(ctx, "/api/internal/run/resume", {
    runId: ctx.runId,
  });

  return { success: true, output: answer };
}

async function executeFinish(
  args: { summary: string; success: boolean }
): Promise<ToolResult> {
  return {
    success: args.success,
    output: args.summary,
  };
}

// ─── 内部 API 调用辅助 ──────────────────────────────────────────────────────

async function callInternalAPI(
  ctx: ToolContext,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const url = `${ctx.config.apiBaseUrl}${path}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": ctx.config.internalApiSecret,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn(`Internal API call failed: ${path}`, { status: response.status, body: text });
    }
    return response.json().catch(() => null);
  } catch (error) {
    ctx.logger.error(`Internal API call error: ${path}`, { error: String(error) });
    return null;
  }
}

export { callInternalAPI };

// ─── Vite allowedHosts 兜底 ────────────────────────────────────────────────

async function ensureViteAllowedHosts(projectDir: string): Promise<void> {
  const configPath = join(projectDir, "vite.config.ts");
  try {
    let content = await readFile(configPath, "utf-8");
    if (content.includes("allowedHosts")) return;

    // 注入 allowedHosts: true 到 server 配置块
    if (content.includes("server:") || content.includes("server :")) {
      content = content.replace(
        /(server\s*:\s*\{)/,
        "$1\n    allowedHosts: true,"
      );
    } else {
      // 没有 server 块，在 defineConfig 内追加
      content = content.replace(
        /(defineConfig\s*\(\s*\{)/,
        "$1\n  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },"
      );
    }
    await writeFile(configPath, content, "utf-8");
  } catch {
    // 文件不存在，写一个完整的
    const fallback = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
})
`;
    await writeFile(configPath, fallback, "utf-8");
  }
}
