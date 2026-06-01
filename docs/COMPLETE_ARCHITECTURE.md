# AI Website Builder - 完整架构实施方案

> **版本**: v2.0  
> **日期**: 2026-06-02  
> **状态**: 设计阶段

本文档整合了沙盒架构、SSE 实时推送、Human-in-the-Loop 和架构补充方案的完整技术设计。

---

## 目录

- [一、架构概览](#一架构概览)
- [二、SSE 实时状态推送](#二sse-实时状态推送)
- [三、Human-in-the-Loop 实现](#三human-in-the-loop-实现)
- [四、E2B Template 设计](#四e2b-template-设计)
- [五、Agent Runtime 实现](#五agent-runtime-实现)
- [六、后端服务改造](#六后端服务改造)
- [七、沙盒复用策略](#七沙盒复用策略)
- [八、文件同步策略](#八文件同步策略)
- [九、监控和日志](#九监控和日志)
- [十、任务终止流程](#十任务终止流程)
- [十一、能力建设](#十一能力建设)
- [十二、实施计划](#十二实施计划)

---

## 一、架构概览

### 1.1 核心理念

**将 Agent Loop 作为沙盒内的一等公民运行，后端服务器只负责调度和事件中转。**

### 1.2 架构对比

#### 当前架构（v6）

```
用户请求 → Next.js API → BullMQ → Worker (Agent Loop 本地执行)
                                      ↓
                                   E2B Sandbox (仅工具执行)
```

**问题**：
- Worker 需维护复杂状态机（queued → running → cancelling → cancelled）
- 并发受限（concurrency: 2）
- 停止机制依赖轮询检查点
- 项目级分布式锁降低并发

#### 新架构（v7 - 完全沙盒化）

```
用户请求 → Next.js API → BullMQ → Dispatcher (轻量调度)
                                      ↓
                                   E2B Sandbox
                                   ├─ Agent Runtime (Node.js)
                                   │  ├─ Loop.ts
                                   │  ├─ Tools.ts
                                   │  └─ LLM Client
                                   └─ User Project (React + Vite)
                                      ↓
                                   Redis Pub/Sub (事件推送)
                                      ↓
                                   Next.js SSE Endpoint → 前端
```

**优势**：
- ✅ 并发度：2 → 50+（25 倍提升）
- ✅ 停止延迟：5-10 秒 → 立即（沙盒 kill）
- ✅ 状态机复杂度：-60%
- ✅ 进程级隔离，互不影响
- ✅ 水平扩展沙盒，无需扩展 Worker

#### 为什么需要 BullMQ + Dispatcher？

**核心问题**：既然 Agent Loop 已经在沙盒里异步运行，为什么还需要 MQ 和 Dispatcher？

**方案对比**：

| 方案 | API 响应时间 | 可靠性 | 并发控制 | 沙盒管理 | 停止功能 |
|------|------------|--------|---------|---------|---------|
| **直接调用沙盒** | 2-5秒（阻塞） | ❌ 重启丢失 | ❌ 无控制 | ❌ 无复用 | ❌ 难实现 |
| **MQ + Dispatcher** | 200ms | ✅ 持久化 | ✅ 50并发 | ✅ 集中管理 | ✅ 通过sandboxId |

**BullMQ 的价值**：
1. **可靠性**：任务持久化到 Redis，服务器重启不丢失
2. **用户体验**：API 立即返回（200ms），不阻塞
3. **并发控制**：`concurrency: 50` 控制最大并发数，避免成本爆炸
4. **监控**：Bull Board 提供实时队列监控
5. **重试**：失败自动重试（可配置）
6. **扩展性**：可以部署多个 Worker 实例水平扩展

**Dispatcher 的价值**：
1. **职责分离**：Worker 只负责调度（3秒），不阻塞等待沙盒完成（60秒）
2. **沙盒会话管理**：集中管理沙盒复用逻辑，跨 Worker 共享
3. **异步监听**：监听沙盒退出事件，负责清理资源
4. **停止功能**：保存 sandboxId，支持用户主动停止

**简化后的 Dispatcher（50 行核心代码）**：

```typescript
export async function dispatchRun(runId: string, projectId: string) {
  // 1. 获取或创建沙盒（自动复用）
  const { sandbox, isReused } = await sandboxSessionManager.acquireForProject(projectId);
  
  // 2. 启动 Agent Runtime（不等待完成）
  const process = await sandbox.process.start({
    cmd: `node /agent-runtime/dist/main.js --runId=${runId} --projectId=${projectId}`,
  });
  
  // 3. 异步监听退出（清理沙盒）
  process.on('exit', async (exitCode) => {
    if (exitCode !== 0) {
      await sandboxSessionManager.terminateSession(projectId);
    }
  });
  
  // 4. 保存 sandboxId（用于停止功能）
  await prisma.projectRun.update({
    where: { id: runId },
    data: { sandboxId: sandbox.sandboxId },
  });
}
```

**实际场景分析**：

假设 100 个用户同时发起请求：

- **方案 A（MQ + Dispatcher）**：
  - API 立即返回（200ms × 100 = 20秒）
  - BullMQ 排队，Worker 并发处理 50 个
  - 成本可控，用户体验好

- **方案 B（直接调用）**：
  - API 阻塞等待沙盒创建（3秒 × 100 = 300秒）
  - 可能创建 100 个沙盒，成本爆炸
  - 用户等待 5 分钟，体验极差

**结论**：BullMQ + Dispatcher 是保证**可靠性、用户体验、成本控制**的关键架构

### 1.3 关键指标对比

| 指标 | 当前架构 | 新架构 | 提升 |
|------|---------|--------|------|
| 最大并发数 | 2 | 50+ | 25x |
| 停止响应时间 | 5-10s | <1s | 10x |
| 沙盒启动时间 | 15-30s | 2-5s | 6x |
| 多轮对话成本 | $0.05 | $0.02 | 60% |
| 代码复杂度 | 高 | 中 | -40% |

---

## 二、SSE 实时状态推送

### 2.1 架构方案：用户级频道

#### 核心理念

**使用用户级 Redis 频道，单个 SSE 连接自动接收用户所有项目的实时事件**

#### 方案对比

| 方案 | HTTP 连接数 | Redis 订阅数 | 项目增减 | 资源占用 | 适用场景 |
|------|-----------|------------|---------|---------|---------|
| **多连接单频道** | N（项目数） | N | 需重建连接 | 高 | 单项目详情页 |
| **单连接多频道** | 1 | N | 需重建连接 | 中 | 固定项目列表 |
| **用户级频道** ⭐ | 1 | 1 | 无需重建 | 低 | Dashboard、多项目并发 |

**结论**：用户级频道最适合多项目并发场景，单连接自动接收所有项目事件。

#### 完整数据流

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 用户打开 Dashboard                                         │
├─────────────────────────────────────────────────────────────┤
│ 前端：GET /api/stream/user                                   │
│ 前端：GET /api/projects/states (获取初始状态)                 │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Next.js 订阅用户级 Redis 频道                              │
├─────────────────────────────────────────────────────────────┤
│ await subscriber.subscribe('user:alice:events')             │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. 用户启动多个项目                                            │
├─────────────────────────────────────────────────────────────┤
│ 项目 A：POST /api/projects/A/generate                        │
│ 项目 B：POST /api/projects/B/generate                        │
│ 项目 C：POST /api/projects/C/iterate                         │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Dispatcher 启动沙盒（传入 userId）                          │
├─────────────────────────────────────────────────────────────┤
│ sandbox.process.start({                                      │
│   cmd: 'node /agent-runtime/dist/main.js',                  │
│   envVars: {                                                 │
│     USER_ID: 'alice',      // 关键：传入用户 ID               │
│     PROJECT_ID: 'proj-A',                                    │
│     RUN_ID: 'run-123',                                       │
│     REDIS_URL: '...',                                        │
│   }                                                          │
│ })                                                           │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. 沙盒内 Agent Runtime 初始化                                │
├─────────────────────────────────────────────────────────────┤
│ const eventEmitter = new EventEmitter({                     │
│   redisUrl: process.env.REDIS_URL,                          │
│   userId: process.env.USER_ID,                              │
│   projectId: process.env.PROJECT_ID,                        │
│   runId: process.env.RUN_ID,                                │
│ });                                                          │
│                                                              │
│ // EventEmitter 连接到 Redis (TCP)                           │
│ this.redis = new Redis(redisUrl);                           │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Agent Loop 执行并发送事件                                  │
├─────────────────────────────────────────────────────────────┤
│ await eventEmitter.emit({                                    │
│   type: 'tool_call_start',                                   │
│   data: { tool: 'write_file', args: {...} },                │
│ });                                                          │
│                                                              │
│ // 内部实现：同时发布到两个频道                                 │
│ const event = {                                              │
│   projectId: 'proj-A',  // 标记项目 ID                       │
│   userId: 'alice',                                           │
│   type: 'tool_call_start',                                   │
│   data: {...},                                               │
│   timestamp: Date.now(),                                     │
│ };                                                           │
│                                                              │
│ await Promise.all([                                          │
│   redis.publish('project:proj-A:events', JSON.stringify(event)), │
│   redis.publish('user:alice:events', JSON.stringify(event)),     │
│ ]);                                                          │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 7. Redis Pub/Sub 推送                                        │
├─────────────────────────────────────────────────────────────┤
│ Redis 将消息推送给订阅了 'user:alice:events' 的所有客户端      │
│ （延迟 < 10ms）                                               │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 8. Next.js SSE Endpoint 接收并转发                            │
├─────────────────────────────────────────────────────────────┤
│ subscriber.on('message', (channel, message) => {            │
│   const event = JSON.parse(message);                        │
│   // event.projectId = 'proj-A'                             │
│   const sseMessage = formatSSE(event);                      │
│   controller.enqueue(encoder.encode(sseMessage));           │
│ });                                                          │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 9. 前端 EventSource 接收（HTTP SSE）                          │
├─────────────────────────────────────────────────────────────┤
│ eventSource.addEventListener('message', (e) => {            │
│   const event = JSON.parse(e.data);                         │
│   const { projectId, type, data } = event;                  │
│                                                              │
│   // 根据 projectId 分发到对应项目                            │
│   setProjectStates(prev => ({                               │
│     ...prev,                                                │
│     [projectId]: {                                          │
│       ...prev[projectId],                                   │
│       lastEvent: event,                                     │
│       status: data.status,                                  │
│     },                                                       │
│   }));                                                       │
│ });                                                          │
└─────────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────────┐
│ 10. React 更新 UI                                            │
├─────────────────────────────────────────────────────────────┤
│ 项目 A 卡片：显示 "正在写入文件..."                            │
│ 项目 B 卡片：显示 "正在调用 LLM..."                           │
│ 项目 C 卡片：显示 "已完成"                                    │
└─────────────────────────────────────────────────────────────┘
```

#### 网络连接拓扑

```
E2B Sandbox (沙盒内)
  ↓ TCP 连接 (ioredis)
Redis Server (Railway/Upstash)
  ↓ TCP 连接 (ioredis)
Next.js Server (订阅者)
  ↓ HTTP SSE (长连接)
浏览器 (EventSource API)
```

#### 关键问题：已完成项目会发送事件吗？

**答案：不会，只有正在运行的项目才发送事件**

```
用户有 4 个项目：
- 项目 A：已完成（沙盒已销毁）→ 不发送事件 ✅
- 项目 B：已完成（沙盒已销毁）→ 不发送事件 ✅
- 项目 C：正在运行（沙盒活跃）→ 发送事件 ✅
- 项目 D：正在运行（沙盒活跃）→ 发送事件 ✅

结论：
- 无信息冗余：只有活跃沙盒发送事件
- 无带宽浪费：Redis Pub/Sub 不存储历史消息
- 用户只接收正在运行项目的实时事件
```

#### 混合模式：初始状态 + 实时更新

**问题**：用户打开 Dashboard 时，如何显示已完成项目的状态？

**解决方案**：HTTP 请求获取初始状态 + SSE 接收实时更新

```typescript
// 前端：src/hooks/use-projects-with-stream.ts

export function useProjectsWithStream() {
  const [projectStates, setProjectStates] = useState<Record<string, ProjectState>>({});
  
  useEffect(() => {
    // 1. 首次加载：HTTP 请求获取所有项目的当前状态
    async function loadInitialStates() {
      const response = await fetch('/api/projects/states');
      const states = await response.json();
      
      // states = {
      //   'proj-A': { status: 'succeeded', previewUrl: '...', finishedAt: '...' },
      //   'proj-B': { status: 'succeeded', previewUrl: '...', finishedAt: '...' },
      //   'proj-C': { status: 'running', currentStep: 5 },
      //   'proj-D': { status: 'running', currentStep: 3 },
      // }
      
      setProjectStates(states);
    }
    
    loadInitialStates();
    
    // 2. 建立 SSE 连接，接收实时更新（只有正在运行的项目）
    const eventSource = new EventSource('/api/stream/user');
    
    eventSource.addEventListener('message', (e) => {
      const event: AgentEvent = JSON.parse(e.data);
      const { projectId, type, data } = event;
      
      // 实时更新正在运行的项目状态
      setProjectStates(prev => ({
        ...prev,
        [projectId]: {
          ...prev[projectId],
          ...data,
          lastUpdate: Date.now(),
        },
      }));
    });
    
    return () => eventSource.close();
  }, []);
  
  return projectStates;
}
```

### 2.2 为什么选择 SSE？

| 方案 | 优势 | 劣势 | 适用场景 |
|------|------|------|---------|
| **SSE** | 简单、自动重连、单向推送 | 只支持文本、单向 | ✅ 状态推送 |
| WebSocket | 双向通信、二进制支持 | 复杂、需要维护连接 | 实时聊天 |
| 轮询 | 简单 | 延迟高、浪费资源 | 低频更新 |

**结论**：SSE 最适合 Agent 状态推送场景（单向、高频、文本）

### 2.3 用户级 SSE Endpoint 实现

```typescript
// src/app/api/stream/user/route.ts

import { redis } from '@/lib/redis';
import { getCurrentUserId } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // 从 session/token 获取当前用户 ID
  const userId = await getCurrentUserId(request);
  
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 创建 Redis 订阅者
      const subscriber = redis.duplicate();
      const channel = `user:${userId}:events`;
      
      // 订阅用户级频道
      await subscriber.subscribe(channel);
      
      console.log(`[SSE] User stream connected | user=${userId.slice(0, 8)}`);
      
      // 发送初始连接消息
      const connectMessage = formatSSE({
        type: 'connected',
        data: { userId, timestamp: Date.now() },
      });
      controller.enqueue(encoder.encode(connectMessage));
      
      // 监听 Redis 消息
      subscriber.on('message', (ch, message) => {
        if (ch === channel) {
          try {
            const event = JSON.parse(message);
            // 事件中包含 projectId，前端可以根据 projectId 分发
            const sseMessage = formatSSE(event);
            controller.enqueue(encoder.encode(sseMessage));
          } catch (error) {
            console.error('[SSE] Failed to parse message:', error);
          }
        }
      });
      
      // 心跳（每 30 秒）
      const heartbeatInterval = setInterval(() => {
        const heartbeat = formatSSE({
          type: 'heartbeat',
          data: { timestamp: Date.now() },
        });
        controller.enqueue(encoder.encode(heartbeat));
      }, 30000);
      
      // 清理函数
      request.signal.addEventListener('abort', async () => {
        console.log(`[SSE] User stream disconnected | user=${userId.slice(0, 8)}`);
        clearInterval(heartbeatInterval);
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
        controller.close();
      });
    },
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    },
  });
}

function formatSSE(event: any): string {
  const lines: string[] = [];
  if (event.type) {
    lines.push(`event: ${event.type}`);
  }
  const data = JSON.stringify(event);
  lines.push(`data: ${data}`);
  lines.push('');
  lines.push('');
  return lines.join('\n');
}
```

### 2.4 获取初始状态 API

```typescript
// src/app/api/projects/states/route.ts

import { prisma } from '@/lib/prisma';
import { getCurrentUserId } from '@/lib/auth';

export async function GET(request: Request) {
  const userId = await getCurrentUserId(request);
  
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  // 查询用户的所有项目
  const projects = await prisma.project.findMany({
    where: { userId },
    include: {
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 1, // 最新的 run
      },
    },
  });
  
  // 构建状态对象
  const states: Record<string, ProjectState> = {};
  
  for (const project of projects) {
    const latestRun = project.runs[0];
    
    states[project.id] = {
      status: latestRun?.status || 'idle',
      previewUrl: project.previewUrl,
      currentStep: latestRun?.status === 'running' ? latestRun.currentStep : undefined,
      finishedAt: latestRun?.finishedAt,
      error: latestRun?.error,
    };
  }
  
  return Response.json(states);
}
```

### 2.5 沙盒内 EventEmitter 实现

```typescript
// agent-runtime/src/event-emitter.ts

import { Redis } from 'ioredis';

export interface EventEmitterConfig {
  redisUrl: string;
  userId: string;
  projectId: string;
  runId: string;
}

export class EventEmitter {
  private redis: Redis;
  private userId: string;
  private projectId: string;
  private runId: string;
  
  constructor(config: EventEmitterConfig) {
    this.redis = new Redis(config.redisUrl);
    this.userId = config.userId;
    this.projectId = config.projectId;
    this.runId = config.runId;
  }
  
  private async emit(event: Partial<AgentEvent>) {
    const fullEvent: AgentEvent = {
      ...event,
      projectId: this.projectId,
      userId: this.userId,
      runId: this.runId,
      timestamp: Date.now(),
    } as AgentEvent;
    
    const message = JSON.stringify(fullEvent);
    
    // 同时发布到两个频道
    await Promise.all([
      // 1. 项目频道（用于单项目订阅）
      this.redis.publish(`project:${this.projectId}:events`, message),
      
      // 2. 用户频道（用于多项目订阅）
      this.redis.publish(`user:${this.userId}:events`, message),
    ]);
  }
  
  async emitStatusChange(status: AgentStatus) {
    await this.emit({
      type: 'agent_status_change',
      data: { status },
    });
  }
  
  async emitStepStart(step: number) {
    await this.emit({
      type: 'agent_step_start',
      data: { step },
    });
  }
  
  async emitToolCall(tool: string, args: any) {
    await this.emit({
      type: 'tool_call_start',
      data: { tool, args },
    });
  }
  
  async emitToolCallComplete(tool: string, success: boolean, result?: any) {
    await this.emit({
      type: 'tool_call_complete',
      data: { tool, success, result },
    });
  }
  
  async close() {
    await this.redis.quit();
  }
}
```

### 2.6 Dispatcher 传递 userId

```typescript
// src/lib/dispatcher.ts

export async function dispatchRun(runId: string, projectId: string) {
  // 获取项目的 userId
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  });
  
  if (!project) throw new Error('Project not found');
  
  const { sandbox } = await sandboxSessionManager.acquireForProject(projectId);
  
  await sandbox.process.start({
    cmd: `node /agent-runtime/dist/main.js --runId=${runId} --projectId=${projectId}`,
    envVars: {
      USER_ID: project.userId,  // 传入 userId
      REDIS_URL: process.env.REDIS_URL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  });
  
  // 保存 sandboxId
  await prisma.projectRun.update({
    where: { id: runId },
    data: { sandboxId: sandbox.sandboxId },
  });
}
```

### 2.7 前端多项目 Hook

```typescript
// src/hooks/use-user-stream.ts

import { useEffect, useState } from 'react';
import type { AgentEvent } from '@/types/agent';

export interface ProjectState {
  status?: string;
  currentStep?: number;
  currentTool?: string;
  previewUrl?: string;
  events?: AgentEvent[];
  lastUpdate?: number;
  finishedAt?: string;
  error?: string;
}

export function useUserStream() {
  const [projectStates, setProjectStates] = useState<Record<string, ProjectState>>({});
  const [isConnected, setIsConnected] = useState(false);
  
  useEffect(() => {
    // 1. 加载初始状态
    async function loadInitialStates() {
      try {
        const response = await fetch('/api/projects/states');
        if (response.ok) {
          const states = await response.json();
          setProjectStates(states);
        }
      } catch (error) {
        console.error('[Stream] Failed to load initial states:', error);
      }
    }
    
    loadInitialStates();
    
    // 2. 建立 SSE 连接
    const eventSource = new EventSource('/api/stream/user');
    
    eventSource.onopen = () => {
      setIsConnected(true);
      console.log('[Stream] User stream connected');
    };
    
    eventSource.addEventListener('message', (e) => {
      const event: AgentEvent = JSON.parse(e.data);
      const { projectId, type, data } = event;
      
      setProjectStates(prev => {
        const projectState = prev[projectId] || {};
        
        // 根据事件类型更新状态
        switch (type) {
          case 'agent_status_change':
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                status: data.status,
                lastUpdate: Date.now(),
              },
            };
            
          case 'tool_call_start':
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                currentTool: data.tool,
                events: [...(projectState.events || []), event].slice(-100),
                lastUpdate: Date.now(),
              },
            };
            
          case 'preview_ready':
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                previewUrl: data.previewUrl,
                lastUpdate: Date.now(),
              },
            };
            
          default:
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                events: [...(projectState.events || []), event].slice(-100),
                lastUpdate: Date.now(),
              },
            };
        }
      });
    });
    
    eventSource.onerror = () => {
      setIsConnected(false);
      console.error('[Stream] User stream error');
    };
    
    return () => eventSource.close();
  }, []);
  
  return { projectStates, isConnected };
}
```

### 2.8 Dashboard 使用示例

```typescript
// src/app/dashboard/page.tsx

