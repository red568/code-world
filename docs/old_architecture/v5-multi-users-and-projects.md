# V5: 多用户多项目并行方案

## 背景与约束

### 用户场景

用户创建多个项目，让它们同时在后台运行。过段时间后，用户再点击某个项目查看进展成果。

### 物理约束

| 资源 | 规格 |
|------|------|
| 部署平台 | Railway |
| Worker 机器数量 | 最多 2 台 |
| 单机配置 | 2 vCPU / 1GB Memory |
| 机器规格 | 固定不可升级，只能加数量 |
| 外部依赖 | PostgreSQL、Redis（Railway 托管）、E2B Sandbox、LLM API |

---

## 瓶颈逐层分析

### 1. Worker 处理能力（核心瓶颈）

| 参数 | 数值 |
|------|------|
| Worker 数量 | 2 |
| 每台 concurrency | 1（优化后） |
| 同时执行的 job | 2 |
| Generate 平均耗时 | ~70 秒 |
| Iterate 平均耗时 | ~35 秒 |
| 混合平均耗时 | ~50 秒/job |
| 每分钟吞吐 | ~2.4 个 job |
| 每小时吞吐 | ~144 个 job |

### 2. 单台 Worker 内存分布（concurrency=1 + 中途压缩优化后）

| 组件 | 内存占用 |
|------|----------|
| Node.js 基础 + Prisma + Redis 客户端 | ~130MB |
| Bull Board Express | ~20MB |
| 单个 job 峰值（messages + LLM 响应缓冲） | ~150-200MB |
| **合计峰值** | **~350-400MB** |

加上 `--max-old-space-size=768`，还有 ~370MB 安全余量。

### 3. Web 进程（Next.js）

| 参数 | 数值 |
|------|------|
| 单个 SSE 连接内存 | ~2-5MB（Redis subscriber duplicate） |
| Web 进程可用内存 | ~700MB（扣除 Next.js 基础开销 ~300MB） |
| SSE 连接上限 | ~150-200 个 |
| Railway 单实例 TCP 并发建议 | ~100 连接 |

### 4. Redis（pub/sub + 队列 + 锁）

| 操作 | 开销 |
|------|------|
| BullMQ 队列中每个 job | ~1-2KB |
| pub/sub 频道（无持久化） | 几乎为 0 |
| 项目锁 | 每个 ~100 bytes，TTL 600s |
| Redis 能支撑的排队 job | 数万个（不是瓶颈） |

### 5. E2B Sandbox（外部服务）

| 参数 | 数值 |
|------|------|
| 同时执行的 sandbox | 2（跟 worker 并发一致） |
| 成功后 keepAlive | 15 分钟 |
| E2B 免费套餐并发限制 | 通常 5-10 个 |
| 结论 | 不是瓶颈 |

### 6. LLM API

| 参数 | 数值 |
|------|------|
| 每个 job 的 LLM 调用次数 | 5-50 次（平均 ~15 次） |
| 2 个并发 job 的 QPS | ~0.5-1 req/s |
| DeepSeek API 限制 | 通常 60+ req/s |
| 结论 | 不是瓶颈 |

### 7. PostgreSQL

| 操作 | 频率 |
|------|------|
| 每个 job 的 DB 写入 | ~10-20 次 |
| heartbeat 更新 | 每 5 个 checkpoint 一次 |
| Railway PG 连接池 | 通常 20-50 连接 |
| 结论 | 不是瓶颈 |

---

## 容量计算

### 吞吐量时间线

假设 10 个用户在同一分钟内各提交 1 个项目：

```
T=0s    Job 1, 2 开始执行
T=0s    Job 3-10 排队（队列深度 8）

T=50s   Job 1, 2 完成 → Job 3, 4 开始
T=100s  Job 3, 4 完成 → Job 5, 6 开始
T=150s  Job 5, 6 完成 → Job 7, 8 开始
T=200s  Job 7, 8 完成 → Job 9, 10 开始
T=250s  Job 9, 10 完成

总耗时：~4 分钟全部完成
最后一个用户等了：~4 分钟
```

