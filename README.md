# AI Website Builder

AI 驱动的网站生成平台。用户通过自然语言描述需求，系统自动生成代码，在云端沙盒中构建运行，返回可公开访问的预览地址。支持多轮对话、需求澄清、代码迭代修改。

## 核心特性

- 🤖 **智能 Agent Loop**：ReAct 模式，自主规划、编码、构建、修复
- 💬 **多轮对话**：支持需求澄清、问题解答、迭代修改
- 🔄 **沙盒复用**：热更新模式，修改代码无需重新构建
- 📊 **实时反馈**：SSE 推送构建日志、Agent 思考过程
- 🎯 **意图分析**：自动识别模糊需求，生成澄清选项
- 🛠️ **自动修复**：构建失败时自动分析错误并修复（最多 5 次）

## 技术栈

- **主应用**: Next.js 16 + React 19 + TypeScript + Tailwind CSS 4
- **后端**: Node.js / TypeScript
- **数据库**: Railway PostgreSQL + Prisma 7
- **队列**: Railway Redis + BullMQ
- **沙盒**: E2B Sandbox（预构建 Template，预装依赖）
- **LLM**: 默认 DeepSeek V4 Flash，可切换 OpenAI / Anthropic / Kimi
- **部署**: Railway（Web + Worker + PostgreSQL + Redis 统一托管）

## 项目架构

### 目录结构

```
src/
├── app/                  # Next.js 页面和 API 路由
│   ├── page.tsx          # 主页面（聊天 + 状态 + 预览三栏布局）
│   └── api/
│       └── projects/     # REST API 端点
│           ├── [id]/generate/route.ts    # 生成新网站
│           ├── [id]/iterate/route.ts     # 迭代修改
│           ├── [id]/answer/route.ts      # 回答 ask_user 问题
│           ├── [id]/stop/route.ts        # 停止任务
│           └── [id]/stream/route.ts      # SSE 事件流
├── components/           # React 组件
│   ├── chat-panel.tsx    # 左栏：聊天输入
│   ├── status-panel.tsx  # 中栏：实时状态 / 构建日志
│   └── preview-panel.tsx # 右栏：iframe 预览
├── hooks/
│   └── use-project-stream.ts  # SSE 事件消费
├── lib/
│   ├── agent/            # Agent 核心逻辑
│   │   ├── loop.ts       # ReAct 循环引擎
│   │   ├── tools.ts      # 工具定义和执行器（write_file, run_shell, finish 等）
│   │   ├── prompt.ts     # System Prompt
│   │   ├── intent.ts     # 意图分析（需求澄清）
│   │   └── conversation.ts  # 对话管理（摘要生成、token 压缩）
│   ├── llm/              # LLM 服务（多 Provider 支持）
│   ├── sandbox/          # E2B Sandbox 操作封装
│   ├── streaming/        # SSE 事件定义和 Redis pub/sub
│   ├── queue/            # BullMQ 队列 + 编排器
│   │   ├── orchestrator.ts  # 任务编排（generate / iterate / resume）
│   │   ├── run-fencing.ts   # Run 状态管理（防止并发冲突）
│   │   └── lock.ts          # 分布式锁
│   └── template/         # 固定项目模板文件（React + Vite + Tailwind）
├── worker.ts             # BullMQ Worker 入口（独立进程）
└── generated/prisma/     # Prisma 生成的客户端（gitignore）

e2b-template/             # E2B 预构建 Template（预装依赖，跳过 npm install）
prisma/schema.prisma      # 数据模型定义
```

### Agent Loop 工作流程

```
用户输入
    ↓
意图分析（intent.ts）
    ├─ 需求清晰 → 直接执行
    └─ 需求模糊 → 生成澄清选项 → 用户选择 → 继续
    ↓
入队（BullMQ）
    ↓
Worker 消费任务
    ↓
Orchestrator 编排
    ├─ generate: 创建新网站
    │   ├─ 创建 E2B Sandbox
    │   ├─ 写入模板文件
    │   └─ 启动 Agent Loop
    └─ iterate: 修改现有网站
        ├─ 复用 Sandbox（如果未过期）
        └─ 启动 Agent Loop
    ↓
Agent Loop（loop.ts）
    ├─ LLM 思考 → 选择工具
    ├─ 执行工具（write_file, run_shell, get_preview_url 等）
    ├─ 观察结果 → 继续思考
    ├─ 支持多轮对话（无工具调用时继续循环）
    ├─ ask_user: 向用户提问 → 挂起 loop → 等待回答 → 恢复
    └─ finish: 任务完成 → 终止 loop
    ↓
构建成功
    ├─ 启动 dev server
    ├─ 获取预览 URL
    └─ 推送给前端
```

### 关键设计

#### 1. Agent Loop 终止条件

- **旧版**：无工具调用 → 立即终止（无法多轮对话）
- **新版**：只有调用 `finish` 工具才终止，支持自由对话

#### 2. 沙盒复用策略

- **首次生成**：创建新 Sandbox，完整构建
- **迭代修改**：
  - Sandbox 未过期（10 分钟内）→ 复用，热更新
  - Sandbox 已过期 → 创建新 Sandbox，恢复文件

