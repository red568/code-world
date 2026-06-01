/**
 * Agent 工具定义 + 执行器
 *
 * 6 个工具覆盖 Agent 与 E2B Sandbox 环境的所有交互方式。
 * 工具只做 I/O，不做智能决策。
 */

import type { Sandbox } from "@e2b/code-interpreter";
import { prisma } from "@/lib/prisma";

// ─── Tool Schema（传递给 LLM 的工具描述）────────────────────────────────────────

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
            description:
              "相对于项目根目录的路径，如 src/components/Hero.tsx",
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
        "获取 dev server 的公网预览 URL。在启动 dev server（npm run dev -- --host 0.0.0.0 --port 5173）之后调用。",
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
            description: "任务是否成功完成（true: 成功, false: 失败或部分完成）",
          },
        },
        required: ["summary", "success"],
      },
    },
  },
] as const;

// ─── Executor 上下文 ─────────────────────────────────────────────────────────

export interface ToolContext {
  sandbox: Sandbox;
  projectId: string;
  projectDir: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  suspend?: boolean;
}

// ─── 统一执行入口 ────────────────────────────────────────────────────────────────

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
      return { success: true, output: "", suspend: true };
    case "finish":
      return executeFinish(args as { summary: string; success: boolean });
    default:
      return { success: false, output: `Unknown tool: ${name}` };
  }
}

// ─── 各工具实现 ──────────────────────────────────────────────────────────────────

async function executeWriteFile(
  args: { path: string; content: string },
  ctx: ToolContext
): Promise<ToolResult> {
  const fullPath = `${ctx.projectDir}/${args.path}`;
  const dir = fullPath.split("/").slice(0, -1).join("/");

  try {
    await ctx.sandbox.commands.run(`mkdir -p ${dir}`);
    await ctx.sandbox.files.write(fullPath, args.content);

    await prisma.projectFile.upsert({
      where: {
        projectId_path: { projectId: ctx.projectId, path: args.path },
      },
      create: {
        projectId: ctx.projectId,
        path: args.path,
        content: args.content,
      },
      update: { content: args.content, version: { increment: 1 } },
    });

    const lines = args.content.split("\n").length;
    let output = `Written ${args.path}`;

    // 只在明显过长时才提示
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
    const content = await ctx.sandbox.files.read(
      `${ctx.projectDir}/${args.path}`
    );
    return { success: true, output: content };
  } catch {
    return { success: false, output: `File not found: ${args.path}` };
  }
}

async function executeListFiles(ctx: ToolContext): Promise<ToolResult> {
  try {
    const result = await ctx.sandbox.commands.run(
      `find ${ctx.projectDir}/src -type f \\( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \\) | sort | sed 's|${ctx.projectDir}/||'`
    );
    const output = result.stdout?.trim() || "No source files found.";
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to list files: ${msg}` };
  }
}

const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){:|:&};:",
];

async function executeRunShell(
  args: { command: string },
  ctx: ToolContext
): Promise<ToolResult> {
  if (BLOCKED_COMMANDS.some((b) => args.command.includes(b))) {
    return { success: false, output: "Command blocked for security reasons." };
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  try {
    const result = await ctx.sandbox.commands.run(args.command, {
      cwd: ctx.projectDir,
      timeoutMs: 120_000,
      onStdout: (data: string) => { stdoutChunks.push(data); },
      onStderr: (data: string) => { stderrChunks.push(data); },
    });

    const parts: string[] = [];
    if (result.stdout) parts.push(`stdout:\n${result.stdout.slice(-3000)}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr.slice(-3000)}`);
    parts.push(`exit_code: ${result.exitCode}`);

    return { success: result.exitCode === 0, output: parts.join("\n\n") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = stderrChunks.join("");

    const exitCodeMatch = message.match(/exit status (\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 1;

    const stdout = stdoutChunks.join("");
    const parts: string[] = [];
    if (stdout) parts.push(`stdout:\n${stdout.slice(-3000)}`);
    if (stderr) parts.push(`stderr:\n${stderr.slice(-3000)}`);
    else parts.push(`error: ${message}`);
    parts.push(`exit_code: ${exitCode}`);

    return { success: false, output: parts.join("\n\n") };
  }
}

async function executeGetPreviewUrl(
  args: { port?: number },
  ctx: ToolContext
): Promise<ToolResult> {
  const port = args.port || 5173;

  try {
    const host = ctx.sandbox.getHost(port);
    const url = `https://${host}`;

    await prisma.project.update({
      where: { id: ctx.projectId },
      data: { previewUrl: url, sandboxId: ctx.sandbox.sandboxId },
    });

    await prisma.sandboxSession.upsert({
      where: { projectId: ctx.projectId },
      create: {
        projectId: ctx.projectId,
        sandboxId: ctx.sandbox.sandboxId,
        status: "running",
        previewUrl: url,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
      update: {
        sandboxId: ctx.sandbox.sandboxId,
        status: "running",
        previewUrl: url,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    return { success: true, output: url };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to get preview URL: ${msg}` };
  }
}

async function executeFinish(
  args: { summary: string; success: boolean }
): Promise<ToolResult> {
  return {
    success: args.success,
    output: args.summary,
  };
}
