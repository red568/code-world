/**
 * Agent Loop 集成测试脚本
 *
 * 用真实 DeepSeek V4 + 真实 E2B Sandbox 测试 Agent Loop。
 * Mock 掉 DB (prisma) 和 Redis (SSE 推送)。
 *
 * 运行: npx tsx scripts/test-agent-loop.ts
 *
 * 需要环境变量（放在 .env 文件中）：
 *   LLM_API_KEY=sk-xxx           # DeepSeek API Key
 *   LLM_BASE_URL=https://api.deepseek.com/v1
 *   LLM_MODEL=deepseek-chat      # 或 deepseek-v4-flash
 *   E2B_API_KEY=e2b_xxx          # E2B API Key
 */

import "dotenv/config";
import OpenAI from "openai";
import { Sandbox } from "@e2b/code-interpreter";

// ─── 配置 ────────────────────────────────────────────────────────────────────────

const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";
const E2B_TEMPLATE = process.env.E2B_TEMPLATE_ID || "vite-react-tailwind";

const MAX_STEPS = 40;
const PROJECT_DIR = "/home/user/app";

// ─── 工具定义 ────────────────────────────────────────────────────────────────────

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "创建或覆盖一个项目文件。用于生成组件、页面、样式、配置等。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对路径，如 src/components/Hero.tsx" },
          content: { type: "string", description: "文件的完整内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取项目中一个文件的内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出项目 src/ 目录下所有源码文件。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "在项目目录执行 shell 命令（如 npm run build、npx tsc --noEmit）。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "shell 命令" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_preview_url",
      description: "获取 dev server 的公网预览 URL。",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "端口号，默认 5173" },
        },
      },
    },
  },
];

// ─── System Prompt（精简版，和项目里的 prompt.ts 一致）─────────────────────────────

const SYSTEM_PROMPT = `你是一个高级全栈网站开发 Agent。用户描述想要的网站，你通过工具自主完成开发。

## 你的工具
- write_file(path, content): 创建或覆盖文件
- read_file(path): 读取文件内容
- list_files(): 列出 src/ 下所有文件
- run_shell(command): 执行 shell 命令
- get_preview_url(port): 获取预览 URL

## 技术栈（固定）
- React 18 + TypeScript + Vite + Tailwind CSS
- 白名单依赖：react, react-dom, lucide-react, framer-motion, recharts
- 不允许使用其他第三方包

## 工作方式
1. 分析需求，简要说明计划
2. 按依赖顺序写 src/ 下的文件（叶子组件先，App.tsx 最后）
3. 每写 3 个文件跑一次 run_shell("npx tsc --noEmit")
4. 全部写完 run_shell("npm run build")
5. 失败就 read_file 看错误文件，修复后重新 build
6. 成功后启动 dev server: run_shell("nohup npx vite > /dev/null 2>&1 & sleep 3 && curl -s -o /dev/null -w '%{http_code}' http://localhost:5173")
7. 确认返回 200 后 get_preview_url(5173)
8. 获取到预览 URL 后，任务完成，不再调用任何工具

## 重要提示
- run_shell 有 120 秒超时，长驻进程（如 npm run dev）必须用 nohup + & 后台运行，否则会超时被杀
- 以下文件已预置在项目中，不要覆盖或重新创建：index.html、vite.config.ts、tsconfig.json、tailwind.config.js、postcss.config.js、package.json
- vite.config.ts 已配置 server.allowedHosts: true，无需修改
- 依赖已预装（node_modules 已存在），无需 npm install

## 规则
- 单文件不超过 250 行
- 所有组件 default export
- import 用相对路径
- TypeScript strict 模式，不用 any
- 内容丰富真实，不用 Lorem ipsum
- src/main.tsx 已存在不要修改
- 只需要写 src/ 下的组件文件和 App.tsx`;

// ─── 工具执行器 ──────────────────────────────────────────────────────────────────

async function executeTool(
  sandbox: Sandbox,
  name: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; output: string }> {
  switch (name) {
    case "write_file": {
      const path = args.path as string;
      const content = args.content as string;
      const fullPath = `${PROJECT_DIR}/${path}`;
      const dir = fullPath.split("/").slice(0, -1).join("/");
      await sandbox.commands.run(`mkdir -p ${dir}`);
      await sandbox.files.write(fullPath, content);
      const lines = content.split("\n").length;
      return { success: true, output: `Written ${path} (${lines} lines)` };
    }

    case "read_file": {
      const path = args.path as string;
      try {
        const content = await sandbox.files.read(`${PROJECT_DIR}/${path}`);
        return { success: true, output: content };
      } catch {
        return { success: false, output: `File not found: ${path}` };
      }
    }

    case "list_files": {
      const result = await sandbox.commands.run(
        `find ${PROJECT_DIR}/src -type f \\( -name "*.tsx" -o -name "*.ts" -o -name "*.css" \\) | sort | sed 's|${PROJECT_DIR}/||'`
      );
      return { success: true, output: result.stdout || "No files found." };
    }

    case "run_shell": {
      const command = args.command as string;
      try {
        const result = await sandbox.commands.run(command, {
          cwd: PROJECT_DIR,
          timeoutMs: 120_000,
        });
        const parts: string[] = [];
        if (result.stdout) parts.push(`stdout:\n${result.stdout.slice(-3000)}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr.slice(-3000)}`);
        parts.push(`exit_code: ${result.exitCode}`);
        return { success: result.exitCode === 0, output: parts.join("\n\n") };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, output: `Command failed: ${msg}` };
      }
    }

    case "get_preview_url": {
      const port = (args.port as number) || 5173;
      const host = sandbox.getHost(port);
      return { success: true, output: `https://${host}` };
    }

    default:
      return { success: false, output: `Unknown tool: ${name}` };
  }
}

