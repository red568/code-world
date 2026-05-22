# AI Website Builder

AI 驱动的网站生成平台。用户输入想法，系统自动生成前端代码，在云端沙盒中构建运行，返回可公开访问的预览地址。

## 技术栈

- **主应用**: Next.js 16 + TypeScript + Tailwind CSS
- **后端**: Node.js / TypeScript
- **数据库**: Railway PostgreSQL + Prisma 7
- **队列**: Railway Redis + BullMQ
- **沙盒**: E2B Sandbox（预构建 Template）
- **LLM**: 默认 Kimi (Moonshot)，可切换 OpenAI / DeepSeek / Anthropic
- **部署**: Railway（Web + Worker + PostgreSQL + Redis 统一托管）

## 项目结构

```
src/
├── app/                  # Next.js 页面和 API 路由
│   ├── page.tsx          # 三栏主页面（聊天 | 状态 | 预览）
│   └── api/projects/     # REST API 端点
├── components/           # React 组件
│   ├── chat-panel.tsx    # 左栏：聊天输入
│   ├── status-panel.tsx  # 中栏：实时状态 / 构建日志
│   └── preview-panel.tsx # 右栏：iframe 预览
├── hooks/                # React Hooks
│   └── use-project-stream.ts  # SSE 事件消费
├── lib/
│   ├── llm/              # LLM 服务（多 Provider 支持）
│   ├── agent/            # 四类 Agent Prompt（Spec / Codegen / Review / Fix）
│   ├── sandbox/          # E2B Sandbox 操作封装
│   ├── streaming/        # SSE 事件定义和 Redis pub/sub 发布
│   ├── queue/            # BullMQ 队列 + 编排器
│   └── template/         # 固定项目模板文件
├── worker.ts             # BullMQ Worker 入口（独立进程）
└── generated/prisma/     # Prisma 生成的客户端（gitignore）

e2b-template/             # E2B 预构建 Template（预装依赖，跳过 npm install）
prisma/schema.prisma      # 数据模型定义
```

## 本地开发

本地开发时连接 Railway 上的 PostgreSQL 和 Redis，无需在本地安装数据库。

### 前置依赖

- Node.js 20+
- Railway 账号（PostgreSQL 和 Redis 在 Railway 上运行）
- E2B 账号和 API Key
- Kimi (Moonshot) API Key（或其他支持的 LLM Provider）

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
LLM_API_KEY="your-kimi-api-key"
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
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run worker` | 启动 BullMQ Worker |
| `npm run build` | 生产构建 |
| `npm run db:push` | 同步数据库 Schema（无需 migration） |
| `npm run db:migrate` | 创建并运行数据库 migration |
| `npm run db:generate` | 重新生成 Prisma Client |

## 切换 LLM 模型

修改 `.env` 中的三个变量即可切换模型：

```bash
# Kimi（默认）
LLM_PROVIDER="kimi"
LLM_API_KEY="your-kimi-api-key"
LLM_BASE_URL="https://api.moonshot.cn/v1"
LLM_MODEL="moonshot-v1-8k"

# OpenAI
LLM_PROVIDER="openai"
LLM_API_KEY="sk-..."
LLM_BASE_URL="https://api.openai.com/v1"
LLM_MODEL="gpt-4o"

# DeepSeek
LLM_PROVIDER="deepseek"
LLM_API_KEY="your-deepseek-key"
LLM_BASE_URL="https://api.deepseek.com/v1"
LLM_MODEL="deepseek-chat"
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
