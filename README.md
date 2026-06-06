# AI Website Builder

AI 驱动的网站生成平台。用户通过自然语言描述需求，系统自动生成代码，在云端沙盒中构建运行，返回可公开访问的预览地址。支持多轮对话、需求澄清、代码迭代修改、任务暂停/恢复。

## 核心特性

- 🤖 **智能 Agent Loop**：ReAct 模式，自主规划、编码、构建、修复
- 💬 **多轮对话**：支持需求澄清、问题解答、迭代修改
- 🔄 **沙盒复用**：热更新模式，修改代码无需重新构建
- 📊 **实时反馈**：SSE 推送构建日志、Agent 思考过程、执行时间线
- 🎯 **意图分析**：自动识别模糊需求，生成澄清选项
- 🛠️ **自动修复**：构建失败时自动分析错误并修复
- ⏸️ **暂停/恢复**：支持任务暂停、恢复和取消
- 🧩 **Skill 系统**：可扩展的工具注册（builtin / composite / MCP）

## 技术栈

- **主应用**: Next.js 16 + React 19 + TypeScript + Tailwind CSS 4
- **后端**: Node.js / TypeScript（Next.js API Routes + Express）
- **数据库**: Railway PostgreSQL + Prisma 7
- **队列**: Railway Redis + BullMQ
- **沙盒**: E2B Sandbox（支持 v7 新架构：Agent Loop 在沙盒内运行）
- **LLM**: 默认 DeepSeek V4 Flash，可切换 OpenAI / Anthropic / Kimi
- **部署**: Railway（Web + Worker + PostgreSQL + Redis 统一托管）

## 项目架构

### 目录结构

```
src/
├── app/                       # Next.js 页面和 API 路由
│   ├── page.tsx               # 首页（聊天输入 + 项目列表）
│   ├── layout.tsx             # 根布局
│   ├── project/[id]/page.tsx  # 项目工作区（聊天 + 时间线 + 预览三栏）
│   └── api/
│       ├── projects/          # 项目 REST API
│       │   ├── route.ts               # POST 创建 / GET 列表
│       │   ├── states/route.ts        # 批量查询项目状态
│       │   └── [id]/
│       │       ├── route.ts           # GET 详情 / DELETE 删除
│       │       ├── messages/route.ts  # 发送消息
│       │       ├── answer/route.ts    # 回答 ask_user 问题
│       │       ├── stop/route.ts      # 停止任务
│       │       ├── stream/route.ts    # SSE 事件流
│       │       ├── files/route.ts     # 查看生成的文件
│       │       └── logs/route.ts      # 查看构建日志
│       ├── stream/
│       │   └── user/route.ts          # 用户级 SSE（跨项目通知）
│       └── internal/                  # 沙盒 → 后端内部 API
│           ├── run/finalize/route.ts  # Agent 完成回调
│           ├── run/pause/route.ts     # 暂停执行
│           ├── run/resume/route.ts    # 恢复执行
│           ├── files/sync/route.ts    # 文件同步
│           ├── build-logs/route.ts    # 日志聚合
│           └── skills/route.ts        # Skill 注册
├── components/
│   ├── chat-panel.tsx            # 左栏：聊天输入 + 消息历史
│   ├── session-sidebar.tsx       # 中栏：项目状态 + 控制面板
│   ├── preview-panel.tsx         # 右栏：iframe 实时预览
│   ├── clarification-card.tsx    # 需求澄清 UI
│   ├── resize-handle.tsx         # 面板拖拽调整
│   └── timeline/                 # 执行时间线组件
│       ├── index.ts
│       ├── types.ts
│       ├── timeline-round.tsx    # 轮次容器
│       ├── timeline-step.tsx     # 步骤条目
│       ├── step-icon.tsx         # 步骤图标
│       └── elapsed-timer.tsx     # 执行计时器
├── hooks/
│   ├── use-project-stream.ts    # 项目级 SSE 消费
│   └── use-user-stream.ts       # 用户级 SSE 消费
├── lib/
│   ├── llm/                     # LLM 服务
│   │   ├── index.ts             # 统一入口
│   │   ├── client.ts            # OpenAI SDK 客户端
│   │   ├── providers.ts         # 多 Provider 配置
│   │   └── json-parse.ts        # JSON 修复工具
│   ├── queue/                   # BullMQ 队列
│   │   ├── index.ts
│   │   ├── queue.ts             # 队列定义和入队
│   │   └── lock.ts              # Redis 分布式锁
│   ├── streaming/               # SSE 事件系统
│   │   ├── index.ts
│   │   ├── events.ts            # 事件类型定义
│   │   └── publisher.ts         # Redis pub/sub 发布
│   ├── template/                # 固定项目模板
│   │   ├── index.ts
│   │   └── files.ts             # 模板文件内容
│   ├── dispatcher.ts            # 轻量调度器
│   ├── sandbox-session.ts       # 沙盒会话管理
│   ├── prisma.ts                # Prisma 客户端
│   └── redis.ts                 # Redis 客户端
├── worker.ts                    # BullMQ Worker 进程
└── generated/prisma/            # Prisma 生成的客户端（gitignore）

prisma/schema.prisma             # 数据模型定义
```

