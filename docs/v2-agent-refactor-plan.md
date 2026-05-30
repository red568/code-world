# Agent 架构重构方案：从 Workflow 到 Tool-Use Agent

## 1. 重构目标

将现有的线性 Workflow 管道（Spec → Plan → Codegen → Review → Build → Fix）改造为 Claude Code 风格的 Tool-Use Agent 架构。

核心转变：
- 从"Prompt→JSON"管道变为"Agent+Tools"自主决策循环
- LLM 从被动输出文本变为主动与环境交互
- 错误修复从"看日志猜"变为自主诊断（读文件、跑命令、验证假设）
- 上下文从手动拼装变为 Agent 按需获取

## 2. 现有架构问题

### 2.1 流程僵化

```
orchestrateGenerate:
  Spec(streaming) → Plan(JSON) → Codegen(逐文件,会话式) → Review(会话内) → Build → [Fix×5] → Preview
```

每个阶段硬编码串行执行，LLM 没有能力根据实际情况调整策略。

### 2.2 Fix 阶段是"瞎子"

Fix Prompt 只能看到你手动选择传入的文件和 stderr 日志，不能：
- 自己 read_file 确认假设
- 自己跑 tsc 验证修复是否有效
- 自己决定需要看哪些文件

### 2.3 上下文管理粗放

- Iterate 全量读所有文件传给 LLM，项目大了会超 token
- Codegen 会话里累积所有文件完整代码，context 快速膨胀
- Fix 阶段可能选错"相关文件"，导致修复失败

### 2.4 一次性输出的脆弱性

让 LLM 一次返回多个文件的完整 JSON，任何格式错误都导致整体失败。代码里有大量 fallback 正则提取逻辑来应对这个问题。

## 3. 目标架构

### 3.1 总体结构

```
用户输入
  ↓
Worker 启动 agentLoop(sandbox, prompt)
  ↓
┌────────────────────────────────────────────┐
│  Single Agent Loop                          │
│                                             │
│  messages = [system, user]                  │
│                                             │
│  while (step < 50 && !done) {               │
│    response = LLM(messages, tools)          │
│    execute tool_calls                        │
│    push results back to messages             │
│    publish SSE events                        │
│  }                                          │
└────────────────────────────────────────────┘
  ↓
预览就绪 / 失败
```

### 3.2 设计原则

参考 Claude Code 的核心设计哲学：

1. **工具是"手"，不是"脑"** — 工具只做 I/O 操作，所有思考在模型内部完成
2. **直接写代码** — Agent 通过 write_file 直接输出代码，没有间接层
3. **写完立刻验证** — 不是写完所有文件再 build，而是小步快跑频繁检查
4. **按需获取上下文** — 不预加载所有文件，需要看什么就 read 什么
5. **一个连续对话** — 从规划到写代码到修复都在同一个 messages 数组里

## 4. 工具集设计

6 个工具，覆盖 Agent 与环境交互的所有方式：

| 工具 | 职责 | 底层实现 |
|------|------|----------|
| write_file | 创建/覆盖项目文件 | sandbox.files.write + DB upsert |
| read_file | 读取文件内容 | sandbox.files.read |
| list_files | 列出项目文件结构 | sandbox find 命令 |
| run_shell | 执行任意 shell 命令 | sandbox.commands.run |
| get_preview_url | 获取公网预览地址 | sandbox.getHost()（SDK API） |
| done | 标记任务完成/失败 | 无底层操作，退出信号 |

### 4.1 设计决策

**为什么用 run_shell 而不是拆成 build / check_types / install 等独立工具：**

给 Agent 最大灵活性。它可以跑 `npm run build`、`npx tsc --noEmit`、`cat package.json`、`npm install framer-motion`、`grep -rn "import" src/`。不需要预判它会需要什么命令。

**为什么 get_preview_url 单独拆出来：**

获取 E2B 的公网 URL 需要调 SDK API（`sandbox.getHost()`），不是 shell 能做的。同时需要写 DB 记录。

**为什么工具不做智能：**

没有 `analyze_error`、没有 `generate_component`。工具只做 I/O，模型自己分析错误、自己决定生成策略。

### 4.2 工具 Schema