import { useUserStream } from '@/hooks/use-user-stream';
import { useQuery } from '@tanstack/react-query';

export default function Dashboard() {
  const { projectStates, isConnected } = useUserStream();
  const { data: projects } = useQuery({
    queryKey: ['user-projects'],
    queryFn: () => fetch('/api/projects').then(r => r.json()),
  });
  
  return (
    <div className="container mx-auto p-4">
      {/* 连接状态 */}
      <div className="mb-4">
        <Badge variant={isConnected ? 'success' : 'destructive'}>
          {isConnected ? '实时连接' : '未连接'}
        </Badge>
      </div>
      
      {/* 项目列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects?.map((project: Project) => (
          <ProjectCard
            key={project.id}
            project={project}
            state={projectStates[project.id]}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ project, state }: { project: Project; state?: ProjectState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        <CardDescription>
          {state?.status && <StatusBadge status={state.status} />}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state?.currentTool && (
          <div className="text-sm text-muted-foreground">
            正在执行: {state.currentTool}
          </div>
        )}
        {state?.previewUrl && (
          <Button asChild>
            <a href={state.previewUrl} target="_blank">查看预览</a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

### 2.9 事件消息格式

```typescript
// 事件消息结构
interface AgentEvent {
  // 标识信息
  projectId: string;    // 'proj-A'
  userId: string;       // 'alice'
  runId: string;        // 'run-123'
  
  // 事件信息
  type: string;         // 'tool_call_start'
  data: any;            // { tool: 'write_file', args: {...} }
  
  // 元数据
  timestamp: number;    // 1234567890
  step?: number;        // 5
}

// SSE 格式示例
event: tool_call_start
data: {"projectId":"proj-A","userId":"alice","type":"tool_call_start","data":{"tool":"write_file"},"timestamp":1234567890}

```

### 2.10 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| 端到端延迟 | < 100ms | 沙盒发送 → 前端接收 |
| Redis Pub/Sub 延迟 | < 10ms | 发布 → 订阅者接收 |
| SSE 推送延迟 | < 50ms | Next.js → 浏览器 |
| 并发连接数 | 10,000+ | 单个 Redis 支持 |
| 内存占用 | ~1MB/连接 | SSE 连接 |
| CPU 占用 | < 1% | 事件推送 |

### 2.11 单项目详情页实现（可选）

```typescript
// src/app/api/projects/[id]/stream/route.ts

import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  
  // 验证项目存在
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return new Response('Project not found', { status: 404 });
  }
  
  // 创建 SSE 流
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 订阅 Redis 频道
      const subscriber = redis.duplicate();
      const channel = `project:${projectId}:events`;
      
      await subscriber.subscribe(channel);
      
      console.log(`[SSE] Client connected | project=${projectId.slice(0, 8)}`);
      
      // 发送初始连接消息
      const connectMessage = formatSSE({
        type: 'connected',
        data: { projectId, timestamp: Date.now() },
      });
      controller.enqueue(encoder.encode(connectMessage));
      
      // 监听 Redis 消息
      subscriber.on('message', (ch, message) => {
        if (ch === channel) {
          try {
            const event = JSON.parse(message);
            const sseMessage = formatSSE(event);
            controller.enqueue(encoder.encode(sseMessage));
          } catch (error) {
            console.error('[SSE] Failed to parse message:', error);
          }
        }
      });
      
      // 心跳（每 30 秒）
      const heartbeatInterval = setInterval(() => {
        const heartbeat = formatSSE({
          type: 'heartbeat',
          data: { timestamp: Date.now() },
        });
        controller.enqueue(encoder.encode(heartbeat));
      }, 30000);
      
      // 清理函数
      request.signal.addEventListener('abort', async () => {
        console.log(`[SSE] Client disconnected | project=${projectId.slice(0, 8)}`);
        clearInterval(heartbeatInterval);
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
        controller.close();
      });
    },
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲
    },
  });
}

function formatSSE(event: any): string {
  const lines: string[] = [];
  if (event.type) {
    lines.push(`event: ${event.type}`);
  }
  const data = JSON.stringify(event);
  lines.push(`data: ${data}`);
  lines.push('');
  lines.push('');
  return lines.join('\n');
}
```

### 2.4 前端 SSE Hook

```typescript
// src/hooks/use-agent-stream.ts

import { useEffect, useState, useRef } from 'react';
import type { AgentEvent, AgentStatus } from '@/types/agent';

export function useAgentStream(projectId: string) {
  const [status, setStatus] = useState<AgentStatus>('INITIALIZING');
  const [currentStep, setCurrentStep] = useState(0);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastHeartbeat, setLastHeartbeat] = useState(Date.now());
  
  const eventSourceRef = useRef<EventSource | null>(null);
  
  useEffect(() => {
    const eventSource = new EventSource(`/api/projects/${projectId}/stream`);
    eventSourceRef.current = eventSource;
    
    eventSource.addEventListener('connected', (e) => {
      console.log('[SSE] Connected', e.data);
      setIsConnected(true);
    });
    
    eventSource.addEventListener('heartbeat', (e) => {
      setLastHeartbeat(Date.now());
    });
    
    eventSource.addEventListener('agent_status_change', (e) => {
      const event: AgentEvent = JSON.parse(e.data);
      setStatus(event.data.status);
      setEvents(prev => [...prev, event].slice(-100));
    });
    
    eventSource.addEventListener('agent_step_start', (e) => {
      const event: AgentEvent = JSON.parse(e.data);
      setCurrentStep(event.data.step);
      setEvents(prev => [...prev, event].slice(-100));
    });
    
    eventSource.addEventListener('tool_call_start', (e) => {
      const event: AgentEvent = JSON.parse(e.data);
      setEvents(prev => [...prev, event].slice(-100));
    });
    
    eventSource.onerror = (error) => {
      console.error('[SSE] Connection error:', error);
      setIsConnected(false);
    };
    
    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [projectId]);
  
  return {
    status,
    currentStep,
    events,
    isConnected,
    lastHeartbeat,
  };
}
```

---

## 三、Human-in-the-Loop 实现

### 3.1 设计理念：克制的交互

**核心原则**：尽量减少对用户的打断，只在真正需要时才提问。

#### 克制原则

1. **提问次数限制**：每个 Run 最多 3 次提问，避免频繁打断
2. **智能判断**：Agent 应尽量自主决策，只在关键分歧点提问
3. **非阻塞 UI**：问题以通知形式出现，不强制打断用户当前操作
4. **超时自动处理**：30 分钟无响应自动暂停，支持快速恢复
5. **防重复提交**：前端防抖 + 后端幂等性，避免双击问题

#### 适合提问的场景

✅ **应该提问**：
- 关键功能取舍（需要登录功能吗？）
- 不明确的需求（首页应该展示什么内容？）

❌ **不应该提问**：
- 代码实现细节（用 useState 还是 useReducer？）
- 文件命名（组件叫 Button 还是 Btn？）
- 样式调整（padding 用 16px 还是 20px？）

### 3.2 简化架构：无需沙盒退出

**核心决策**：沙盒保持运行，使用 Redis 阻塞等待用户答案。

#### 为什么不退出沙盒？

| 维度 | 退出沙盒 | 保持运行（推荐） |
|------|---------|----------------|
| 资源成本 | 节省（但重启成本高） | 低（空闲时 CPU 接近 0） |
| 恢复延迟 | 2-5 秒 | 0 秒（即时） |
| 状态管理 | 需要 LoopState 数据库表 | 无需（内存保持） |
| 实现复杂度 | 高（持久化 + 恢复逻辑） | 低（Redis BRPOP） |
| 用户体验 | 差（重启打断） | 好（无感恢复） |

**结论**：保持沙盒运行，符合"克制、不打断"的设计理念。

### 3.3 状态机

```
running
  ↓ (调用 ask_user 工具)
waiting_for_user (沙盒保持运行，Redis BRPOP 阻塞等待)
  ↓ (用户回答 → Redis LPUSH)
running (立即恢复，无需重启)
  ↓ (继续执行)
succeeded / failed
```

### 3.4 数据模型

**无需 LoopState 表**，只需更新 ProjectRun 状态：

```prisma
// prisma/schema.prisma

enum ProjectRunStatus {
  queued
  running
  paused           // 新增：等待用户回答或超时暂停
  succeeded
  failed
  cancelled
}

model ProjectRun {
  // ... 现有字段
  
  status          ProjectRunStatus @default(queued)
  currentAskCount Int?             @default(0)  // 当前提问序号（用于防冲突）
  pausedAt        DateTime?                     // 暂停时间
  pauseReason     String?                       // 暂停原因：'user_input' | 'timeout'
}
```

**Redis 键设计**：

```typescript
// 答案队列（用户提交答案后推入）
// 🔑 关键：包含 askCount，避免多次提问时 Key 冲突
`loop:${runId}:answer:${askCount}`  // TTL: 60 秒（Agent 立即消费）

// 恢复快照（超时前保存，用于恢复）
`loop:${runId}:snapshot`  // TTL: 24 小时
```

### 3.5 ask_user 工具实现

```typescript
// agent-runtime/src/tools.ts

case 'ask_user': {
  const { question, options } = args as {
    question: string;
    options: Array<{ label: string; description: string; value: string }>;
  };
  
  // 检查提问次数限制
  if (toolContext.askUserCount >= 3) {
    return {
      success: false,
      output: '系统限制：已达到最大提问次数（3 次），请自行判断',
    };
  }
  
  toolContext.askUserCount++;
  
  // 🔑 构造带序号的 Key（避免多次提问冲突）
  const answerKey = `loop:${toolContext.runId}:answer:${toolContext.askUserCount}`;
  
  // 推送问题到前端（包含 askCount）
  await toolContext.eventEmitter.emit({
    type: 'HITL_QUESTION',
    data: { 
      question, 
      options,
      askCount: toolContext.askUserCount, // 🔑 传递序号
    },
  });
  
  // 更新 Run 状态为 paused
  await fetch(`${process.env.API_BASE_URL}/api/runs/${toolContext.runId}/pause`, {
    method: 'POST',
    body: JSON.stringify({ 
      reason: 'user_input',
      askCount: toolContext.askUserCount, // 🔑 保存到数据库
    }),
  });
  
  toolContext.logger.info('Waiting for user answer...', { 
    question,
    askCount: toolContext.askUserCount,
  });
  
  // 🔑 阻塞等待用户答案（30 分钟超时）
  const result = await redis.brpop(answerKey, 1800);
  
  if (!result) {
    // 超时：保存快照
    await this.saveSnapshot();
    
    // 通知后端超时
    await fetch(`${process.env.API_BASE_URL}/api/runs/${toolContext.runId}/timeout`, {
      method: 'POST',
    });
    
    throw new TimeoutError('User did not respond within 30 minutes');
  }
  
  const answer = result[1]; // BRPOP 返回 [key, value]
  
  toolContext.logger.info('User answered', { answer });
  
  // 恢复 running 状态
  await fetch(`${process.env.API_BASE_URL}/api/runs/${toolContext.runId}/resume`, {
    method: 'POST',
  });
  
  return {
    success: true,
    output: answer,
  };
}
```
    success: true,
    output: answer,
  };
}
```

### 3.6 快照保存（用于超时恢复）

```typescript
// agent-runtime/src/loop.ts

async saveSnapshot() {
  const snapshot = {
    question: this.currentQuestion,
    conversationHistory: this.messages,
    currentStep: this.currentStep,
    fileStates: await this.getModifiedFiles(),
    askUserCount: this.askUserCount,
    timestamp: Date.now(),
  };
  
  await redis.setex(
    `loop:${this.runId}:snapshot`,
    86400, // 24 小时过期
    JSON.stringify(snapshot)
  );
  
  this.logger.info('Snapshot saved for recovery', { 
    snapshotSize: JSON.stringify(snapshot).length 
  });
}

async loadSnapshot(): Promise<Snapshot | null> {
  const data = await redis.get(`loop:${this.runId}:snapshot`);
  if (!data) return null;
  
  return JSON.parse(data);
}
```

### 3.7 提交答案 API（防双击核心实现）

```typescript
// src/app/api/runs/[runId]/answer/route.ts

import { redis } from '@/lib/redis';
import { prisma } from '@/lib/prisma';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const { answer, askCount } = await req.json(); // 🔑 接收 askCount
  
  // 1. 验证 Run 状态
  const run = await prisma.projectRun.findUnique({
    where: { id: runId },
  });
  
  if (!run || run.status !== 'paused') {
    return Response.json({ 
      error: 'Run is not waiting for answer' 
    }, { status: 400 });
  }
  
  // 🔑 2. 验证 askCount 是否匹配（防止回答错误的问题）
  if (askCount !== run.currentAskCount) {
    return Response.json({ 
      error: 'Invalid askCount, question may have changed',
      expectedAskCount: run.currentAskCount,
    }, { status: 409 });
  }
  
  // 🔑 3. 构造带序号的 Key
  const answerKey = `loop:${runId}:answer:${askCount}`;
  
  // 🔒 4. 原子性防双击：使用 SET NX（只在 key 不存在时设置）
  const result = await redis.set(
    answerKey,
    answer,
    'EX', 60,  // 60 秒过期（Agent 会立即消费）
    'NX'       // 只在不存在时设置
  );
  
  if (result === null) {
    // Key 已存在，说明已经提交过
    return Response.json({ 
      success: true,
      message: 'Answer already submitted',
      alreadyAnswered: true,
    });
  }
  
  // 🔑 5. 推送答案到队列（Agent 正在 BRPOP 等待）
  await redis.lpush(answerKey, answer);
  
  console.log(`[Answer] User answered | runId=${runId.slice(0, 8)} | askCount=${askCount} | answer=${answer}`);
  
  return Response.json({ success: true });
}
```

**防双击机制说明**：

| 防护层 | 技术手段 | 防护场景 |
|--------|---------|---------|
| **前端** | `isSubmitting` 状态 | 同标签页快速双击 |
| **后端** | Redis `SET NX` 原子操作 | 多标签页、前端失效、恶意请求 |
| **队列** | `BRPOP` 单次消费 | 所有场景兜底 |
| **askCount** | 数据库序号验证 | 防止回答错误的问题 |

**为什么使用 `SET NX` 而不是 `EXISTS + LPUSH`？**

```typescript
// ❌ 不推荐：EXISTS + LPUSH（有并发问题）
const exists = await redis.exists(answerKey);
if (exists) return; // 🚨 问题：两个请求可能同时通过检查
await redis.lpush(answerKey, answer);

// ✅ 推荐：SET NX（原子操作）
const result = await redis.set(answerKey, answer, 'EX', 60, 'NX');
// Redis 单线程模型保证原子性，即使极端并发也只有一个成功
```

### 3.8 超时处理 API

```typescript
// src/app/api/runs/[runId]/timeout/route.ts

export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  
  await prisma.projectRun.update({
    where: { id: runId },
    data: { 
      status: 'paused',
      pausedAt: new Date(),
      pauseReason: 'User response timeout',
    },
  });
  
  // 获取项目信息
  const run = await prisma.projectRun.findUnique({
    where: { id: runId },
    include: { project: true },
  });
  
  // 发布暂停事件到前端
  await redis.publish(`user:${run.project.userId}:events`, JSON.stringify({
    type: 'RUN_PAUSED',
    projectId: run.projectId,
    runId,
    data: {
      reason: 'timeout',
      canResume: true,
      message: '任务已暂停（超时），点击"恢复"按钮继续',
    },
    timestamp: Date.now(),
  }));
  
  return Response.json({ success: true });
}
```

### 3.9 恢复任务 API

```typescript
// src/app/api/runs/[runId]/resume/route.ts

export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  
  // 检查快照是否存在
  const snapshotKey = `loop:${runId}:snapshot`;
  const snapshot = await redis.get(snapshotKey);
  
  if (!snapshot) {
    return Response.json({ 
      error: 'Snapshot expired (24h), cannot resume. Please start a new run.' 
    }, { status: 410 });
  }
  
  const run = await prisma.projectRun.findUnique({
    where: { id: runId },
  });
  
  if (!run || run.status !== 'paused') {
    return Response.json({ 
      error: 'Run is not paused' 
    }, { status: 400 });
  }
  
  // 更新 Run 状态
  await prisma.projectRun.update({
    where: { id: runId },
    data: { 
      status: 'running',
      pausedAt: null,
      pauseReason: null,
    },
  });
  
  // 重新调度任务（通过 BullMQ）
  await taskQueue.add('resume-run', {
    runId,
    projectId: run.projectId,
    snapshot,
  });
  
  return Response.json({ success: true });
}
```

### 3.10 Dispatcher：从快照恢复

```typescript
// src/lib/dispatcher.ts

export async function dispatchResumeRun(
  runId: string, 
  projectId: string, 
  snapshot: string
) {
  const { sandbox } = await sandboxSessionManager.acquireForProject(projectId);
  
  // 启动 Agent，传入恢复参数
  const process = await sandbox.process.start({
    cmd: `node /agent-runtime/dist/main.js \
      --runId=${runId} \
      --projectId=${projectId} \
      --resume=true`,
    envVars: {
      RESUME_SNAPSHOT: snapshot,
      REDIS_URL: process.env.REDIS_URL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  });
  
  // 监听进程退出
  process.on('exit', async (exitCode) => {
    if (exitCode !== 0) {
      await sandboxSessionManager.terminateSession(projectId);
    }
  });
}
```

### 3.11 Agent Runtime：恢复逻辑

```typescript
// agent-runtime/src/main.ts

async function main() {
  const args = parseArgs(process.argv);
  const resumeSnapshot = process.env.RESUME_SNAPSHOT;
  
  if (args.resume && resumeSnapshot) {
    const snapshot = JSON.parse(resumeSnapshot);
    
    console.log('[Agent] Resuming from snapshot', {
      step: snapshot.currentStep,
      question: snapshot.question,
    });
    
    // 恢复状态
    loop.messages = snapshot.conversationHistory;
    loop.currentStep = snapshot.currentStep;
    loop.askUserCount = snapshot.askUserCount;
    
    // 重新询问用户（从断点继续）
    const answer = await loop.askUser(snapshot.question, snapshot.options);
    
    // 继续执行后续步骤
    await loop.continueFromStep(snapshot.currentStep, answer);
  } else {
    // 正常启动
    await loop.run();
  }
}

main().catch(console.error);
```

### 3.12 前端问答对话框

```typescript
// src/components/ask-user-dialog.tsx

interface AskUserDialogProps {
  runId: string;
  question: string;
  options: Array<{ label: string; description: string; value: string }>;
  askCount: number; // 🔑 新增：提问序号
  onAnswer: () => void;
}

export function AskUserDialog({
  runId,
  question,
  options,
  askCount, // 🔑 接收序号
  onAnswer,
}: AskUserDialogProps) {
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const handleSubmit = async () => {
    if (!selectedValue || isSubmitting) return; // 🔒 防止双击
    
    setIsSubmitting(true);
    
    try {
      const response = await fetch(`/api/runs/${runId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          answer: selectedValue,
          askCount, // 🔑 传递序号
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        if (result.alreadyAnswered) {
          toast.info('答案已提交过，Agent 正在处理');
        } else {
          toast.success('答案已提交，Agent 继续执行');
        }
        onAnswer();
      } else if (response.status === 409) {
        toast.error('问题已更新，请刷新页面');
      } else {
        toast.error('提交失败，请重试');
      }
    } catch (error) {
      toast.error('网络错误');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  return (
    <Dialog open={true}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent 需要你的帮助 ({askCount}/3)</DialogTitle>
          <DialogDescription>{question}</DialogDescription>
        </DialogHeader>
        
        <RadioGroup value={selectedValue} onValueChange={setSelectedValue}>
          {options.map((option) => (
            <div key={option.value} className="flex items-start space-x-3 p-3 border rounded">
              <RadioGroupItem value={option.value} id={option.value} />
              <Label htmlFor={option.value} className="flex-1 cursor-pointer">
                <div className="font-medium">{option.label}</div>
                <div className="text-sm text-muted-foreground">
                  {option.description}
                </div>
              </Label>
            </div>
          ))}
        </RadioGroup>
        
        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={!selectedValue || isSubmitting}
          >
            {isSubmitting ? '提交中...' : '提交答案'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### 3.13 前端监听 HITL 事件

```typescript
// src/hooks/use-user-stream.ts (扩展)

eventSource.addEventListener('message', (e) => {
  const event: AgentEvent = JSON.parse(e.data);
  const { projectId, type, data } = event;
  
  switch (type) {
    case 'HITL_QUESTION':
      // 🔑 显示问答对话框（包含 askCount）
      setActiveQuestion({
        runId: event.runId,
        projectId,
        question: data.question,
        options: data.options,
        askCount: data.askCount, // 🔑 传递序号
      });
      break;
      
    case 'RUN_PAUSED':
      // 显示恢复按钮
      setProjectStates(prev => ({
        ...prev,
        [projectId]: {
          ...prev[projectId],
          status: 'paused',
          pauseReason: data.reason,
          canResume: data.canResume,
        },
      }));
      
      if (data.reason === 'timeout') {
        toast.info(data.message);
      }
      break;
      
    // ... 其他事件
  }
});
```

### 3.14 恢复按钮组件

```typescript
// src/components/resume-button.tsx

interface ResumeButtonProps {
  runId: string;
  projectId: string;
}

export function ResumeButton({ runId, projectId }: ResumeButtonProps) {
  const [isResuming, setIsResuming] = useState(false);
  
  const handleResume = async () => {
    setIsResuming(true);
    
    try {
      const response = await fetch(`/api/runs/${runId}/resume`, {
        method: 'POST',
      });
      
      const result = await response.json();
      
      if (result.success) {
        toast.success('任务已恢复，Agent 继续执行');
      } else if (response.status === 410) {
        toast.error('快照已过期（24小时），请重新开始任务');
      } else {
        toast.error('恢复失败，请重试');
      }
    } catch (error) {
      toast.error('网络错误');
    } finally {
      setIsResuming(false);
    }
  };
  
  return (
    <Button 
      onClick={handleResume}
      disabled={isResuming}
      variant="outline"
    >
      {isResuming ? '恢复中...' : '恢复任务'}
    </Button>
  );
}
```

### 3.15 用户体验流程

```
用户视角：
1. [Agent 询问] "是否要添加深色模式？"
2. [用户离开 35 分钟]
3. [回来后看到] "任务已暂停（超时）- 点击恢复按钮继续"
4. [点击恢复]
5. [2秒后] Agent 重新出现，继续询问 "是否要添加深色模式？"
6. [用户回答] "是的"
7. [Agent 立即恢复] 从断点继续，无需重跑之前的步骤
```

### 3.16 方案对比总结

| 维度 | 原方案（退出 + LoopState） | 简化方案（阻塞等待） |
|------|--------------------------|---------------------|
| 数据库表 | 需要 LoopState 表 | 不需要 |
| Redis 键 | 需要持久化状态 | 只需临时队列 + 快照 |
| 沙盒操作 | 退出 → 重启 | 保持运行 |
| 恢复延迟 | 2-5 秒 | 0 秒（即时） |
| 代码行数 | ~150 行 | ~80 行 |
| 超时处理 | Cron 清理 LoopState | Redis TTL 自动过期 |
| 超时后恢复 | 需要完整状态恢复 | 轻量级快照恢复 |
| 符合"克制"原则 | 否（重启打断状态） | **是** |

### 3.17 防双击完整流程说明

#### 多次提问场景示例

```
一个 Run 中提问 3 次的完整流程：

T0: Agent 启动，askUserCount = 0

T1: 第 1 次提问（Step 5）
    → askUserCount = 1
    → Redis Key: `loop:run_abc:answer:1`
    → 数据库: currentAskCount = 1
    → Agent 执行 BRPOP(`loop:run_abc:answer:1`, 1800)
    
T2: 用户回答 "是的"
    → 前端发送: { answer: "是的", askCount: 1 }
    → 后端验证: askCount === run.currentAskCount ✅
    → Redis SET NX: `loop:run_abc:answer:1` = "是的" ✅
    → Redis LPUSH: 推送到队列
    → Agent BRPOP 立即返回，Key 被删除
    
T3: Agent 继续执行...

T4: 第 2 次提问（Step 12）
    → askUserCount = 2
    → Redis Key: `loop:run_abc:answer:2`  // ✅ 不同的 Key
    → 数据库: currentAskCount = 2
    → Agent 执行 BRPOP(`loop:run_abc:answer:2`, 1800)
    
T5: 用户回答 "不需要"
    → 前端发送: { answer: "不需要", askCount: 2 }
    → 后端验证: askCount === run.currentAskCount ✅
    → Redis SET NX: `loop:run_abc:answer:2` = "不需要" ✅
    → Agent BRPOP 立即返回，Key 被删除
    
T6: Agent 继续执行...

T7: 第 3 次提问（Step 20）
    → askUserCount = 3
    → Redis Key: `loop:run_abc:answer:3`  // ✅ 又是不同的 Key
    → 数据库: currentAskCount = 3
    → Agent 执行 BRPOP(`loop:run_abc:answer:3`, 1800)
    
T8: 用户回答 "需要"
    → Redis SET NX: `loop:run_abc:answer:3` = "需要" ✅
    → Agent BRPOP 立即返回，Key 被删除
    
T9: Agent 完成任务
```

#### 防双击的四层防护

```typescript
// 第 1 层：前端状态防护
const [isSubmitting, setIsSubmitting] = useState(false);
if (isSubmitting) return; // 阻止同标签页快速双击

// 第 2 层：askCount 验证
if (askCount !== run.currentAskCount) {
  return Response.json({ error: 'Invalid askCount' }, { status: 409 });
}
// 防止回答错误的问题（例如用户打开了旧问题的对话框）

// 第 3 层：Redis SET NX 原子操作
const result = await redis.set(answerKey, answer, 'EX', 60, 'NX');
if (result === null) {
  return Response.json({ alreadyAnswered: true });
}
// 防止多标签页、极端并发、恶意请求

// 第 4 层：BRPOP 单次消费
const result = await redis.brpop(answerKey, 1800);
// 即使多个答案被写入队列，也只取第一个
```

#### 边界情况处理

**情况 1：用户回答了旧问题**

```
场景：
1. Agent 第 1 次提问（askCount=1）
2. 用户打开对话框，但没有立即回答
3. Agent 超时，继续执行，又提了第 2 次问题（askCount=2）
4. 用户回答了第 1 次的问题

处理：
→ 后端检查: run.currentAskCount === 2
→ 用户提交: askCount === 1
→ 返回 409 错误: "问题已更新，请刷新页面"
```

**情况 2：极端并发（两个请求同时到达）**

```
时间轴：
T0.000: 请求 1 和请求 2 同时到达
        runId = "run_abc", askCount = 1
        
T0.001: 请求 1 执行 redis.set(..., 'NX')
        → 返回 "OK"（成功）
        
T0.002: 请求 2 执行 redis.set(..., 'NX')
        → 返回 null（失败，Key 已存在）
        → 返回 alreadyAnswered: true
        
T0.003: 请求 1 执行 redis.lpush(...)
        → Agent BRPOP 取到答案
        
结论：✅ Redis 单线程模型保证原子性，只有一个请求成功
```

#### TTL 设置策略

| Redis Key | TTL | 理由 |
|-----------|-----|------|
| `loop:${runId}:answer:${askCount}` | 60 秒 | Agent BRPOP 会立即消费，60 秒足够处理网络延迟 |
| `loop:${runId}:snapshot` | 24 小时 | 用户可能第二天才回来恢复任务 |

**为什么答案队列只需 60 秒？**

- Agent 正在 BRPOP 阻塞等待，用户提交后立即消费
- BRPOP 消费后 Key 自动删除，TTL 只是兜底保护
- 即使 Agent 崩溃，60 秒后 Key 自动过期，不会污染 Redis

---

## 四、E2B Template 设计

### 4.1 目录结构

```
e2b-template/
├── agent-runtime/              # Agent 运行时（新增）
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main.ts             # 入口
│   │   ├── loop.ts             # Agent Loop 核心
│   │   ├── tools.ts            # 工具执行器
│   │   ├── llm-client.ts       # LLM 调用封装
│   │   ├── event-emitter.ts    # 事件推送
│   │   ├── state-manager.ts    # 状态持久化
│   │   ├── logger.ts           # 日志
│   │   └── types.ts
│   ├── dist/                   # 预编译 JS（加速启动）
│   │   └── main.js
│   └── node_modules/           # 预装依赖
├── user-project/               # 用户项目模板（现有）
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
└── Dockerfile
```

### 4.2 Dockerfile

```dockerfile
FROM node:20-slim

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /agent-runtime

# 复制并安装 agent-runtime 依赖
COPY agent-runtime/package*.json ./
RUN npm ci --production

# 复制源码并预编译
COPY agent-runtime/src ./src
COPY agent-runtime/tsconfig.json ./
RUN npm run build

# 复制用户项目模板
WORKDIR /home/user/app
COPY user-project/package*.json ./
RUN npm ci

COPY user-project/ ./

# 设置工作目录
WORKDIR /home/user

# 默认命令（会被 dispatcher 覆盖）
CMD ["node", "/agent-runtime/dist/main.js"]
```

**预期启动时间**：
- 当前（需要 npm install）：15-30 秒
- 优化后（预装依赖）：2-5 秒

---

## 五、Agent Runtime 实现

### 5.1 入口：main.ts

```typescript
// agent-runtime/src/main.ts

import { agentLoop } from './loop';
import { StateManager } from './state-manager';
import { EventEmitter } from './event-emitter';
import { AxiomLogger } from './logger';

async function main() {
  // 1. 解析启动参数
  const args = parseArgs(process.argv);
  const { runId, projectId, mode, skipFileRestore } = args;
  
  // 2. 初始化组件
  const stateManager = new StateManager({
    databaseUrl: process.env.DATABASE_URL!,
    redisUrl: process.env.REDIS_URL!,
  });
  
  const eventEmitter = new EventEmitter({
    redisUrl: process.env.REDIS_URL!,
    projectId,
    runId,
  });
  
  const logger = new AxiomLogger({
    runId,
    projectId,
    axiomToken: process.env.AXIOM_TOKEN!,
    axiomDataset: 'ai-website-builder',
  });
  
  // 3. 加载上下文
  logger.info('Loading context', { mode, skipFileRestore });
  const context = await stateManager.loadContext(runId, projectId, mode, skipFileRestore);
  
  try {
    // 4. 启动 Agent Loop
    logger.info('Starting Agent Loop');
    const result = await agentLoop({
      runId,
      projectId,
      context,
      stateManager,
      eventEmitter,
      logger,
      llmConfig: {
        apiKey: process.env.LLM_API_KEY!,
        baseURL: process.env.LLM_BASE_URL!,
        model: process.env.LLM_MODEL!,
      },
    });
    
    // 5. 只在成功时保存数据
    if (result.success) {
      await stateManager.syncAll();
    }
    
    // 6. 保存最终状态
    await stateManager.finalizeRun(runId, projectId, result);
    
    // 7. 关闭日志
    await logger.close();
    
    // 8. 退出
    logger.info('Agent Loop completed', { success: result.success });
    process.exit(result.success ? 0 : 1);
    
  } catch (error) {
    logger.error('Agent Runtime crashed', { error: error.message });
    await logger.close();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[Agent Runtime] Fatal error:', error);
  process.exit(1);
});

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (const arg of argv.slice(2)) {
    const [key, value] = arg.replace('--', '').split('=');
    args[key] = value;
  }
  return {
    runId: args.runId,
    projectId: args.projectId,
    mode: args.mode as 'generate' | 'iterate' | 'resume',
    skipFileRestore: args.skipFileRestore === 'true',
  };
}
```

### 5.2 状态管理：state-manager.ts

```typescript
// agent-runtime/src/state-manager.ts

import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import * as fs from 'fs/promises';
import * as path from 'path';

export class StateManager {
  private prisma: PrismaClient;
  private redis: Redis;
  private projectId: string;
  private pendingFiles = new Map<string, string>();
  
  constructor(config: { databaseUrl: string; redisUrl: string }) {
    this.prisma = new PrismaClient({
      datasources: { db: { url: config.databaseUrl } },
    });
    this.redis = new Redis(config.redisUrl);
  }
  
  /**
   * 加载上下文（根据 mode 不同加载不同数据）
   */
  async loadContext(
    runId: string,
    projectId: string,
    mode: 'generate' | 'iterate' | 'resume',
    skipFileRestore: boolean
  ) {
    this.projectId = projectId;
    
    const run = await this.prisma.projectRun.findUnique({
      where: { id: runId },
    });
    
    if (!run) throw new Error(`Run ${runId} not found`);
    
    switch (mode) {
      case 'generate':
        return {
          messages: [],
          userPrompt: run.prompt,
          files: {},
        };
        
      case 'iterate':
        const conversation = await this.loadConversation(projectId);
        const files = skipFileRestore ? {} : await this.loadFiles(projectId);
        
        if (!skipFileRestore) {
          await this.restoreFiles(files);
        }
        
        return {
          messages: conversation?.messages || [],
          userPrompt: run.prompt,
          files,
        };
        
      case 'resume':
        const loopState = await this.prisma.loopState.findUnique({
          where: { runId },
        });
        
        if (!loopState) throw new Error(`LoopState for run ${runId} not found`);
        
        const resumeFiles = await this.loadFiles(projectId);
        await this.restoreFiles(resumeFiles);
        
        return {
          messages: loopState.messages,
          resumeState: loopState.state,
          userAnswer: loopState.answer,
          files: resumeFiles,
        };
    }
  }
  
  /**
   * 恢复文件到沙盒文件系统
   */
  private async restoreFiles(files: Record<string, string>) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = `/home/user/app/${filePath}`;
      const dir = path.dirname(fullPath);
      
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }
  }
  
  /**
   * 批量同步到数据库（只在成功时调用）
   */
  async syncAll() {
    if (this.pendingFiles.size === 0) return;
    
    const files = Array.from(this.pendingFiles.entries());
    
    await this.prisma.$transaction(
      files.map(([filePath, content]) =>
        this.prisma.projectFile.upsert({
          where: {
            projectId_path: {
              projectId: this.projectId,
              path: filePath,
            },
          },
          create: {
            projectId: this.projectId,
            path: filePath,
            content,
            version: 1,
          },
          update: {
            content,
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        })
      )
    );
    
    console.log(`[StateManager] Synced ${files.length} files to DB`);
  }
  
  /**
   * 保存最终结果（只在成功时保存文件）
   */
  async finalizeRun(runId: string, projectId: string, result: any) {
    if (result.success) {
      await this.saveConversation(projectId, result.finalMessages);
    }
    
    await this.prisma.projectRun.update({
      where: { id: runId },
      data: {
        status: result.success ? 'succeeded' : 'failed',
        error: result.summary,
        previewUrl: result.previewUrl,
        finishedAt: new Date(),
      },
    });
  }
  
  async close() {
    await this.prisma.$disconnect();
    await this.redis.quit();
  }
}
```

### 5.3 事件推送：event-emitter.ts

```typescript
// agent-runtime/src/event-emitter.ts

import { Redis } from 'ioredis';

export class EventEmitter {
  private redis: Redis;
  private projectId: string;
  private runId: string;
  private channel: string;
  private currentStep: number = 0;
  private heartbeatInterval: NodeJS.Timeout;
  
  constructor(config: { redisUrl: string; projectId: string; runId: string }) {
    this.redis = new Redis(config.redisUrl);
    this.projectId = config.projectId;
    this.runId = config.runId;
    this.channel = `project:${this.projectId}:events`;
    
    // 启动心跳（每 5 秒）
    this.heartbeatInterval = setInterval(() => {
      this.emitHeartbeat();
    }, 5000);
  }
  
  private async emit(event: any) {
    const fullEvent = {
      ...event,
      runId: this.runId,
      projectId: this.projectId,
      timestamp: Date.now(),
      step: this.currentStep,
    };
    
    await this.redis.publish(this.channel, JSON.stringify(fullEvent));
  }
  
  async emitStatusChange(status: string, message?: string) {
    await this.emit({
      type: 'agent_status_change',
      data: { status, message },
    });
  }
  
  async emitHeartbeat() {
    await this.emit({
      type: 'agent_heartbeat',
      data: { uptime: process.uptime() },
    });
  }
  
  async emitStepStart(step: number) {
    this.currentStep = step;
    await this.emit({
      type: 'agent_step_start',
      data: { step },
    });
  }
  
  async emitToolCall(tool: string, args: any) {
    await this.emit({
      type: 'tool_call_start',
      data: { tool, args },
    });
  }
  
  async emitAskUser(question: string, options: any[], answerToken: string) {
    await this.emit({
      type: 'ask_user',
      data: { question, options, answerToken },
    });
  }
  
  async emitPreviewReady(previewUrl: string) {
    await this.emit({
      type: 'preview_ready',
      data: { previewUrl },
    });
  }
  
  async close() {
    clearInterval(this.heartbeatInterval);
    await this.redis.quit();
  }
}
```

---

## 六、后端服务改造

### 6.1 沙盒会话管理器

```typescript
// src/lib/sandbox-session.ts

import { prisma } from '@/lib/prisma';
import { Sandbox } from '@e2b/code-interpreter';

const SESSION_TTL = 15 * 60 * 1000; // 15 分钟

export class SandboxSessionManager {
  /**
   * 获取或创建沙盒（自动复用）
   */
  async acquireForProject(projectId: string): Promise<{
    sandbox: Sandbox;
    isReused: boolean;
  }> {
    // 1. 查询数据库中的活跃会话
    const session = await prisma.sandboxSession.findUnique({
      where: { projectId },
    });
    
    // 2. 尝试复用
    if (session && session.status === 'running' && session.expiresAt && session.expiresAt > new Date()) {
      try {
        const sandbox = await Sandbox.connect(session.sandboxId);
        
        // 更新过期时间
        await prisma.sandboxSession.update({
          where: { projectId },
          data: { expiresAt: new Date(Date.now() + SESSION_TTL) },
        });
        
        console.log(`[Session] Reused sandbox ${session.sandboxId.slice(0, 8)} for project ${projectId.slice(0, 8)}`);
        
        return { sandbox, isReused: true };
      } catch (error) {
        console.warn(`[Session] Failed to reconnect sandbox ${session.sandboxId}:`, error);
        
        await prisma.sandboxSession.update({
          where: { projectId },
          data: { status: 'expired' },
        });
      }
    }
    
    // 3. 创建新沙盒
    const sandbox = await Sandbox.create({
      template: 'ai-website-builder-v2',
      timeoutMs: SESSION_TTL,
      envVars: {
        DATABASE_URL: process.env.DATABASE_URL!,
        REDIS_URL: process.env.REDIS_URL!,
        LLM_API_KEY: process.env.LLM_API_KEY!,
        LLM_BASE_URL: process.env.LLM_BASE_URL!,
        LLM_MODEL: process.env.LLM_MODEL!,
        AXIOM_TOKEN: process.env.AXIOM_TOKEN!,
        E2B_SANDBOX_ID: sandbox.sandboxId,
      },
    });
    
    // 4. 保存到数据库
    await prisma.sandboxSession.upsert({
      where: { projectId },
      create: {
        projectId,
        sandboxId: sandbox.sandboxId,
        provider: 'e2b',
        status: 'running',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL),
      },
      update: {
        sandboxId: sandbox.sandboxId,
        status: 'running',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL),
        stoppedAt: null,
      },
    });
    
    console.log(`[Session] Created new sandbox ${sandbox.sandboxId.slice(0, 8)} for project ${projectId.slice(0, 8)}`);
    
    return { sandbox, isReused: false };
  }
  
  /**
   * 主动终止会话
   */
  async terminateSession(projectId: string) {
    const session = await prisma.sandboxSession.findUnique({
      where: { projectId },
    });
    
    if (!session) return;
    
    try {
      const sandbox = await Sandbox.connect(session.sandboxId);
      await sandbox.kill();
    } catch (error) {
      console.warn(`[Session] Failed to kill sandbox ${session.sandboxId}:`, error);
    }
    
    await prisma.sandboxSession.update({
      where: { projectId },
      data: { status: 'stopped', stoppedAt: new Date() },
    });
    
    console.log(`[Session] Terminated sandbox ${session.sandboxId.slice(0, 8)}`);
  }
}