### Agent Loop 工作流程

```
用户输入（首页 / 项目页）
    ↓
意图分析
    ├─ 需求清晰 → 直接执行
    └─ 需求模糊 → 生成澄清选项（ClarificationCard）→ 用户选择 → 继续
    ↓
入队（BullMQ）
    ↓
Worker 消费任务
    ↓
Dispatcher 调度
    ├─ generate: 创建新网站
    │   ├─ 创建 E2B Sandbox
    │   ├─ 写入模板文件
    │   └─ 启动 Agent Loop
    └─ iterate: 修改现有网站
        ├─ 复用 Sandbox（如果未过期）
        └─ 启动 Agent Loop
    ↓
Agent Loop
    ├─ LLM 思考 → 选择工具
    ├─ 执行工具（write_file, run_shell, get_preview_url 等）
    ├─ 观察结果 → 继续思考
    ├─ 支持多轮对话（无工具调用时继续循环）
    ├─ ask_user: 向用户提问 → 挂起 loop → 等待回答 → 恢复
    ├─ pause: 暂停任务 → 等待恢复
    └─ finish: 任务完成 → 终止 loop
    ↓
构建成功
    ├─ 启动 dev server
    ├─ 获取预览 URL
    └─ 推送给前端（SSE → Timeline 实时展示）
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

### Run 状态机详解

**核心模型：一次用户请求 = 一个 Run，一个 Run = 一次 Agent Loop 的完整生命周期。**

- `ProjectRun` 是系统级调度信号——这个任务的状态是什么，谁该做什么
- `LoopState` 是应用级执行上下文——Loop 暂停时的内存快照，怎么继续做

#### ProjectRunStatus 状态流转

```
                    用户发消息
                        │
                        ▼
┌─────────┐  Worker拿到  ┌─────────┐  Agent执行完  ┌───────────┐
│  queued  │───────────→│ running │────────────→│ succeeded │
└─────────┘             └─────────┘             └───────────┘
                            │   │
                            │   │ LLM调用ask_user
                            │   ▼
                            │  ┌──────────────────┐  用户回答
                            │  │ waiting_for_user │──→ queued (重新排队)
                            │  └──────────────────┘
                            │
                            │ 内部暂停（pause API）
                            ▼
                       ┌────────┐  恢复（resume API）
                       │ paused │──→ queued (重新排队)
                       └────────┘
                            │
                            │ 用户点停止
                            ▼
                       ┌────────────┐  Worker感知到  ┌───────────┐
                       │ cancelling │──────────────→│ cancelled │
                       └────────────┘               └───────────┘
                            │
                            │ 崩溃/超时/LLM失败
                            ▼
                       ┌────────┐
                       │ failed │
                       └────────┘