```typescript
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或覆盖一个项目文件。用于生成组件、页面、样式、配置等。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对于项目根目录的路径，如 src/components/Hero.tsx" },
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
      description: "读取项目中一个文件的内容。用于查看现有代码、诊断错误。",
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
      description: "列出项目 src/ 目录下所有文件路径。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "在项目目录执行 shell 命令。用于构建、类型检查、安装依赖等。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_preview_url",
      description: "获取 dev server 的公网预览 URL。在启动 dev server 后调用。",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "端口号，默认 5173" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "标记任务完成。预览就绪或确认无法继续时调用。",
      parameters: {
        type: "object",
        properties: {
          success: { type: "boolean", description: "是否成功完成" },
          summary: { type: "string", description: "完成摘要" },
        },
        required: ["success", "summary"],
      },
    },
  },
];
```

### 4.3 Tool Executor 关键逻辑

**write_file:**
- 先 `mkdir -p` 创建目录
- `sandbox.files.write()` 写入文件
- `prisma.projectFile.upsert()` 同步 DB
- 返回摘要（行数），不回显完整代码

**run_shell:**
- 安全检查（阻止 `rm -rf /`、`curl`、`wget` 等危险命令）
- 收集 stdout/stderr
- 返回格式化输出 + exit_code
- 输出截断到 4000 字符防止撑爆 context

**get_preview_url:**
- 调用 `sandbox.getHost(port)` 拿 URL
- 更新 Project 和 SandboxSession 记录
- 返回 URL 字符串

## 5. Agent Loop 引擎

### 5.1 核心流程

```
1. 初始化 messages = [system_prompt, user_message]
2. while (step < maxSteps):
   a. 调用 LLM(messages, tools, tool_choice="auto")
   b. 如果有 content → 推送 agent_thinking 事件
   c. 追加 assistant 消息到 messages
   d. 如果无 tool_calls → break（隐式结束）
   e. 对每个 tool_call:
      - 解析参数
      - 推送 tool_call 事件
      - 如果是 done → return 结果
      - 执行工具
      - 推送 tool_result 事件
      - 追加 tool result 到 messages
3. 返回结果
```

### 5.2 退出条件

三种退出方式：
- Agent 调用 `done` 工具 → 正常结束（推荐）
- Agent 返回纯文本无 tool_calls → 隐式结束
- 达到 maxSteps=50 → 兜底超时

### 5.3 Context 膨胀控制

这是单 Agent 架构最关键的技术问题。Agent 写 8 个文件，每个 200 行，messages 里会累积大量内容。

应对策略：
- **write_file 的 tool_result 只返回摘要**（"Written Hero.tsx, 45 lines"），不回显完整代码
- **run_shell 输出截断到 4000 字符**
- **模型需要回看代码时主动调 read_file** — 按需获取而非全量保留
- **后续优化**：如果 messages 总 token 接近上限，做中间摘要压缩（v1 暂不实现）

### 5.4 错误处理

- 单个 tool 执行失败 → 返回错误信息给 Agent，让它自己决定怎么处理
- LLM API 调用失败 → 重试 1 次，仍失败则 loop 异常退出
- tool_call arguments JSON 解析失败 → 返回 parse error 给 Agent
- sandbox 超时/崩溃 → loop 异常退出，orchestrator 层处理

## 6. System Prompt 设计

### 6.1 结构

```
1. 角色定义 — 你是网站开发 Agent
2. 工具说明 — 你有哪些工具、各自用途
3. 技术约束 — 固定技术栈、白名单依赖、TypeScript strict 规则
4. 工作方式引导 — 先规划再写、小步验证、基于真实错误修复
5. 代码质量要求 — 单文件行数、命名规范、内容真实、无 Lorem ipsum
6. 项目结构规则 — main.tsx 已存在、App.tsx 是入口、default export
7. 关键约束 — import 路径、props 一致性、白名单依赖检查
```

### 6.2 关键设计点

**工作方式是"引导"而非"强制"：**

告诉 Agent "建议先规划再写"、"每写 2-3 个文件跑一次 tsc 检查"，但不硬编码流程。Agent 可以根据实际情况调整策略（比如简单项目可以一口气写完再验证）。

**技术约束必须严格：**

