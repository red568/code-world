# AI 网站生成平台第一版实施方案

## 1. 目标范围

第一版目标是做一个网页端 AI 网站生成平台。用户输入想法后，系统自动生成网站代码，在云端沙盒中运行，并返回一个可公开访问的预览地址，让用户体验从需求输入、代码生成、构建部署到预览迭代的端到端开发过程。

第一版范围需要保持克制：

- 只生成前端网站或轻量全栈 Demo。
- 不支持任意后端复杂部署。
- 不支持用户自定义任意技术栈。
- 不自建代码执行沙盒。
- 不做完整 Coze/Atoms 级别的多 Agent 平台。

第一版核心体验：

```text
用户输入想法
  -> 流式生成结构化规格（实时展示）
  -> 流式生成 React/Vite/Tailwind 项目代码（逐文件展示进度）
  -> 写入预构建 E2B Sandbox（依赖已预装，跳过 npm install）
  -> 构建项目（日志实时 SSE 推送）
  -> 自动分析和修复错误（修复过程实时反馈）
  -> 启动预览服务
  -> 返回公网 Preview URL
  -> 用户继续对话迭代
```

## 2. 技术选型

### 2.1 平台主应用

推荐使用：

```text
Next.js + TypeScript + Tailwind CSS
```

用途：

- 用户界面。
- 登录和项目管理。
- 聊天输入和生成过程展示。
- iframe 预览 E2B 中运行的网站。
- API 层，负责创建任务、查询项目状态、读取日志。

### 2.2 后端语言

第一版不需要 Python。推荐使用 Node.js/TypeScript 作为主后端和 Agent 编排语言。

原因：

- 和 Next.js 主应用同语言，开发速度快。
- E2B、OpenAI、Anthropic、Prisma、BullMQ 等生态支持成熟。
- 一天内更容易完成从前端到后端到 Worker 的闭环。
- 避免维护 Python 服务、Node 服务两套运行环境。

后续只有在需要复杂 Agent 编排、评测、代码分析、LangGraph/CrewAI 等 Python 生态能力时，再拆出独立的 `agent-service`。

### 2.3 用户生成项目技术栈

第一版固定为：

```text
React + Vite + TypeScript + Tailwind CSS
```

可选内置依赖：

```text
lucide-react
framer-motion
recharts
```

推荐策略：

- 默认不让 Agent 任意选择框架。
- 默认不让 Agent 任意安装依赖。
- 维护依赖白名单。
- 优先使用原生 React + Tailwind 实现。

固定技术栈可以显著提升生成质量、构建成功率和修复稳定性。

### 2.4 沙盒

第一版使用：

```text
E2B Sandbox（预构建 Template）
```

用途：

- 创建隔离执行环境。
- 写入生成的项目文件。
- 直接执行 `npm run build`、`npm run dev`（依赖已预装在 Template 中）。
- 获取公网可访问的预览地址。

不建议第一版自建 Docker 沙盒。Docker 适合内部 Demo，但开放给外部用户时，不可信代码执行带来的安全风险更高。E2B 可以让第一版把重点放在产品和 Agent 闭环上。

### 2.5 预构建 E2B Template

第一版需要创建一个自定义 E2B Template，预装所有白名单依赖，避免每次创建项目都跑 `npm install`。

Template 内容：

```text
基于 Node.js 20 基础镜像
预装项目模板文件（package.json、vite.config.ts、tsconfig.json 等）
预装 node_modules（包含所有白名单依赖）
预配置 Vite dev server 启动脚本
```

预装依赖列表：

```text
react
react-dom
typescript
@types/react
@types/react-dom
@vitejs/plugin-react
vite
tailwindcss
postcss
autoprefixer
lucide-react
framer-motion
recharts
```

构建和发布 Template：

```bash
# 本地创建 template 目录
e2b template init

# 编写 e2b.Dockerfile
FROM node:20-slim
WORKDIR /app
COPY template-vite-react-tailwind/ .
RUN npm install

# 发布 template
e2b template build --name "vite-react-tailwind"
```

使用方式：