// ─── 沙箱生命周期 ────────────────────────────────────────────────────────────────

function printSandboxInfo(sandbox: Sandbox, previewUrl: string | null): void {
  console.log(`\n💡 沙箱不会被销毁，将在 TTL 到期后自动过期（约 15 分钟）。`);
  console.log(`   Sandbox ID: ${sandbox.sandboxId}`);
  if (previewUrl) console.log(`   Preview: ${previewUrl}`);
  console.log("");
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────────

async function runAgentLoop(userPrompt: string) {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Agent Loop 测试`);
  console.log(`  Model: ${LLM_MODEL}`);
  console.log(`  Prompt: "${userPrompt.slice(0, 60)}"`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // 检查环境变量
  if (!LLM_API_KEY) {
    console.error("❌ 缺少 LLM_API_KEY 环境变量");
    process.exit(1);
  }
  if (!process.env.E2B_API_KEY) {
    console.error("❌ 缺少 E2B_API_KEY 环境变量");
    process.exit(1);
  }

  // 1. 创建 E2B Sandbox（secure: false 让预览 URL 无需 token 即可公开访问）
  console.log("📦 创建 E2B Sandbox...");
  const sandboxStart = Date.now();
  const sandbox = await Sandbox.create(E2B_TEMPLATE, {
    timeoutMs: 15 * 60 * 1000,
    secure: false,
  });
  console.log(`   ✓ Sandbox 就绪 | id=${sandbox.sandboxId} | ${((Date.now() - sandboxStart) / 1000).toFixed(1)}s\n`);

  // 2. 初始化 LLM 客户端
  const client = new OpenAI({
    apiKey: LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  // 4. Agent Loop
  console.log("🤖 开始 Agent Loop\n");
  const loopStart = Date.now();
  let previewUrl: string | null = null;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const stepStart = Date.now();
    console.log(`── Step ${step} ──────────────────────────────────────────`);

    // 调用 LLM
    const response = await client.chat.completions.create({
      model: LLM_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 8192,
    });

    const choice = response.choices[0];
    const msg = choice.message;

    // 显示思考内容
    if (msg.content) {
      console.log(`💭 ${msg.content.slice(0, 200)}${msg.content.length > 200 ? "..." : ""}`);
    }

    messages.push(msg);

    // 无 tool_calls → 隐式结束
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const totalTime = ((Date.now() - loopStart) / 1000).toFixed(1);
      const success = !!previewUrl;
      console.log(`\n${"═".repeat(65)}`);
      console.log(`  ${success ? "✅ 成功" : "⚠️ 结束"} | Agent 无 tool_call，隐式完成`);
      console.log(`  Steps: ${step} | Time: ${totalTime}s`);
      if (previewUrl) console.log(`  Preview: ${previewUrl}`);
      console.log(`${"═".repeat(65)}`);
      printSandboxInfo(sandbox, previewUrl);
      return;
    }

    // 执行 tool_calls
    for (const toolCall of msg.tool_calls) {
      if (toolCall.type !== "function") continue;

      const fnName = toolCall.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        console.log(`   ⚠️  ${fnName}: JSON parse error`);
        messages.push({
          role: "tool",
          content: "Error: Invalid JSON arguments",
          tool_call_id: toolCall.id,
        });
        continue;
      }

      // 日志：显示工具调用
      if (fnName === "write_file") {
        const lines = ((args.content as string) || "").split("\n").length;
        console.log(`   🔧 ${fnName}("${args.path}", ${lines} lines)`);
      } else if (fnName === "run_shell") {
        console.log(`   🔧 ${fnName}("${args.command}")`);
      } else if (fnName === "read_file") {
        console.log(`   🔧 ${fnName}("${args.path}")`);
      } else {
        console.log(`   🔧 ${fnName}(${JSON.stringify(args)})`);
      }

      // 执行工具
      const result = await executeTool(sandbox, fnName, args);

      // 显示结果摘要
      const icon = result.success ? "✓" : "✗";
      const summary = result.output.slice(0, 150).replace(/\n/g, " ");
      console.log(`      ${icon} ${summary}${result.output.length > 150 ? "..." : ""}`);

      // 追踪 preview URL
      if (fnName === "get_preview_url" && result.success) {
        previewUrl = result.output;
      }

      // 追加结果到 messages
      const truncated =
        result.output.length > 4000
          ? result.output.slice(0, 4000) + `\n...(truncated, ${result.output.length} chars)`
          : result.output;

      messages.push({
        role: "tool",
        content: truncated,
        tool_call_id: toolCall.id,
      });
    }

    const stepTime = ((Date.now() - stepStart) / 1000).toFixed(1);
    console.log(`   ⏱️  ${stepTime}s\n`);
  }

  // 超过 maxSteps
  const totalTime = ((Date.now() - loopStart) / 1000).toFixed(1);
  console.log(`\n⚠️  达到最大步数 ${MAX_STEPS} | Time: ${totalTime}s`);
  if (previewUrl) console.log(`Preview: ${previewUrl}`);

  printSandboxInfo(sandbox, previewUrl);
}

// ─── 入口 ────────────────────────────────────────────────────────────────────────

const userPrompt =
  process.argv[2] ||
  "做一个个人技术博客首页，包含顶部导航、一个 hero 区域展示博主信息、最近文章列表（至少3篇带标题摘要和日期的文章卡片）、底部 footer。风格现代简洁。";

runAgentLoop(userPrompt).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