### 综合容量

| 指标 | 保守值（良好体验） | 乐观值（可接受体验） |
|------|--------|--------|
| 同时在线用户 | 8-10 | 15-20 |
| 同时执行的项目 | 2 | 2 |
| 排队中的项目 | 4-6 | 8-10 |
| 系统中活跃项目总数 | 6-8 | 10-12 |
| 用户平均等待时间 | ~1-2 分钟 | ~3-5 分钟 |

"保守值"保证等待 < 2 分钟，"乐观值"系统不崩但用户需要耐心等。

---

## 推荐限制参数

| 参数 | 值 | 理由 |
|------|-----|------|
| Per-user 并发上限 | **3**（queued + running） | 用户提交 3 个项目，~2-3 分钟全部完成 |
| 系统级排队上限 | **20** | 超过返回"系统繁忙"，防止无限积压 |
| Worker concurrency | **1**（每台） | 保证内存安全，峰值 ~400MB |
| Worker 实例数 | **2** | 两台机器各跑一个 worker |

Per-user 设为 3 的理由：
- 2 个同时执行 + 1 个排队 = 用户最多等 1-2 分钟就能全部跑完
- 每个 running 项目占用一个 E2B sandbox（按时计费），3 个成本可控
- 防止单用户垄断队列，保证多用户公平性

---

## 架构方案

### 部署拓扑

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Web (Next.js) │     │   Worker #1     │     │   Worker #2     │
│   API + SSE     │     │  concurrency=1  │     │  concurrency=1  │
│   Port 3000     │     │  monitor:3001   │     │  monitor:3001   │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │   Redis (BullMQ 队列)    │
                    │   + pub/sub + 分布式锁   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │      PostgreSQL          │
                    └─────────────────────────┘
```

BullMQ 天然支持多 worker 竞争消费，两台 worker 连同一个 Redis 队列即可，无需额外协调。

### 与当前架构的差异

| 项目 | 当前 | 优化后 |
|------|------|--------|
| Worker concurrency | 2 | 1（每台） |
| Worker 实例数 | 1 | 2 |
| 内存保护 | 无 | `--max-old-space-size=768` |
| 对话压缩时机 | 仅 run 结束时 | run 执行中途也压缩 |
| 用户认证 | 硬编码 demo-user | Session/JWT |
| 并发限制 | 无 | per-user 3 + 系统级 20 |
| SSE 断线恢复 | 无 | 连接时推送状态快照 |

---

## 具体实现方案

### 1. Worker 启动参数优化

**文件：`package.json`**

```json
{
  "scripts": {
    "worker": "node --max-old-space-size=768 --import tsx/esm src/worker.ts"
  }
}
```

### 2. Worker concurrency 调整

**文件：`src/worker.ts`**

```typescript
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "1", 10);

const worker = new Worker<AgentJobData>(
  QUEUE_NAME,
  async (job) => { /* ... */ },
  {
    connection: redis,
    concurrency: WORKER_CONCURRENCY,
  }
);
```

### 3. Per-user 并发限制

**文件：`src/app/api/projects/route.ts`**

```typescript
const MAX_CONCURRENT_RUNS_PER_USER = 3;
const MAX_SYSTEM_QUEUE_DEPTH = 20;