```typescript
import { Sandbox } from '@e2b/code-interpreter';

const sandbox = await Sandbox.create({
  template: 'vite-react-tailwind',  // 使用预构建 template
});

// 直接写入业务代码，无需 npm install
await sandbox.files.write('src/App.tsx', generatedCode);
await sandbox.commands.run('npm run build');
await sandbox.commands.run('npm run dev -- --host 0.0.0.0 --port 5173');
```

性能对比：

```text
无 Template：创建 sandbox (3s) + npm install (30-60s) + build (5-10s) = 40-70s
有 Template：创建 sandbox (3s) + build (5-10s) = 8-13s
```

Template 维护策略：

- 白名单依赖更新时重新构建 Template。
- 保持 Template 版本和平台版本同步。
- 如果用户需要白名单外的依赖，仅对该依赖执行增量 `npm install`。

### 2.6 数据库和队列

推荐：

```text
PostgreSQL + Prisma
Redis + BullMQ
```

PostgreSQL 保存长期状态：

- 用户。
- 项目。
- 消息。
- 文件快照。
- 构建日志。
- 沙盒信息。

Redis/BullMQ 处理后台任务：

- 代码生成任务。
- 构建部署任务。
- 自动修复任务。
- 取消和重试任务。

## 3. 部署方案

第一版推荐部署在 Railway。

整体架构：

```text
Railway Project
  ├─ web        Next.js 主站/API/SSE 端点
  ├─ worker     Agent Worker / BullMQ Worker（推送事件到 Redis pub/sub）
  ├─ postgres   Railway PostgreSQL
  └─ redis      Railway Redis（队列 + SSE 事件 pub/sub）

E2B
  └─ 预构建 Template（vite-react-tailwind，依赖已预装）
  └─ 用户项目 Sandbox 实例
```

请求链路：

```text
用户浏览器
  -> Railway Web Service
  -> PostgreSQL 保存项目和任务状态
  -> Redis Queue 创建后台任务
  -> Railway Worker 执行 Agent 流程
  -> Worker 通过 Redis pub/sub 推送实时事件
  -> Web Service 通过 SSE 将事件推送到浏览器
  -> 调用 LLM（流式响应）和 E2B（预构建 Template）
  -> E2B 返回 Preview URL
  -> Web 端 iframe 自动展示预览
```

Railway 适合第一版的原因：

- 可以同时运行 Next.js、Worker、Postgres、Redis。
- 支持 GitHub 自动部署。
- 比自建服务器和 Kubernetes 简单。
- 比纯 Vercel 更适合长任务和后台 Worker。
- 服务之间可以使用私有网络通信。

## 4. Agent 设计

### 4.1 总体原则

第一版只使用一个 Agent 编排器，但使用四类 Prompt。不要维护四个长期对话会话，而是使用四个短任务上下文。

推荐原则：

```text
隔离任务上下文，不隔离业务流程。
```

也就是说：

- 用户聊天会话需要持久化。
- Agent 内部的 Spec、Codegen、Review、Fix 调用不需要长期持久化为完整对话。
- 每一步的产物写入数据库。
- 下一步从数据库读取真实状态，而不是依赖模型记忆。

### 4.2 四类 Prompt

#### Spec Prompt

目标：把用户模糊需求转成结构化产品规格。

输入：

- 用户原始需求。
- 平台能力边界。
- 默认技术栈。
- UI/UX 质量要求。

输出示例：

```json
{
  "app_type": "landing_page",
  "pages": ["home"],
  "features": ["hero", "gallery", "booking_form", "contact"],
  "style": {
    "tone": "modern premium",
    "layout": "responsive landing page"
  },
  "constraints": [
    "must use React + Vite + Tailwind",
    "must not require custom backend",
    "must run with npm run dev"
  ]
}
```

#### Codegen Prompt

目标：根据规格和固定模板生成项目文件。

输入：

- Spec JSON。
- 模板文件树。
- 可修改文件列表。
- 允许依赖白名单。
- 代码风格和 UI 质量要求。

输出示例：

```json
{
  "files": [
    {
      "path": "src/App.tsx",
      "content": "..."
    },
    {
      "path": "src/index.css",
      "content": "..."
    }
  ]
}
```

第一版建议使用整文件替换，暂时不使用复杂 diff patch。

#### Review Prompt