#### 3. 对话管理

- **短期对话**：完整 messages 数组（token < 80k）
- **长期对话**：生成摘要，压缩历史
- **Sandbox 过期**：用摘要替代完整对话历史

#### 4. Run Fencing（防并发冲突）

- 每个 Run 有唯一 ID
- 通过 `assertRunWritable` 检查点防止重复执行
- 用户取消时，Run 状态变为 `cancelled`，所有检查点拦截

## Agent 工具集

Agent 通过以下工具与 E2B Sandbox 交互：

| 工具 | 功能 | 使用场景 |
|------|------|---------|
| `write_file(path, content)` | 创建或覆盖文件 | 生成组件、页面、样式 |
| `read_file(path)` | 读取文件内容 | 查看现有代码、诊断错误 |
| `list_files()` | 列出 src/ 下所有源码文件 | 了解项目结构 |
| `run_shell(command)` | 执行 shell 命令 | 构建（npm run build）、类型检查（tsc --noEmit） |
| `get_preview_url(port)` | 获取公网预览地址 | 启动 dev server 后获取 URL |
| `ask_user(question, options)` | 向用户提问 | 需求不明确时澄清（最多 3 次） |
| `finish(summary, success)` | 结束任务 | 任务完成时显式终止 loop |

### 工具使用示例

```typescript
// 1. 写入文件
write_file({
  path: "src/components/Header.tsx",
  content: "export default function Header() { ... }"
})

// 2. 构建项目
run_shell({ command: "npm run build" })

// 3. 启动 dev server 并获取预览
run_shell({ 
  command: "nohup npx vite --host 0.0.0.0 --port 5173 > /dev/null 2>&1 &" 
})
get_preview_url({ port: 5173 })

// 4. 任务完成
finish({ 
  summary: "网站已成功构建并部署", 
  success: true 
})
```

## 生成的网站技术栈（固定）

Agent 生成的网站使用以下技术栈，**不可更改**：

- **框架**: React 18 + TypeScript + Vite
- **样式**: Tailwind CSS
- **白名单依赖**（已预装，可直接 import）：
  - `react`, `react-dom`
  - `lucide-react`（图标）
  - `framer-motion`（动画）
  - `recharts`（图表）

**约束**：不允许使用白名单外的任何第三方包。如需某功能，用原生 React + Tailwind 实现。

## 本地开发

本地开发时连接 Railway 上的 PostgreSQL 和 Redis，无需在本地安装数据库。

### 前置依赖

- Node.js 20+
- Railway 账号（PostgreSQL 和 Redis 在 Railway 上运行）
- E2B 账号和 API Key
- DeepSeek API Key（或其他支持的 LLM Provider）

### 1. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入 Railway 提供的数据库和 Redis 连接地址：

```bash
# Railway PostgreSQL（从 Railway 控制台获取）
DATABASE_URL="postgresql://postgres:xxx@xxx.railway.app:5432/railway"

# Railway Redis（从 Railway 控制台获取）
REDIS_URL="redis://default:xxx@xxx.railway.app:6379"

# API Keys
E2B_API_KEY="your-e2b-api-key"
LLM_API_KEY="your-deepseek-api-key"

# LLM 配置（可选，默认使用 DeepSeek V4 Flash）
LLM_PROVIDER="deepseek"
LLM_BASE_URL="https://api.deepseek.com/v1"
LLM_MODEL="deepseek-v4-flash"
```

### 2. 初始化数据库

```bash
npm install
npm run db:push
```

### 3. 启动服务

需要两个终端窗口：

```bash
# 终端 1：Next.js 主站 + API
npm run dev

# 终端 2：后台 Worker（消费任务队列）
npm run worker
```

打开 http://localhost:3000 即可使用。

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 Next.js 开发服务器（端口 3000） |
| `npm run worker` | 启动 BullMQ Worker（消费任务队列） |
| `npm run build` | 生产构建 |
| `npm run start` | 启动生产服务器 |
| `npm run db:push` | 同步数据库 Schema（无需 migration） |
| `npm run db:migrate` | 创建并运行数据库 migration |
| `npm run db:generate` | 重新生成 Prisma Client |

### 开发调试

- **查看队列状态**：Worker 启动后会在 http://localhost:3001/admin 提供 Bull Board 管理界面
- **查看 SSE 事件**：浏览器开发者工具 → Network → EventStream
- **查看 Agent 日志**：Worker 终端会输出详细的 Agent Loop 执行日志

## 切换 LLM 模型

修改 `.env` 中的配置即可切换模型：