export const sandboxSessionManager = new SandboxSessionManager();
```

### 6.2 Dispatcher（轻量调度器）

```typescript
// src/lib/dispatcher.ts

import { prisma } from '@/lib/prisma';
import { sandboxSessionManager } from './sandbox-session';

export async function dispatchRun(runId: string, projectId: string) {
  const run = await prisma.projectRun.findUnique({ where: { id: runId } });
  
  if (!run) {
    throw new Error(`Run ${runId} not found`);
  }
  
  // 1. 确定运行模式
  const mode = await determineMode(runId, run.type);
  
  // 2. 获取或创建沙盒（自动复用）
  const { sandbox, isReused } = await sandboxSessionManager.acquireForProject(projectId);
  
  // 3. 如果是复用且是 iterate 模式，跳过文件恢复
  const skipFileRestore = isReused && mode === 'iterate';
  
  console.log(`[Dispatcher] Starting Agent Runtime | run=${runId.slice(0, 8)} | mode=${mode} | reused=${isReused}`);
  
  // 4. 执行 Agent Runtime
  const process = await sandbox.process.start({
    cmd: `node /agent-runtime/dist/main.js --runId=${runId} --projectId=${projectId} --mode=${mode} --skipFileRestore=${skipFileRestore}`,
  });
  
  // 5. 监听退出
  process.on('exit', async (exitCode) => {
    console.log(`[Dispatcher] Agent Runtime exited | run=${runId.slice(0, 8)} | code=${exitCode}`);
    
    // 根据退出码决定是否保留沙盒
    if (exitCode === 0) {
      // 成功：保留沙盒 15 分钟（复用）
      console.log(`[Dispatcher] Keeping sandbox for reuse`);
    } else {
      // 失败/取消：立即清理
      await sandboxSessionManager.terminateSession(projectId);
    }
  });
  
  // 6. 保存 sandboxId（用于停止）
  await prisma.projectRun.update({
    where: { id: runId },
    data: { sandboxId: sandbox.sandboxId },
  });
}