目标：在真实构建前先检查生成代码的明显问题。

输入：

- Spec JSON。
- 文件树。
- `package.json`。
- 关键文件内容。

检查点：

- import 路径是否存在。
- 是否使用未安装依赖。
- JSX/TSX 是否明显有语法错误。
- 是否使用浏览器不可用的 Node API。
- 是否符合固定技术栈。
- 是否存在明显空页面或占位内容。

输出示例：

```json
{
  "passed": false,
  "issues": [
    {
      "severity": "error",
      "file": "src/App.tsx",
      "problem": "Imports Button from a missing file.",
      "suggested_fix": "Create the component or inline the button markup."
    }
  ]
}
```

#### Fix Prompt

目标：根据真实命令日志和相关文件内容修复构建或运行错误。

输入：

- Spec JSON。
- 最近一次执行的命令。
- stdout/stderr。
- 错误分类。
- 相关文件内容。
- `package.json`。
- 文件树。
- 前几次修复尝试摘要。

输出示例：

```json
{
  "diagnosis": "The app imports lucide-react icons, but lucide-react is not installed.",
  "files": [
    {
      "path": "package.json",
      "content": "..."
    }
  ]
}
```

### 4.3 上下文隔离方式

每个阶段只传入完成当前任务所需的最小真实状态：

```text
Spec:
  用户需求 + 平台约束

Codegen:
  Spec + 模板 + 依赖白名单

Review:
  Spec + 文件树 + 关键文件

Fix:
  Spec + 错误日志 + 相关文件 + 修复历史摘要
```

不要把完整聊天历史、完整日志、所有文件无差别塞给每一个 Prompt。

## 5. 自动构建和修复流程

### 5.1 标准流程

```text
1. 创建项目记录
2. Spec Prompt 生成规格（流式推送到前端）
3. 从预构建 Template 创建 E2B Sandbox（依赖已预装）
4. Codegen Prompt 生成业务文件（逐文件流式推送）
5. Review Prompt 做静态审查（问题实时推送）
6. 将生成的业务文件写入 E2B Sandbox
7. 执行 npm run build（日志实时推送）
8. 构建成功后执行 npm run dev -- --host 0.0.0.0 --port 5173
9. 获取 E2B Preview URL
10. 推送 preview_ready 事件，前端自动加载 iframe
```

### 5.2 自动修复循环

最多自动修复 3 轮：

```text
for attempt in 1..3:
  run npm run build（日志实时 SSE 推送）

  if build success:
    run npm run dev
    publish preview_ready 事件
    return preview_url

  classify_error(stderr)
  publish fix_start 事件（显示诊断信息）
  run Fix Prompt
  apply file replacements to sandbox
  publish fix_done 事件
  save fix attempt summary
```

### 5.3 错误分类

常见错误类型和策略：

| 错误类型 | 示例 | 修复策略 |
|---|---|---|
| 依赖缺失 | `Cannot find module 'lucide-react'` | 安装白名单依赖或替换实现 |
| import 错误 | `Failed to resolve import './Button'` | 修正路径或创建缺失文件 |
| JSX 语法错误 | `Unexpected token` | 定位文件和行号，重写相关文件 |
| TypeScript 错误 | `Property xxx does not exist` | 修正类型或简化实现 |
| 构建错误 | `vite build failed` | 将日志和相关文件交给 Fix Prompt |
| 启动错误 | 端口不可用或 script 缺失 | 修正启动命令或 package scripts |
| 运行时白屏 | 浏览器 console 报错 | 后续接入浏览器检查后修复 |

第一版至少实现命令级错误修复。后续再加入浏览器 console 检查和截图视觉检查。

## 6. 项目模板

维护一个固定模板：

```text
template-vite-react-tailwind/
  package.json
  index.html
  vite.config.ts
  tsconfig.json
  src/
    main.tsx
    App.tsx
    index.css
    components/
    lib/
  public/
```

第一版默认允许 Agent 修改：

```text
src/App.tsx
src/index.css
src/components/*
public/*
```

谨慎允许修改：

```text
package.json
```

不建议第一版允许修改：

```text
vite.config.ts
tsconfig.json
index.html
```

除非确实有明确需求。