白名单依赖、TypeScript strict、import 规则等是硬性约束，不给 Agent 灵活空间。这些直接影响构建成功率。

**从现有 prompt 合并精华：**

把 spec-prompt、plan-prompt、codegen-prompt、review-prompt、fix-prompt 里积累的所有有效约束（TypeScript strict 规则、export 风格、props 一致性要求等）合并到一个 system prompt 里。

## 7. Orchestrator 重写

### 7.1 职责缩减

现有 635 行 → 约 50 行。

新职责：
1. 创建 sandbox + 写入模板文件
2. 更新 project 状态为进行中
3. 启动 agentLoop
4. 根据结果更新 project 状态（成功/失败）
5. 异常时清理 sandbox

所有"该调哪个 prompt"、"该传哪些文件"、"该重试几次"的逻辑全部消失 — 这些决策交给 Agent。

### 7.2 Generate vs Iterate

用同一个 Agent、同一套工具、同一个 loop。区别只是 userMessage 不同：

- **Generate**: 用户原始需求描述
- **Iterate**: "用户要求修改：{prompt}。请先 list_files 和 read_file 了解当前项目状态，再进行修改。"

Agent 自己判断需要看哪些文件、改哪些文件。

## 8. SSE 事件适配

### 8.1 新增事件类型

| 事件 | 触发时机 | 前端展示 |
|------|----------|----------|
| agent_thinking | LLM 返回 content 文本 | 展示 Agent 的思考/规划 |
| tool_call | 即将执行工具 | 展示"正在写文件/执行命令" |
| tool_result | 工具执行完成 | 展示结果摘要（成功/失败） |

### 8.2 保留的旧事件

在 tool 执行时顺带推送，保持前端兼容：
- `preview_ready` — get_preview_url 成功时推送
- `codegen_file_done` — write_file 成功时推送
- `build_log` — run_shell 包含 build 命令时推送

### 8.3 前端改动

`use-project-stream.ts` 的 reducer 增加 3 个 case 处理新事件。现有 `activities` 数组天然适合展示 tool 调用轨迹。不需要重写 UI 组件。

前端展示效果示例：

```
🤔 分析需求：一个摄影工作室官网，需要 Hero、作品集、联系表单...
📋 规划：5 个文件 — Header, Hero, Gallery, Contact, App
📝 写入 src/components/Header.tsx (38 行)
📝 写入 src/components/Hero.tsx (52 行)
📝 写入 src/components/Gallery.tsx (67 行)
🔍 执行 npx tsc --noEmit → 通过
📝 写入 src/components/Contact.tsx (45 行)
📝 写入 src/App.tsx (42 行)
🔨 执行 npm run build → 失败 (1 error)
📖 读取 src/components/Gallery.tsx
📝 修复 src/components/Gallery.tsx (69 行)
🔨 执行 npm run build → 成功
🚀 启动 dev server
🌐 预览就绪 → https://xxx.e2b.dev
✅ 完成
```

## 9. 文件结构变化

### 9.1 新结构

```
src/lib/agent/
  ├── tools.ts          ← 工具 schema 定义 + executor
  ├── loop.ts           ← Agent Loop 引擎
  ├── prompt.ts         ← System Prompt
  ├── index.ts          ← 导出

src/lib/queue/
  ├── orchestrator.ts   ← 重写（~50 行）
  ├── queue.ts          ← 不变
  ├── index.ts          ← 不变
```

### 9.2 删除文件

```
src/lib/agent/
  ├── spec-prompt.ts       ← 删除
  ├── plan-prompt.ts       ← 删除
  ├── codegen-prompt.ts    ← 删除
  ├── review-prompt.ts     ← 删除
  ├── fix-prompt.ts        ← 删除
  ├── conversation.ts      ← 删除
```

### 9.3 修改文件

```
src/lib/llm/client.ts           ← 新增 chatWithTools 方法
src/hooks/use-project-stream.ts ← reducer 加 3 个 case
src/lib/streaming/events.ts     ← 新增事件类型定义
```

### 9.4 保留不动的文件