```bash
# DeepSeek（默认）
LLM_PROVIDER="deepseek"
LLM_API_KEY="your-deepseek-api-key"
LLM_BASE_URL="https://api.deepseek.com/v1"
LLM_MODEL="deepseek-v4-flash"

# OpenAI
LLM_PROVIDER="openai"
LLM_API_KEY="sk-..."
LLM_BASE_URL="https://api.openai.com/v1"
LLM_MODEL="gpt-4o"

# Anthropic Claude
LLM_PROVIDER="anthropic"
LLM_API_KEY="sk-ant-..."
LLM_BASE_URL="https://api.anthropic.com/v1"
LLM_MODEL="claude-3-5-sonnet-20241022"

# Kimi (Moonshot)
LLM_PROVIDER="kimi"
LLM_API_KEY="your-kimi-api-key"
LLM_BASE_URL="https://api.moonshot.cn/v1"
LLM_MODEL="moonshot-v1-8k"
```

## Railway 部署

本项目设计为在 Railway 上部署。

### 部署架构

```
Railway Project
├── web        Next.js 主站 / API / SSE 端点
├── worker     BullMQ Worker（长驻进程，消费任务队列）
├── postgres   Railway PostgreSQL
└── redis      Railway Redis
```

### 部署步骤

1. 在 Railway 创建新 Project
2. 添加 PostgreSQL 和 Redis 服务
3. 添加 Web 服务（关联 GitHub 仓库）
   - 构建命令: `npm run build`
   - 启动命令: `npm run start`
4. 添加 Worker 服务（同一仓库）
   - 构建命令: `npm install`
   - 启动命令: `npm run worker`
5. 配置环境变量（DATABASE_URL、REDIS_URL、E2B_API_KEY、LLM_API_KEY 等）
6. 运行数据库迁移: `npm run db:push`

### 选择 Railway 的原因

- 可同时运行 Web + Worker + PostgreSQL + Redis，四个服务在一个 Project 内
- Worker 进程无执行时间限制，适合 Agent 长任务（30-120 秒）
- 服务之间走私有网络，延迟低
- 支持 GitHub 自动部署
- 比自建 Kubernetes 简单得多

## E2B Template

`e2b-template/` 目录包含预构建的 Sandbox Template，预装了所有白名单依赖。详见 [e2b-template/README.md](e2b-template/README.md)。

## 数据模型

主要数据表：

- **Project**: 项目基本信息（名称、状态、预览 URL、沙盒 ID）
- **ProjectRun**: 任务执行记录（类型、状态、提示词）
- **ProjectFile**: 项目文件（路径、内容、版本）
- **Conversation**: 对话历史（messages 数组、摘要）
- **LoopState**: Agent Loop 挂起状态（用于 ask_user 恢复）
- **SandboxSession**: 沙盒会话（状态、过期时间）
- **BuildLog**: 构建日志（命令、输出、退出码）

## 常见问题

### Q: Agent 生成的网站可以使用哪些依赖？

A: 只能使用白名单依赖：`react`, `react-dom`, `lucide-react`, `framer-motion`, `recharts`。不允许使用其他第三方包。

### Q: 如何让 Agent 停止执行？

A: 点击前端的"停止"按钮，会调用 `/api/projects/[id]/stop` 接口，将 Run 状态设为 `cancelled`。Agent Loop 的检查点会拦截后续执行。

### Q: 沙盒会保留多久？

A: 沙盒会话默认保留 10 分钟。在此期间修改代码会复用沙盒（热更新），超时后会创建新沙盒。

### Q: Agent 为什么会多次调用 LLM？

A: 这是正常的 ReAct 循环：思考 → 执行工具 → 观察结果 → 继续思考。每轮都会调用 LLM。如果构建失败，还会触发自动修复（最多 5 次）。

### Q: 如何查看 Agent 的执行日志？

A: 启动 Worker 的终端会输出详细日志，包括每一步的工具调用、执行时间、结果。

### Q: 支持哪些 LLM 模型？

A: 支持所有兼容 OpenAI API 格式的模型：Kimi (Moonshot)、OpenAI GPT、DeepSeek、Anthropic Claude 等。

## 项目演进

### 最近更新

- ✅ **多轮对话支持**：引入 `finish` 工具，支持用户提问和需求澄清
- ✅ **意图分析**：自动识别模糊需求，生成澄清选项
- ✅ **沙盒复用**：热更新模式，修改代码无需重新构建
- ✅ **对话管理**：长对话自动压缩，生成摘要
- ✅ **Run Fencing**：防止并发冲突，支持任务取消
- ✅ **代码行数优化**：软化约束，减少不必要的重写

### 架构演进

- **v1**: 单次生成，无对话历史
- **v2**: 支持迭代修改，但每次都重建沙盒
- **v3**: 引入沙盒复用，支持热更新
- **v4**: 引入 Agent Loop，统一生成和迭代流程
- **v5**: 引入意图分析和多轮对话支持（当前版本）

## 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发分支

- `main`: 稳定版本
- `feature-*`: 功能开发分支

### 提交规范

- `feat`: 新功能
- `fix`: Bug 修复
- `refactor`: 重构
- `docs`: 文档更新
- `chore`: 构建/工具链更新

## License

MIT

## 相关文档

- [Agent Loop 优化记录](../AGENT_LOOP_CHANGES.md)
- [E2B Template 说明](e2b-template/README.md)
- [构建流程图](../BUILD_FLOW_DIAGRAM.txt)
- [代码路径说明](../CODE_PATHS.txt)