## 7. 数据模型建议

### User

```text
id
email
name
createdAt
updatedAt
```

### Project

```text
id
userId
title
originalPrompt
specJson
status
sandboxId
previewUrl
createdAt
updatedAt
```

状态建议：

```text
created
spec_generating
code_generating
reviewing
building
fixing
running
failed
stopped
```

### Message

```text
id
projectId
role
content
createdAt
```

### ProjectFile

```text
id
projectId
path
content
version
createdAt
updatedAt
```

### BuildLog

```text
id
projectId
command
stdout
stderr
exitCode
diagnosis
attempt
createdAt
```

### AgentRun

```text
id
projectId
type
inputSummary
outputJson
status
createdAt
```

### SandboxSession

```text
id
projectId
sandboxId
provider
status
previewUrl
startedAt
stoppedAt
expiresAt
```

## 8. API 设计建议

第一版可以设计为：

```text
POST /api/projects
  创建项目，保存用户 prompt，创建生成任务

GET /api/projects/:id
  获取项目状态、spec、previewUrl

GET /api/projects/:id/files
  获取当前文件树和内容

GET /api/projects/:id/logs
  获取构建日志

POST /api/projects/:id/messages
  用户继续提出修改需求，创建迭代任务

POST /api/projects/:id/stop
  停止 E2B sandbox

POST /api/projects/:id/retry
  重新执行构建或修复
```

日志实时推送可以使用：

```text
Server-Sent Events (SSE)
```

第一版用 SSE 比 WebSocket 更简单。

### 8.1 Streaming 实时推送设计

第一版所有生成和构建过程都通过 SSE 实时推送到前端，避免用户长时间等待无反馈。

SSE 端点：

```text
GET /api/projects/:id/stream
```

事件类型定义：

```typescript
// SSE 事件类型
type SSEEvent =
  | { type: 'status_change'; data: { status: ProjectStatus; message: string } }
  | { type: 'spec_chunk'; data: { chunk: string } }                    // Spec 流式生成
  | { type: 'spec_done'; data: { specJson: object } }                  // Spec 生成完成
  | { type: 'codegen_file_start'; data: { path: string } }             // 开始生成某个文件
  | { type: 'codegen_chunk'; data: { path: string; chunk: string } }   // 文件内容流式输出
  | { type: 'codegen_file_done'; data: { path: string } }              // 某个文件生成完成
  | { type: 'codegen_done'; data: { fileCount: number } }              // 所有文件生成完成
  | { type: 'review_issue'; data: { severity: string; file: string; problem: string } }
  | { type: 'build_log'; data: { stream: 'stdout' | 'stderr'; line: string } }
  | { type: 'fix_start'; data: { attempt: number; diagnosis: string } }
  | { type: 'fix_done'; data: { attempt: number; success: boolean } }
  | { type: 'preview_ready'; data: { previewUrl: string } }
  | { type: 'error'; data: { message: string; code: string } };
```

后端推送实现：

```typescript
// Next.js Route Handler 示例
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: SSEEvent) => {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
        );
      };

      // 订阅 Redis pub/sub 频道获取 Worker 推送的事件
      const subscriber = redis.duplicate();
      await subscriber.subscribe(`project:${params.id}:events`);
      subscriber.on('message', (channel, message) => {
        send(JSON.parse(message));
      });

      req.signal.addEventListener('abort', () => {
        subscriber.unsubscribe();
        subscriber.disconnect();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

Worker 端推送事件：

```typescript
// Worker 中在每个阶段推送事件
async function publishEvent(projectId: string, event: SSEEvent) {
  await redis.publish(`project:${projectId}:events`, JSON.stringify(event));
}

// Spec 生成阶段 - 使用 LLM streaming
const specStream = await llm.chat.completions.create({
  model: 'claude-sonnet-4-6',
  messages: specMessages,
  stream: true,
});

for await (const chunk of specStream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    await publishEvent(projectId, { type: 'spec_chunk', data: { chunk: content } });
  }
}

// Codegen 生成阶段 - 逐文件推送
for (const file of generatedFiles) {
  await publishEvent(projectId, { type: 'codegen_file_start', data: { path: file.path } });
  // 流式写入文件内容...
  await publishEvent(projectId, { type: 'codegen_file_done', data: { path: file.path } });
}