```

#### 各状态职责

| 状态 | 含义 | 谁写入 | 谁消费 |
|------|------|--------|--------|
| `queued` | 等待 Worker 执行 | API 层（创建 run 时） | Worker（抢占执行权） |
| `running` | Worker 正在执行 Agent Loop | Worker（queued→running 原子转换） | assertRunWritable（检查点校验）、Stop API |
| `waiting_for_user` | Loop 挂起，等用户回答 | Agent Loop（ask_user 时） | `/answer` API（原子 claim）、前端（禁用输入框） |
| `paused` | 任务暂停，等待恢复 | `/pause` API | `/resume` API、前端展示 |
| `cancelling` | 用户请求停止，等 Worker 感知 | Stop API | assertRunWritable（抛异常退出 loop） |
| `cancelled` | 已停止 | finalizeRun | 前端展示 |
| `succeeded` | 正常完成 | finalizeRun | 前端展示、沙箱复用判断 |
| `failed` | 执行失败 | finalizeRun / 扫描器 | 前端展示 |

**设计原则：状态转换都是条件更新（`updateMany where status = X`），利用数据库行级锁实现原子性，不需要应用层加锁。**

### LoopState：Agent Loop 的存档点

LoopState 解决的问题：**Agent Loop 是有状态的长流程，但 HTTP 是无状态的。当 Loop 需要暂停等用户输入时，需要保存进度。**

```
Agent Loop 正在执行
    │
    │  LLM 返回 ask_user tool_call
    ▼
┌─ 存档（LoopState）─────────────────────────────┐
│                                                │
│  messages:  完整的对话历史（含最后的 assistant）   │
│  step:      当前执行到第几步                     │
│  state: {                                      │
│    completedToolResults: 已执行的工具结果         │
│    pendingToolCallId:   ask_user 的 tool_call ID│
│    askUserCount:        已问过几次               │
│    previewUrl:          当前预览地址             │
│    userAnswer:          用户的回答（恢复时填入）   │
│    resumeReady:         是否可以恢复（恢复时填入） │
│  }                                             │
│  answerToken: 幂等 token（防重复恢复）           │
│                                                │
└────────────────────────────────────────────────┘
    │
    │  用户回答后
    ▼
读取存档 → 重建 messages → 继续 Agent Loop
    │
    │  执行完毕
    ▼
删除存档（LoopState）
```

**为什么单独一张表：**

1. **数据量大**：messages 数组可能 50KB+，放在 ProjectRun 里会让频繁的 status 查询变慢
2. **生命周期不同**：LoopState 是临时的（恢复后删除），ProjectRun 是永久记录
3. **关注点分离**：ProjectRun 管"状态是什么"，LoopState 管"内存快照是什么"

### answerToken 的双重角色

`answerToken` 在系统里承担两个职责：

1. **API 层幂等**：`/answer` 路由校验 token 匹配，防止过期/重复的回答
2. **Worker 层 claim**：orchestrator 用 `updateMany where answerToken = X, set answerToken = ""` 做原子抢占，防止重复入队导致双重执行

一个字段，两层防护，分别在不同的时间点生效。

### 并发安全机制总览

| 层 | 防什么 | 手段 |
|----|--------|------|
| `/answer` API 层 | 双击/前端重试产生重复入队 | `updateMany` 乐观锁（waiting_for_user → queued） |
| BullMQ 入队层 | 同一 run 初始入队重复 | `jobId: runId` 去重 |
| BullMQ 入队层（resume） | resume 与初始 job 冲突 | `jobId: answerToken`（唯一值） |
| Worker 消费层 | 抢占执行权 | `updateMany where status: "queued"` 原子转换 |
| Orchestrator 层 | 队列 at-least-once 投递重复 | `answerToken` claim（置空标记已领取） |
| Agent Loop 层 | 已取消的 run 继续写入 | `assertRunWritable` 检查点 |
| 项目级 | 同一项目并行执行 | Redis 分布式锁（withProjectLock） |

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

# E2B
E2B_API_KEY="your-e2b-api-key"
E2B_TEMPLATE_ID="vite-react-tailwind"

# LLM 配置（默认使用 DeepSeek V4 Flash）
LLM_PROVIDER="deepseek"
LLM_API_KEY="your-deepseek-api-key"
LLM_BASE_URL="https://api.deepseek.com/v1"
LLM_MODEL="deepseek-v4-flash"

# v7 沙盒架构（可选，设为 true 启用 Agent Loop 在沙盒内运行）
USE_SANDBOX_RUNTIME="false"
E2B_TEMPLATE="ai-website-builder-v2"
INTERNAL_API_SECRET="your-internal-api-secret"
API_BASE_URL="http://localhost:3000"

# 应用配置
NEXT_PUBLIC_APP_URL="http://localhost:3000"
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
| `npm run build` | 生产构建（含 Prisma generate） |
| `npm run start` | 启动生产服务器 |
| `npm run db:push` | 同步数据库 Schema（无需 migration） |
| `npm run db:deploy` | 部署数据库 Schema（生产用） |
| `npm run db:migrate` | 创建并运行数据库 migration |
| `npm run db:generate` | 重新生成 Prisma Client |

### 开发调试

- **查看队列状态**：Worker 启动后会在 http://localhost:3001/monitor 提供 Bull Board 管理界面
- **查看 SSE 事件**：浏览器开发者工具 → Network → EventStream
- **查看 Agent 日志**：Worker 终端会输出详细的 Agent Loop 执行日志

## 切换 LLM 模型

修改 `.env` 中的配置即可切换模型。所有模型通过 OpenAI 兼容接口调用：

```bash
# DeepSeek（默认）
LLM_PROVIDER="deepseek"
LLM_API_KEY="your-deepseek-api-key"
LLM_BASE_URL="https://api.deepseek.com/v1"
LLM_MODEL="deepseek-v4-flash"  # 或 deepseek-v4-pro / deepseek-chat / deepseek-coder