export async function POST(request: NextRequest) {
  // ... 解析 prompt、获取 userId ...

  // Per-user 并发限制
  const userActiveCount = await prisma.projectRun.count({
    where: {
      userId,
      status: { in: ["queued", "running"] },
    },
  });

  if (userActiveCount >= MAX_CONCURRENT_RUNS_PER_USER) {
    return Response.json(
      { error: "同时运行的项目数已达上限，请等待当前项目完成" },
      { status: 429 }
    );
  }

  // 系统级排队上限
  const systemQueueDepth = await prisma.projectRun.count({
    where: { status: { in: ["queued", "running"] } },
  });

  if (systemQueueDepth >= MAX_SYSTEM_QUEUE_DEPTH) {
    return Response.json(
      { error: "系统繁忙，请稍后再试" },
      { status: 503 }
    );
  }

  // ... 正常创建项目和入队 ...
}
```

### 4. AgentLoop 中途对话压缩

**文件：`src/lib/agent/loop.ts`**

在 agent loop 的主循环中，每隔一定步数检查并压缩 messages：

```typescript
const IN_LOOP_COMPRESS_INTERVAL = 10; // 每 10 步检查一次
const IN_LOOP_MAX_TOKENS = 60000;     // 运行中的 token 上限（比持久化阈值低）

for (step = 1; step <= maxSteps; step++) {
  // ... 检查点、LLM 调用、tool 执行 ...

  // 中途压缩：防止单次 run 内 messages 无限膨胀
  if (step % IN_LOOP_COMPRESS_INTERVAL === 0) {
    const currentTokens = estimateTokens(messages);
    if (currentTokens > IN_LOOP_MAX_TOKENS) {
      const before = messages.length;
      messages = compressMessagesForLoop(messages);
      console.log(
        `[AgentLoop] [${projectId.slice(0, 8)}] step=${step} 中途压缩: ${before} → ${messages.length} msgs`
      );
    }
  }
}
```

**新增函数 `compressMessagesForLoop`（文件：`src/lib/agent/conversation.ts`）：**

```typescript
/**
 * AgentLoop 运行中途的压缩
 *
 * 比 compressMessagesIfNeeded 更激进：
 * - 保留 system prompt
 * - 保留最近 5 轮完整内容（含 tool_call/tool_result，LLM 需要这些来理解上下文）
 * - 更早的轮次：只保留 user 消息 + assistant 的文本思考，丢弃所有 tool 交互
 * - 如果压缩后仍超限，进一步截断 tool result 内容
 */
export function compressMessagesForLoop(messages: Message[]): Message[] {
  if (messages.length < 6) return messages;

  const systemMsg = messages[0];
  const recentStart = findRecentRoundsStart(messages, 5);

  const compressed: Message[] = [systemMsg];

  // 早期轮次：只保留 user + assistant 文本
  for (let i = 1; i < recentStart; i++) {
    const msg = messages[i];
    if (msg.role === "user" && typeof msg.content === "string") {
      compressed.push({ role: "user", content: msg.content.slice(0, 500) });
    } else if (
      msg.role === "assistant" &&
      "content" in msg &&
      typeof msg.content === "string" &&
      msg.content
    ) {
      compressed.push({ role: "assistant", content: msg.content.slice(0, 300) });
    }
    // tool role 和带 tool_calls 的 assistant 消息直接丢弃
  }

  // 最近 5 轮完整保留
  compressed.push(...messages.slice(recentStart));

  return compressed;
}
```

### 5. SSE 断线重连时推送状态快照

**文件：`src/app/api/projects/[id]/stream/route.ts`**

```typescript
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = getProjectChannel(id);
  const encoder = new TextEncoder();

  const subscriber = redisSub.duplicate();

  // 预加载当前状态，用于断线重连后立即推送
  const [project, latestRun] = await Promise.all([
    prisma.project.findUnique({
      where: { id },
      select: { status: true, previewUrl: true, title: true },
    }),
    prisma.projectRun.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      select: { status: true, type: true, error: true },
    }),
  ]);

  const stream = new ReadableStream({
    async start(controller) {
      // 1. 连接确认
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ projectId: id })}\n\n`)
      );

      // 2. 立即推送当前状态快照（用户切换回来时不用等下一个事件）
      if (project) {
        controller.enqueue(
          encoder.encode(`event: snapshot\ndata: ${JSON.stringify({
            projectStatus: project.status,
            previewUrl: project.previewUrl,
            runStatus: latestRun?.status ?? null,
            runType: latestRun?.type ?? null,
            error: latestRun?.error ?? null,
          })}\n\n`)
        );
      }

      // 3. 订阅实时事件
      const messageHandler = (receivedChannel: string, message: string) => {
        if (receivedChannel === channel) {
          try {
            const event = JSON.parse(message);
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
            );
          } catch { /* ignore */ }
        }
      };

      subscriber.on("message", messageHandler);
      await subscriber.subscribe(channel);

      request.signal.addEventListener("abort", () => {
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

### 6. 安全性改进

#### 6.1 SSE 鉴权（防止未授权用户窥探他人项目）

```typescript
// 在 SSE route 中加入归属校验
const project = await prisma.project.findUnique({
  where: { id },
  select: { userId: true, status: true, previewUrl: true, title: true },
});