// 构建阶段 - 实时推送 stdout/stderr
const buildProcess = await sandbox.commands.run('npm run build', {
  onStdout: (line) => publishEvent(projectId, { type: 'build_log', data: { stream: 'stdout', line } }),
  onStderr: (line) => publishEvent(projectId, { type: 'build_log', data: { stream: 'stderr', line } }),
});
```

前端消费 SSE：

```typescript
// React Hook
function useProjectStream(projectId: string) {
  const [status, setStatus] = useState<ProjectStatus>('created');
  const [specChunks, setSpecChunks] = useState('');
  const [files, setFiles] = useState<Map<string, string>>(new Map());
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const eventSource = new EventSource(`/api/projects/${projectId}/stream`);

    eventSource.addEventListener('status_change', (e) => {
      setStatus(JSON.parse(e.data).status);
    });

    eventSource.addEventListener('spec_chunk', (e) => {
      setSpecChunks((prev) => prev + JSON.parse(e.data).chunk);
    });

    eventSource.addEventListener('codegen_file_start', (e) => {
      const { path } = JSON.parse(e.data);
      setFiles((prev) => new Map(prev).set(path, ''));
    });

    eventSource.addEventListener('build_log', (e) => {
      const { line } = JSON.parse(e.data);
      setBuildLogs((prev) => [...prev, line]);
    });

    eventSource.addEventListener('preview_ready', (e) => {
      setPreviewUrl(JSON.parse(e.data).previewUrl);
    });

    return () => eventSource.close();
  }, [projectId]);

  return { status, specChunks, files, buildLogs, previewUrl };
}
```

Streaming 各阶段用户可见反馈：

```text
Spec 阶段：     左侧聊天区逐字显示 AI 对需求的理解和规划
Codegen 阶段：  中间面板逐个显示正在生成的文件名和进度
Review 阶段：   中间面板显示检查项和发现的问题
Build 阶段：    中间面板实时滚动显示构建日志
Fix 阶段：      中间面板显示"正在修复第 N 轮"及诊断信息
Preview 阶段：  右侧 iframe 自动加载预览地址
```

## 9. 前端界面建议

第一版主界面：

```text
左侧：聊天和需求输入（Spec 阶段逐字流式显示 AI 理解）
中间：生成步骤、文件生成进度、构建日志、错误修复状态（全部实时更新）
右侧：iframe 预览生成的网站（preview_ready 后自动加载）
```

必要状态（全部通过 SSE 实时驱动）：

- 正在生成规格（逐字流式显示）。
- 正在生成代码（逐文件显示文件名和进度条）。
- 正在构建（实时滚动构建日志）。
- 正在修复第几轮（显示诊断信息）。
- 构建失败（显示错误摘要）。
- 预览可用（自动加载 iframe）。

第一版不需要复杂代码编辑器。可以先做文件查看，后续再加入 Monaco Editor。

## 10. 安全和成本控制

### 10.1 安全

需要注意：

- 不要在 E2B 中注入平台敏感环境变量。
- 用户生成代码不应拿到 OpenAI/E2B/数据库密钥。
- E2B sandbox 和平台数据库完全隔离。
- 限制可安装依赖。
- 限制命令执行范围。
- 不允许用户直接输入 shell 命令。
- iframe 预览建议加 sandbox 属性。

iframe 示例：

```html
<iframe
  sandbox="allow-scripts allow-forms allow-same-origin"
  src="https://preview-url"