# OpenAI
LLM_PROVIDER="openai"
LLM_API_KEY="sk-..."
LLM_BASE_URL="https://api.openai.com/v1"
LLM_MODEL="gpt-4o"  # 或 gpt-4o-mini / gpt-4-turbo

# Anthropic（需兼容代理）
LLM_PROVIDER="anthropic"
LLM_API_KEY="sk-ant-..."
LLM_BASE_URL="https://api.anthropic.com/v1"
LLM_MODEL="claude-sonnet-4-6"  # 或 claude-haiku-4-5-20251001

# Kimi (Moonshot)
LLM_PROVIDER="kimi"
LLM_API_KEY="your-kimi-api-key"
LLM_BASE_URL="https://api.moonshot.cn/v1"
LLM_MODEL="moonshot-v1-8k"  # 或 moonshot-v1-32k / moonshot-v1-128k
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

## E2B 沙盒

项目支持两种沙盒架构：

- **v6（默认）**：Agent Loop 在后端 Worker 中运行，通过 API 操控 E2B Sandbox
- **v7（实验性）**：设置 `USE_SANDBOX_RUNTIME=true`，Agent Loop 整体在 E2B Sandbox 内运行，通过 Internal API 回调后端

沙盒使用预构建 Template（`E2B_TEMPLATE_ID`），预装所有白名单依赖，跳过 npm install。

## v7 新架构设计（设计阶段）

v7 是下一代架构的完整技术方案，核心理念是**将 Agent Loop 作为沙盒内的一等公民运行，后端只负责调度和事件中转**。设计文档位于 [docs/new_architecture/](docs/new_architecture/)。

### 架构目标

| 指标 | 当前架构 (v6) | 新架构 (v7) | 提升 |
|------|--------------|-------------|------|
| 最大并发数 | 2 | 50+ | 25x |
| 停止响应时间 | 5-10s | <1s | 10x |
| 沙盒启动时间 | 15-30s | 2-5s | 6x |
| 代码复杂度 | 高 | 中 | -40% |

### 核心模块

```
用户请求 → Next.js API → BullMQ → Dispatcher (轻量调度)
                                     ↓
                                  E2B Sandbox
                                  ├─ Agent Runtime (Node.js)
                                  │  ├─ Loop (ReAct / Plan+ReAct 混合)
                                  │  ├─ SkillManager (动态工具加载)
                                  │  ├─ MemoryManager (项目级记忆)
                                  │  ├─ ContextAssembler (上下文组装)
                                  │  └─ EventEmitter (Redis Pub/Sub)
                                  └─ User Project (React + Vite)
                                     ↓
                                  Redis Pub/Sub → SSE → 前端
```

### 设计文档索引