if (!project) {
  return new Response("Not Found", { status: 404 });
}

// TODO: 从 session/JWT 中获取 userId 并校验
// if (project.userId !== currentUserId) {
//   return new Response("Forbidden", { status: 403 });
// }
```

#### 6.2 项目列表接口按用户隔离

当前已按 `DEMO_USER_ID` 过滤，正式上线后替换为从认证中间件获取的真实 userId。

#### 6.3 Redis 连接安全

确保 `REDIS_URL` 环境变量包含密码：
```
redis://:password@host:port
```

Railway 内部网络默认隔离，但加密码是防御纵深。

---

## 用户体验设计

### 项目列表页

用户看到所有项目的状态一览：

```
┌─────────────────────────────────────────────────┐
│  我的项目                                        │
├─────────────────────────────────────────────────┤
│  📦 电商首页        ● 运行中 (Step 12/50)        │
│  📦 博客系统        ◐ 排队中 (第 2 位)           │
│  📦 天气应用        ✓ 已完成  [查看预览]          │
│  📦 Todo App       ✗ 失败    [查看日志]          │
└─────────────────────────────────────────────────┘
```

### 排队位置反馈

当用户的项目在排队时，前端可以通过轮询队列位置给出预估等待时间：

```typescript
// 新增 API：GET /api/projects/:id/queue-position
export async function GET(request: Request, { params }) {
  const { id } = await params;

  const run = await prisma.projectRun.findFirst({
    where: { projectId: id, status: "queued" },
  });

  if (!run) {
    return Response.json({ position: null });
  }

  // 计算前面有多少个 queued 的 job
  const position = await prisma.projectRun.count({
    where: {
      status: "queued",
      createdAt: { lt: run.createdAt },
    },
  });

  return Response.json({
    position: position + 1,
    estimatedWaitSeconds: (position + 1) * 50, // 粗略估算
  });
}
```

---

## 未来扩展路径

| 扩展手段 | 效果 | 成本 | 代码改动 |
|----------|------|------|----------|
| 加第 3 台 Worker | 吞吐 +50% | +$5-7/月 | 零（BullMQ 自动负载均衡） |
| 优先级队列（付费用户优先） | 改善 VIP 体验 | 零 | BullMQ priority 参数 |
| Generate 结果缓存（相似 prompt 复用） | 减少实际 job 数 | 开发成本 | 中等 |
| Worker concurrency=2（需 2GB 内存） | 单机吞吐 ×2 | 需升级规格 | 改一个环境变量 |

---

## 实施优先级

| 优先级 | 任务 | 复杂度 |
|--------|------|--------|
| P0 | Worker concurrency 降为 1 + 加 `--max-old-space-size=768` | 改 2 行 |
| P0 | Per-user 并发限制（3）+ 系统排队上限（20） | ~30 行 |
| P1 | AgentLoop 中途对话压缩 | ~50 行 |
| P1 | SSE 连接时推送状态快照 | ~20 行 |
| P1 | Railway 部署第 2 台 Worker service | 配置操作 |
| P2 | 用户认证（Session/JWT） | 中等工作量 |
| P2 | SSE 鉴权 | ~10 行 |
| P3 | 排队位置反馈 API | ~30 行 |
| P3 | 优先级队列 | ~10 行 |