/>
```

是否允许 `allow-same-origin` 需要根据预览能力和安全策略进一步评估。

### 10.2 成本控制

E2B 运行时间会产生费用，因此需要：

- 免费用户限制同时运行 sandbox 数量。
- 项目无操作一段时间后自动停止 sandbox。
- 保存文件快照，允许重新创建 sandbox。
- 限制自动修复次数。
- 限制单次生成最大文件数和最大 token。
- 限制单项目依赖安装和构建时间。

建议第一版默认：

```text
每个项目最多自动修复 3 次
每个用户最多同时运行 1 个 sandbox
免费项目空闲 10-15 分钟后停止 sandbox
```

## 11. 一天 MVP 开发计划

### 阶段 1：基础项目

- 创建 Next.js + TypeScript 项目。
- 接入 Tailwind。
- 接入 Prisma + PostgreSQL。
- 创建基础数据表。
- 搭建三栏 UI。

### 阶段 2：预构建 E2B Template

- 创建 `template-vite-react-tailwind/` 目录。
- 编写 `e2b.Dockerfile`，预装所有白名单依赖。
- 执行 `e2b template build` 发布 Template。
- 验证 Template 启动后可以直接 `npm run build`。

### 阶段 3：Agent 最小闭环

- 实现 Spec Prompt（流式输出）。
- 实现 Codegen Prompt（流式输出，逐文件推送）。
- 将生成文件保存到数据库。

### 阶段 4：E2B 集成

- 使用预构建 Template 创建 E2B sandbox。
- 写入生成的业务文件。
- 执行 `npm run build`（无需 npm install）。
- 执行 `npm run dev -- --host 0.0.0.0 --port 5173`。
- 获取并保存 Preview URL。

### 阶段 5：SSE Streaming 集成

- 实现 Redis pub/sub 事件通道。
- 实现 `/api/projects/:id/stream` SSE 端点。
- Worker 各阶段推送事件。
- 前端实现 `useProjectStream` Hook。
- 验证全流程实时反馈。

### 阶段 6：自动修复

- 实现错误分类。
- 实现 Fix Prompt。
- 最多自动修复 3 次。
- 保存修复摘要和日志。
- 修复过程通过 SSE 实时反馈。

### 阶段 7：Railway 部署

- 创建 Railway Project。
- 添加 Web 服务。
- 添加 Worker 服务。
- 添加 PostgreSQL。
- 添加 Redis。
- 配置环境变量。
- 执行 Prisma migration。
- 部署并测试完整链路。

## 12. 第一版验收标准

第一版完成时，应满足：

- 用户可以输入一个网站想法。
- 系统能生成结构化规格。
- 系统能生成 React/Vite/Tailwind 代码。
- 代码能写入 E2B。
- 系统能自动安装依赖并构建。
- 构建失败时至少能自动修复一类常见错误。
- 构建成功后能返回公网 Preview URL。
- 前端能通过 iframe 预览网站。
- 用户可以继续输入修改需求并触发二次生成。
- 平台可以部署在 Railway 上给外部用户访问。

## 13. 后续迭代方向

第一版跑通后，再考虑：

- Monaco Editor 在线编辑代码。
- 浏览器 console 错误采集。
- Playwright 截图和视觉质量检查。
- GitHub 导出代码。
- Vercel/Cloudflare Pages 一键生产部署。
- Supabase 集成，让用户生成轻量全栈应用。
- 多页面应用生成。
- 组件库和行业模板库。
- 多 Agent 拆分为 Planner、Builder、Reviewer、Fixer。
- 项目 checkpoint 和 rollback。
- 计费、限额和团队协作。

## 14. 推荐最终方案

第一版最终推荐：

```text
主应用：
  Next.js + TypeScript + Tailwind

后端：
  Node.js/TypeScript

数据库：
  PostgreSQL + Prisma

队列和事件：
  Redis + BullMQ + Redis pub/sub（SSE 实时推送）

沙盒：
  E2B Sandbox（预构建 Template，依赖预装）

部署：
  Railway Web Service + Railway Worker + Railway Postgres + Railway Redis

生成目标：
  React + Vite + TypeScript + Tailwind

Agent 架构：
  一个 Orchestrator + 四类短任务 Prompt（全部支持流式输出）
  Spec -> Codegen -> Review -> Fix

实时体验：
  SSE 全程推送 + LLM 流式响应 + 构建日志实时输出
```

核心判断：

```text
固定技术栈，优先跑通闭环。
使用预构建 Template，将 sandbox 启动到可预览缩短到 10 秒级别。
使用 SSE 全程实时推送，消除用户等待黑盒感。
使用托管沙盒，避免第一版陷入安全和运维复杂度。
使用 Worker 执行长任务，避免 API 请求超时。
使用真实构建日志驱动自动修复，而不是一次性生成代码。
```