```
src/lib/sandbox/e2b.ts          ← executor 直接调用其函数
src/lib/streaming/publisher.ts  ← SSE 推送管道不变
src/lib/llm/providers.ts        ← provider 配置不变
src/lib/prisma.ts               ← DB 连接不变
src/lib/redis.ts                ← 不变
src/lib/queue/queue.ts          ← BullMQ 队列不变
src/worker.ts                   ← 调用新 orchestrator，接口不变
src/lib/template/               ← 模板文件不变
prisma/schema.prisma            ← 数据模型不变
前端所有组件                     ← 只改 reducer，不改 UI
```

## 10. LLM Client 扩展

现有 `client.ts` 只有 `chatCompletion` 和 `chatCompletionStream`。需要新增一个带 tools 参数的方法：

```typescript
export async function chatWithTools(
  messages: Message[],
  tools: ToolDefinition[],
  options?: LLMCallOptions
): Promise<{
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}>
```

或者直接在 loop.ts 里用 OpenAI SDK 原生调用（避免过度封装）。

## 11. 质量保障策略

### 11.1 代码生成质量

不靠架构花招，靠三件事：

1. **Prompt 质量** — 合并现有 4 个 prompt 里所有有效约束到一个 system prompt
2. **即时验证** — 引导 Agent 每写 2-3 个文件跑一次 `npx tsc --noEmit`
3. **真实反馈** — Agent 能看到真实错误、能自己 read_file 确认问题、能自己验证修复

### 11.2 与现有模式的对比

| 维度 | 现有 Workflow | Tool-Use Agent |
|------|-------------|----------------|
| 代码一致性 | 会话式 codegen 保证（好） | Agent 在同一对话里写所有文件（同等） |
| 错误修复 | 盲修（差） | 自主诊断（好） |
| Token 效率 | 全量传文件（差） | 按需 read_file（好） |
| 流程灵活性 | 固定（差） | 自适应（好） |
| 可预测性 | 高（好） | 中（需要兜底） |

### 11.3 兜底机制

- maxSteps=50 防止无限循环
- prompt 里写"如果连续 3 次 build 失败，简化实现而非继续修复"
- run_shell 命令黑名单防止危险操作
- tool_result 截断防止 context 溢出

## 12. 风险分析

| 风险 | 严重程度 | 应对策略 |
|------|----------|----------|
| 大文件被 tool_call 截断 | 高 | prompt 约束 300 行；executor 检测不完整代码时返回错误 |
| Agent 陷入修复死循环 | 中 | maxSteps 兜底；prompt 引导降级策略 |
| Context 膨胀导致后期质量下降 | 中 | tool_result 截断；write_file 不回显；按需 read_file |
| DeepSeek function calling 偶尔格式异常 | 低 | JSON parse 失败时返回错误让 Agent 重试 |
| 前端事件格式变化导致 UI 异常 | 低 | 保留旧事件兼容，新事件增量添加 |
| sandbox 5 分钟超时，复杂项目生成时间不够 | 中 | Agent 启动后定期 keepAlive；或增加超时到 10 分钟 |

## 13. 实施计划（一天）

| 时间 | 任务 | 产出 |
|------|------|------|
| 1h | Tool Schema 定义 + Executor 实现 | src/lib/agent/tools.ts |
| 2h | Agent Loop 引擎 | src/lib/agent/loop.ts |
| 1.5h | System Prompt 设计（合并现有所有约束） | src/lib/agent/prompt.ts |
| 1h | Orchestrator 重写 | src/lib/queue/orchestrator.ts |
| 0.5h | LLM client 扩展或 loop 内直接调用 | src/lib/llm/client.ts |
| 1h | 前端 reducer 适配 + 事件类型定义 | hooks + streaming |
| 1h | 端到端联调测试 + 修 bug | — |

## 14. 后续优化方向（不在一天范围内）

1. **Context 压缩** — messages 接近 token 上限时，对早期 tool_results 做摘要压缩
2. **Streaming tool calls** — DeepSeek 支持流式返回 tool_call，可以让前端更早看到 Agent 动作
3. **Sandbox 复用** — Iterate 时复用已有 sandbox 而非每次新建
4. **模型分层** — 简单文件用快模型，复杂逻辑用强模型
5. **并行 tool calls** — 多个无依赖的 write_file 并行执行
6. **评估系统** — 自动评估生成质量，反馈到 prompt 优化