async function determineMode(runId: string, runType: string): Promise<'generate' | 'iterate' | 'resume'> {
  // 检查是否有 LoopState（resume）
  const loopState = await prisma.loopState.findUnique({
    where: { runId },
  });
  
  if (loopState && loopState.answer) {
    return 'resume';
  }
  
  // 根据 run.type 决定
  return runType === 'generate' ? 'generate' : 'iterate';
}
```

### 6.3 Worker 简化

```typescript
// src/worker.ts

import { Worker } from "bullmq";
import { redis } from "@/lib/redis";
import { QUEUE_NAME, type AgentJobData } from "@/lib/queue";
import { dispatchRun } from "@/lib/dispatcher";
import { prisma } from "@/lib/prisma";

const worker = new Worker<AgentJobData>(
  QUEUE_NAME,
  async (job) => {
    const { runId, projectId } = job.data;
    console.log(`[Worker] Job ${job.id} started | run=${runId.slice(0, 8)}`);

    // 乐观锁：queued → running
    const claimed = await prisma.projectRun.updateMany({
      where: { id: runId, status: "queued" },
      data: {
        status: "running",
        startedAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      console.log(`[Worker] Run ${runId.slice(0, 8)} 不再是 queued，跳过`);
      return;
    }

    try {
      // 调度到沙盒（不阻塞，立即返回）
      await dispatchRun(runId, projectId);
      
      console.log(`[Worker] Job ${job.id} dispatched`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Worker] Job ${job.id} failed: ${message}`);

      // 兜底：确保 run 不会永久卡在 running 状态
      await prisma.projectRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          error: message,
          finishedAt: new Date(),
        },
      }).catch((e: unknown) => {
        console.error(`[Worker] Failed to update run status: ${e instanceof Error ? e.message : e}`);
      });

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 50, // 大幅提升并发
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
});
```

---

## 七、沙盒复用策略

### 7.1 复用收益分析

| 场景 | 不复用成本 | 复用成本 | 节省 |
|------|-----------|---------|------|
| 单轮对话 | $0.01 | $0.01 | 0% |
| 3 轮对话（5 分钟内） | $0.03 | $0.015 | 50% |
| 5 轮对话（10 分钟内） | $0.05 | $0.02 | 60% |

### 7.2 复用策略

**核心思想**：
- 每个 Project 维护一个活跃的沙盒会话
- 会话有过期时间（默认 15 分钟）
- 新 Run 优先复用现有会话
- 沙盒过期后自动销毁

**清理策略**：

| 场景 | 策略 | 理由 |
|------|------|------|
| 成功完成 | 保留 15 分钟 | ✅ 可复用 |
| 用户停止 | **立即清理** | ❌ 方向错误，不值得保留 |
| 任务失败 | **立即清理** | ❌ 失败状态无价值 |
| 超时 | 立即清理 | ✅ 一致 |
| 崩溃 | 立即清理 | ✅ 一致 |

**成本节省**：约 30%（假设 30% 的任务被停止或失败）

---

## 八、文件同步策略

### 8.1 简化的同步策略

**核心理念**：只保存成功的结果

```
写入文件
  ↓
本地文件系统（同步）
  ↓
记录到待同步队列
  ↓
任务成功完成时批量同步到 DB
```

### 8.2 数据一致性保证

**场景 1：正常退出**
- Agent 调用 `finish` 工具
- 触发 `stateManager.syncAll()`
- 所有文件同步到 DB
- ✅ 数据完整

**场景 2：用户停止**
- 用户点击停止按钮
- 沙盒被 `sandbox.kill()`
- ❌ 不保存数据（设计如此）

**场景 3：沙盒崩溃**
- 沙盒进程异常退出
- ❌ 不保存数据（设计如此）

**优势**：
- ✅ 简化逻辑：不需要定期快照、异步同步
- ✅ 降低成本：减少数据库写入次数（-90%）
- ✅ 提升性能：减少 I/O 开销
- ✅ 数据一致性：只保存完整的、成功的结果

---

## 九、监控和日志

### 9.1 多层监控架构

```
┌─────────────────────────────────────────────────────────────┐
│                     监控层级                                  │
├─────────────────────────────────────────────────────────────┤
│ L1: Agent Runtime 内部监控（实时）                            │
│   - 步骤耗时、工具执行时间、内存使用                           │
│   - 通过 EventEmitter 推送到 Redis                           │
├─────────────────────────────────────────────────────────────┤
│ L2: 后端服务监控（聚合）                                      │
│   - 沙盒创建/复用率、队列积压、Worker 负载                     │
│   - 通过 Prometheus + Grafana 可视化                         │
├─────────────────────────────────────────────────────────────┤
│ L3: 日志分析（离线）                                          │
│   - Axiom 查询分析、错误聚合、性能趋势                         │
│   - 用于问题排查和长期优化                                    │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 日志方案

#### 开发阶段：Axiom（推荐）

**优势**：
- 免费额度：500MB/月（约 50 万条日志）
- 专为 Serverless 设计
- 支持结构化日志（JSON）
- 自动聚合、搜索、可视化

**集成方式**：
- Agent Runtime 内置 `AxiomLogger`
- 批量推送（100 条或 5 秒）
- 失败自动重试

**查询示例**：

```apl
// 查询平均 LLM 响应时间
['ai-website-builder']
| where message == "LLM call completed"
| summarize avg(duration) by bin(_time, 1h)

// 查询失败率
['ai-website-builder']
| where level == "error"
| summarize count() by bin(_time, 1h)

// 查询沙盒复用率
['ai-website-builder']
| where message contains "sandbox"
| summarize 
    reused = countif(message contains "Reused"),
    created = countif(message contains "Created")
| extend reuse_rate = reused / (reused + created) * 100
```

### 9.3 性能损耗评估

| 监控项 | 开销 | 影响 |
|--------|------|------|
| EventEmitter (Redis Pub/Sub) | ~5ms/事件 | 低 |
| AxiomLogger (批量推送) | ~10ms/100条 | 极低 |
| Prometheus 指标 | ~1ms/次 | 极低 |
| 心跳（每 5 秒） | ~5ms | 极低 |
| **总开销** | **< 1% CPU** | **可忽略** |

---

## 十、任务终止流程

### 10.1 终止场景分析

| 场景 | 触发方式 | 期望行为 | 数据保存 |
|------|---------|---------|---------|
| 用户主动停止 | 点击停止按钮 | 立即 kill，不保存 | ❌ 不保存 |
| 任务完成 | Agent 调用 finish | 正常退出，保存所有数据 | ✅ 完整保存 |
| 超时 | 执行时间 > 10 分钟 | 强制 kill，不保存 | ❌ 不保存 |
| 沙盒崩溃 | 进程异常退出 | 标记为失败，不保存 | ❌ 不保存 |
| LLM 错误 | API 调用失败 | 重试 3 次后失败 | ⚠️ 保存错误日志 |

**设计理念**：
- ✅ **只有正常完成才保存数据**：用户满意的结果才值得持久化
- ❌ **异常终止不保存**：错误的中间状态没有保存价值
- 🔄 **沙盒立即销毁**：释放资源，避免成本浪费
- 📝 **保留执行日志**：用于问题排查和分析

### 10.2 停止 API 实现

```typescript
// src/app/api/projects/[id]/stop/route.ts

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { id: projectId } = params;
  const { runId } = await req.json();
  
  // 1. 查找活跃 run
  const activeRun = await prisma.projectRun.findFirst({
    where: {
      projectId,
      id: runId,
      status: { in: ['queued', 'running', 'waiting_for_user'] },
    },
  });
  
  if (!activeRun) {
    return Response.json({ error: 'No active run found' }, { status: 404 });
  }
  
  // 2. 如果在队列中，直接取消
  if (activeRun.status === 'queued') {
    await prisma.projectRun.update({
      where: { id: activeRun.id },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    
    return Response.json({ success: true, message: 'Cancelled queued run' });
  }
  
  // 3. 如果在运行中，直接 kill 沙盒（不等待，不保存）
  if (activeRun.sandboxId) {
    try {
      const sandbox = await Sandbox.connect(activeRun.sandboxId);
      await sandbox.kill(); // 强制终止
      
      console.log(`[Stop] Killed sandbox ${activeRun.sandboxId.slice(0, 8)}`);
    } catch (error) {
      console.error('[Stop] Failed to kill sandbox:', error);
    }
  }
  
  // 4. 标记为取消
  await prisma.projectRun.update({
    where: { id: activeRun.id },
    data: { 
      status: 'cancelled', 
      finishedAt: new Date(),
      error: 'User cancelled',
    },
  });
  
  // 5. 立即清理沙盒会话（不保留）
  await sandboxSessionManager.terminateSession(projectId);
  
  await publishStatusChange(projectId, 'stopped', '已停止');
  
  return Response.json({ success: true });
}
```

**关键变化**：
- ❌ 移除停止信号机制（不需要优雅退出）
- ❌ 移除等待 5 秒逻辑（直接 kill）
- ❌ 移除数据保存逻辑（不保存中间状态）
- ✅ 立即清理沙盒会话（释放资源）

**性能提升**：
- 停止响应时间：5 秒 → <1 秒（**5x 提升**）
- 沙盒成本：-30%（失败立即清理）

---

## 十一、Agent能力建设

### 11.1 能力架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent 能力层                              │
├─────────────────────────────────────────────────────────────┤
│ L1: 内置工具（Built-in Tools）                                │
│   - write_file, read_file, run_shell, get_preview_url       │
│   - 直接在 tools.ts 中实现                                    │
├─────────────────────────────────────────────────────────────┤
│ L2: SKILL（可组合的高级能力）                                  │
│   - 例如：create_component, setup_routing, add_api          │
│   - 由多个内置工具组合而成                                     │
├─────────────────────────────────────────────────────────────┤
│ L3: MCP（Model Context Protocol）                            │
│   - 连接外部服务：GitHub, Figma, Database                    │
│   - 通过 MCP Server 提供标准化接口                            │
├─────────────────────────────────────────────────────────────┤
│ L4: CLI（命令行工具）                                         │
│   - 在沙盒内执行任意 CLI 命令                                 │
│   - 例如：npm, git, curl, jq                                │
└─────────────────────────────────────────────────────────────┘
```

### 11.2 SKILL 示例

```typescript
// agent-runtime/src/skills/create-component.ts

export const createComponentSkill: Skill = {
  name: 'create_component',
  description: '创建一个 React 组件（包括组件文件、样式、测试）',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '组件名称（PascalCase）' },
      props: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            required: { type: 'boolean' },
          },
        },
        description: '组件 props 定义',
      },
      withStyles: { type: 'boolean', description: '是否创建样式文件' },
    },
    required: ['name'],
  },
  
  async execute(args, context) {
    const { name, props = [], withStyles = true } = args;
    const filesCreated: string[] = [];
    
    // 1. 生成组件代码
    const componentCode = generateComponentCode(name, props);
    await executeTool('write_file', {
      path: `components/${name}.tsx`,
      content: componentCode,
    }, context);
    filesCreated.push(`components/${name}.tsx`);
    
    // 2. 生成样式文件（可选）
    if (withStyles) {
      const styleCode = generateStyleCode(name);
      await executeTool('write_file', {
        path: `components/${name}.module.css`,
        content: styleCode,
      }, context);
      filesCreated.push(`components/${name}.module.css`);
    }
    
    return {
      success: true,
      output: `组件 ${name} 创建成功`,
      artifacts: { filesCreated },
    };
  },
};
```

### 11.3 MCP 集成

```typescript
// agent-runtime/src/mcp-client.ts

export class MCPClient {
  private process: ChildProcess;
  
  constructor(serverCommand: string, serverArgs: string[]) {
    this.process = spawn(serverCommand, serverArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  
  async callTool(name: string, args: any): Promise<any> {
    const request = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    
    this.process.stdin!.write(JSON.stringify(request) + '\n');
    
    return new Promise((resolve, reject) => {
      this.process.stdout!.once('data', (data) => {
        const response = JSON.parse(data.toString());
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      });
    });
  }
}
```

---

## 十二、实施计划

### Phase 1：准备（1 周）

**目标**：构建基础设施

**任务**：
- [ ] 创建 `e2b-template/agent-runtime/` 目录结构
- [ ] 实现 `main.ts`、`state-manager.ts`、`event-emitter.ts`、`logger.ts`
- [ ] 实现 `loop.ts`、`tools.ts`（复用现有逻辑）
- [ ] 编写 Dockerfile
- [ ] 构建并发布 E2B Template
- [ ] 本地测试 Agent Runtime

**验收标准**：
- ✅ 可以在本地沙盒中运行 Agent Runtime
- ✅ 日志正常推送到 Axiom
- ✅ 文件同步到数据库

### Phase 2：后端改造（1 周）

**目标**：实现调度器和会话管理

**任务**：
- [ ] 实现 `sandbox-session.ts`（沙盒会话管理器）
- [ ] 实现 `dispatcher.ts`（轻量调度器）
- [ ] 修改 `worker.ts`（提升并发到 50）
- [ ] 修改 `/stop` API（使用 `sandbox.kill()`）
- [ ] 添加 `sandboxExitCode` 字段到 `ProjectRun` 表
- [ ] 集成测试

**验收标准**：
- ✅ Worker 可以调度任务到沙盒
- ✅ 沙盒会话可以复用
- ✅ 停止功能正常工作

### Phase 3：并行运行（1 周）

**目标**：小流量测试

**任务**：
- [ ] 添加环境变量 `USE_SANDBOX_RUNTIME=true`
- [ ] 保留旧 Worker 代码
- [ ] 实现流量切换逻辑
- [ ] 10% 流量测试
- [ ] 监控成本、延迟、错误率
- [ ] 修复发现的问题

### Phase 4：全量切换（1 周）

**目标**：完全迁移到新架构

**任务**：
- [ ] 逐步提升流量：10% → 50% → 100%
- [ ] 监控关键指标
- [ ] 移除旧代码
- [ ] 文档更新

### Phase 5：优化（持续）

**目标**：性能和成本优化

**任务**：
- [ ] 实现沙盒池（预热）
- [ ] 优化 Template 大小
- [ ] 引入分布式追踪
- [ ] 成本优化（调整 TTL、快照频率）
- [ ] 性能优化（减少网络延迟）

---

## 十三、成本估算

### 13.1 E2B 成本

**假设**：
- 单次任务平均运行时间：60 秒
- 沙盒复用率：60%
- 每日任务数：1000

**计算**：
- 不复用：1000 × 60s × $0.01/60s = $10/天 = $300/月
- 复用后：1000 × 60s × 0.4 × $0.01/60s = $4/天 = $120/月

### 13.2 其他成本

| 项目 | 成本 |
|------|------|
| Railway Worker | $20/月 |
| Railway PostgreSQL | $10/月 |
| Railway Redis | $10/月 |
| Axiom 日志 | $0-25/月 |
| **总计** | **$160-185/月** |

### 13.3 对比

| 架构 | 月成本 | 并发度 | 性价比 |
|------|--------|--------|--------|
| 当前架构 | $40/月 | 2 | 1x |
| 新架构 | $160-185/月 | 50+ | **6x** |

**结论**：成本增加 4 倍，但并发度提升 25 倍，性价比提升 6 倍。

---

## 十四、总结

### 14.1 核心优势

✅ **并发度**：2 → 50+（25 倍提升）  
✅ **停止延迟**：5-10 秒 → 立即（沙盒 kill）  
✅ **状态机复杂度**：-60%（移除 cancelling、检查点、心跳）  
✅ **隔离性**：进程级隔离，互不影响  
✅ **可扩展性**：水平扩展沙盒，无需扩展 Worker  
✅ **代码清晰度**：Agent 逻辑与调度逻辑完全分离  

### 14.2 关键技术点

1. **沙盒复用**：数据库持久化会话，TTL 15 分钟，节省 50-60% 成本
2. **文件同步**：只保存成功结果，简化逻辑，降低成本
3. **日志监控**：Axiom + OpenTelemetry，中心化日志和分布式追踪
4. **停止机制**：直接 kill，不保存数据，响应快（<1s）
5. **SSE 推送**：实时状态反馈，延迟 < 100ms
6. **Human-in-the-Loop**：支持 Agent 向用户提问，增强交互性

### 14.3 架构简化收益

**代码复杂度**：
- 移除停止信号机制：-100 行
- 移除优雅退出处理：-50 行
- 移除定期快照：-30 行
- 移除异步文件同步：-80 行
- **总计：-260 行代码（-40% 复杂度）**

**性能提升**：
- 停止响应时间：5 秒 → <1 秒（**5x 提升**）
- 数据库写入次数：-90%
- 沙盒成本：-30%（失败立即清理）

### 14.4 风险和缓解

| 风险 | 缓解措施 |
|------|---------|
| E2B 成本超预算 | 设置每日配额、实现沙盒池、监控成本 |
| 沙盒启动慢 | 预热池、优化 Template、预编译代码 |
| 网络不稳定 | 重试机制、降级到本地 Worker |
| 调试困难 | 中心化日志、分布式追踪、结构化日志 |
| 数据一致性 | 只保存成功结果、事务保证 |
| 用户误操作停止 | 二次确认弹窗 |

---

**文档版本**: v2.0  
**最后更新**: 2026-06-02  
**维护者**: AI Website Builder Team