| 文档 | 内容 |
|------|------|
| [COMPLETE_ARCHITECTURE.md](docs/new_architecture/COMPLETE_ARCHITECTURE.md) | 完整架构方案：沙盒化 Agent Runtime、SSE 用户级频道、Human-in-the-Loop（Redis BRPOP 阻塞等待）、E2B Template、Skill/Memory/MCP 系统、文件同步、任务终止 |
| [context-management-v2.md](docs/new_architecture/context-management-v2.md) | 上下文管理 v2：全量落盘 + 动态组装。Layer 1（外部压缩服务）、Layer 2（Repo Map + grep_ast）、Layer 3（Episodes 多路召回 + TaskSummary） |
| [memory.md](docs/new_architecture/memory.md) | Memory 机制：ProjectMemory（项目约束/决策 facts，压缩时零成本提取）、UserPreference（用户偏好跨项目复用）、BuildErrorPattern（错误修复知识库） |
| [skill-system-evolution.md](docs/new_architecture/skill-system-evolution.md) | Skill 自进化：混合披露协议（Resident/Deferred 分层）、search_skills 元工具、双模式自进化管线、归因追踪与自动升降级 |
| [CONCURRENCY_ANALYSIS.md](docs/new_architecture/CONCURRENCY_ANALYSIS.md) | 并发安全分析：已有防护机制、P0-P2 竞态场景识别、修复方案（条件更新、Redis 项目锁、Dispatcher 最终校验） |

### 关键设计决策

- **SSE 用户级频道**：单连接接收用户所有项目事件，沙盒通过 Redis Pub/Sub 直连推送
- **HITL 简化**：沙盒保持运行 + Redis BRPOP 阻塞等待（不退出沙盒），30 分钟超时后保存快照
- **上下文管理**：1M token 窗口 + 双阈值压缩（35 轮 / 500K token）+ 外部压缩服务 + 本地 Repo Map 不丢失
- **Memory 零成本提取**：与压缩共享同一次 LLM 调用，同时输出 summary + facts + obsolete IDs
- **Skill 混合披露**：核心工具常驻（Resident），扩展能力仅目录展示（Deferred），Agent 通过 search_skills 自主按需激活
- **Plan + ReAct 混合**：LLM 多维度分析决定模式，Plan 工具化管理 + 3 步未更新强制提醒
- **并发安全**：条件更新（状态机乐观锁）、Redis SET NX（防双击）、项目级锁（防并行 Run）

## 数据模型

主要数据表：

- **User**: 用户账号
- **Project**: 项目信息（名称、状态、Spec、预览 URL、沙盒 ID）
- **ProjectRun**: 任务执行记录（类型、状态、提示词、心跳、暂停原因）
- **Message**: 聊天消息（role、content）
- **ProjectFile**: 项目文件快照（路径、内容、版本）
- **BuildLog**: 构建日志（命令、输出、退出码、诊断）
- **SandboxSession**: 沙盒会话（状态、过期时间、预览 URL）
- **AgentConversation**: Agent 对话记忆（messages 数组、摘要、token 估算）
- **LoopState**: Agent Loop 挂起状态（ask_user 恢复用）
- **Skill**: 可扩展工具注册（builtin / composite / MCP，全局 / 用户 / 项目级作用域）
- **AgentRun**: 旧版执行记录（保留兼容）

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

### 架构演进

- **v1**: 单次生成，无对话历史
- **v2**: 支持迭代修改，但每次都重建沙盒
- **v3**: 引入沙盒复用，支持热更新
- **v4**: 引入 Run 生命周期，统一生成和迭代流程，Run Fencing 防并发
- **v5**: 多用户多项目支持
- **v6**: Human-in-the-Loop，前置意图分析 + 过程中 ask_user 挂起/恢复
- **v7（实验性）**: Sandbox Runtime 架构，Agent Loop 运行在沙盒内部

### 最近更新

- ✅ **Skill 系统**：可扩展的工具注册机制（builtin / composite / MCP），支持全局/用户/项目作用域
- ✅ **暂停/恢复**：任务支持 pause / resume，新增 `paused` 状态
- ✅ **Internal API**：沙盒 → 后端通信通道（finalize、pause、resume、file sync、build-logs）
- ✅ **用户级 SSE**：跨项目的实时通知流（`/api/stream/user`）
- ✅ **执行时间线**：Timeline 组件实时展示 Agent 每一步的执行过程和耗时
- ✅ **面板布局优化**：可拖拽调整面板宽度（ResizeHandle）
- ✅ **项目状态批量查询**：`/api/projects/states` 减少前端轮询开销
- ✅ **沙盒架构**：支持 Agent Loop 在沙盒内运行的新模式

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
