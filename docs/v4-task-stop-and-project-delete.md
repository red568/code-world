# V4 任务停止与项目删除 — 设计文档

## 1. 概述

本文档描述"任务停止"和"项目删除"两个功能的完整设计，重点覆盖并发安全、分布式锁、竞态条件和边界情况的处理。

---

## 2. 系统架构背景

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Next.js    │     │   BullMQ     │     │   Worker    │
│  API Routes │────▶│   Queue      │────▶│  Process    │
│  (Web 端)   │     │  (Redis)     │     │  (独立进程) │
└─────────────┘     └──────────────┘     └─────────────┘
       │                                        │
       │            ┌──────────────┐            │
       └───────────▶│  PostgreSQL  │◀───────────┘
                    │  (Prisma)    │
                    └──────────────┘
                           │
                    ┌──────────────┐
                    │    Redis     │
                    │ (锁/取消/SSE)│
                    └──────────────┘
```

关键约束：
- Web 端（API Routes）和 Worker 是独立进程，无法直接通信
- 唯一的协调通道是 Redis（锁、cancel flag）和 PostgreSQL（状态）
- Agent Loop 单次运行可能超过 10 分钟（50 步 × LLM 调用 + shell 命令）

---

## 3. 分布式锁设计

### 3.1 锁的职责

`project-lock:{projectId}` 保证同一项目同一时间只有一个操作在执行（Worker 任务或 DELETE 操作）。

### 3.2 实现机制

| 特性 | 实现 |
|------|------|
| 互斥获取 | `SET key token EX ttl NX` — 原子操作 |
| Owner token | 随机 UUID，防止误释放 |
| 安全释放 | Lua compare-and-delete：token 匹配才删除 |
| 心跳续租 | `setInterval` 每 TTL/3 执行一次 Lua compare-and-expire |
| 锁丢失保护 | 续租失败时设置 cancel flag，通知 agent loop 退出 |

### 3.3 Lua 脚本

```lua
-- 释放锁（compare-and-delete）
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end

-- 续租（compare-and-expire）
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
```

### 3.4 为什么需要 owner token

没有 token 的锁存在经典问题：

```
T1: Worker A 获取锁（TTL=600s）
T2: Worker A 因 GC/网络暂停，锁过期
T3: DELETE 获取锁（新锁）
T4: Worker A 恢复，调用 redis.del(key) → 删掉了 DELETE 的锁
T5: Worker B 获取锁 → 互斥被破坏
```

有 token 后，T4 的 `del` 变成 compare-and-delete，token 不匹配，操作无效。

### 3.5 为什么需要心跳续租

Agent Loop `maxSteps=50`，单步可能包含：
- LLM 调用：5-30 秒
- Shell 命令（npm install/build）：最多 120 秒
- 文件写入 + 沙箱操作：数秒

总耗时可能超过 10 分钟（默认 TTL 600s）。没有续租，锁过期后 DELETE 可以拿到锁并删除项目，而 Worker 仍在运行。

续租策略：
- 间隔：TTL/3 = 200 秒
- 最坏情况：续租刚执行完，下次续租前锁还剩 TTL - TTL/3 = 400 秒
- 安全裕度：即使一次续租失败（网络抖动），还有 400 秒缓冲

### 3.6 锁丢失时的 fail-closed 行为

```typescript
if (!renewed) {
  clearInterval(renewInterval);
  await setCancelled(projectId).catch(() => {});
}
```

续租返回 false 意味着锁已被其他人获取（Worker 已失去互斥权）。此时设置 cancel flag，agent loop 在下一个检查点退出。这是 best-effort 保护：
- 如果 Redis 可达：cancel flag 生效，agent loop 几秒内退出
- 如果 Redis 不可达：`setCancelled` 也会失败，只能依赖后续 DB 操作报错来终止

**设计决策：** 不引入 AbortController / abort signal 穿透机制。理由：
1. 复用现有 cancel flag 基础设施，改动 3 行
2. 真正的保障应在基础设施层（Redis Sentinel/Cluster），不在应用层
3. Node.js 不会有 400s 的 GC pause，容器冻结那么久进程早被 OOM kill

---

## 4. 协作式取消机制

### 4.1 为什么是协作式而非强制终止

- BullMQ 没有从外部 abort 正在执行的 job 的 API
- 强制 kill 进程会导致资源泄漏（sandbox 连接、DB 事务）
- 协作式让 agent loop 在安全点退出，保证清理逻辑能执行

### 4.2 Cancel Flag

```
Redis key: project-cancelled:{projectId}
Value: "1"
TTL: 600s（兜底自动过期）
```

### 4.3 检查点位置

Agent Loop 的 for 循环中有两个检查点：

```
for (step = 1; step <= maxSteps; step++) {
  ┌─ 检查点 1：每轮 LLM 调用前 ─┐
  │  if (await isCancelled(id))  │
  │    return "已取消"            │
  └──────────────────────────────┘

  LLM 调用（5-30s）

  for (toolCall of toolCalls) {
    ┌─ 检查点 2：每个 tool 执行前 ─┐
    │  if (await isCancelled(id))   │
    │    return "已取消"             │
    └───────────────────────────────┘

    Tool 执行（可能 120s）
  }
}
```

最坏取消延迟 = 一次 LLM 调用 + 一次 tool 执行 ≈ 30s + 120s = 150s。对用户来说可接受（UI 显示"正在停止..."）。

### 4.4 Cancel Flag 生命周期

| 事件 | 操作 |
|------|------|
| 用户点击停止 | `setCancelled(id)` |
| 锁续租失败 | `setCancelled(id)` |
| 新任务开始（generate/iterate） | `clearCancelled(id)` |
| 项目被删除 | `clearCancelled(id)` |

关键设计：新任务开始时清理旧 flag。否则用户停止后再发消息，新的 agent loop 会立即读到旧 flag 退出。

### 4.5 Orchestrator 对取消结果的处理

```typescript
if (result.summary === "已取消") {
  // 不再 update project status（stop 已经改过了）
  // 清理 sandbox（如果是新建的）
  // 直接 return，让 withProjectLock 的 finally 释放锁
}
```

---

## 5. 任务停止（POST /api/projects/:id/stop）

### 5.1 完整流程

```
1. 查询项目（含 sandboxSession）
2. setCancelled(id)                    ← 通知 agent loop 退出
3. 移除队列中 waiting/delayed jobs     ← 防止新任务启动
4. Sandbox.connect → kill              ← 关闭沙箱（try-catch）
5. 更新 sandboxSession.status = stopped
6. 更新 project.status = stopped
7. 返回 200
```

### 5.2 Worker 侧响应

```
Agent Loop:
  → 检查点读到 isCancelled = true
  → return { success: false, summary: "已取消" }

Orchestrator:
  → 识别 result.summary === "已取消"
  → 跳过 prisma.project.update（status 已被 stop 改为 stopped）
  → 清理 sandbox（如果是新建的）
  → return

withProjectLock:
  → finally 释放锁
```

### 5.3 边界情况

| 场景 | 处理 |
|------|------|
| 项目没有 sandbox | `if (project.sandboxSession)` 跳过 |
| Sandbox 已过期 | `try-catch` 兜住 |
| 队列中没有该项目的 job | 遍历结果为空，无副作用 |
| Agent loop 正好在 LLM 调用中 | 等当前调用返回后，下一个检查点退出 |
| 项目已经是 stopped 状态 | 幂等操作，重复执行无害 |
| 用户停止后又发新消息 | 新任务 orchestrator 开头 clearCancelled，不受旧 flag 影响 |

### 5.4 前端交互

ChatPanel 输入框区域：
- 生成中时，发送按钮变为红色停止按钮（Square 图标）
- 点击后调用 `POST /stop`，按钮显示 loading 状态
- SSE 收到 status_change: stopped 后恢复为发送按钮

---

## 6. 项目删除（DELETE /api/projects/:id）

### 6.1 完整流程

```
1. 查询项目（带 userId 权限校验）
2. 项目不存在 → 404
3. 状态检查：活跃状态 → 409 "请先停止项目"
4. acquireProjectLock(id) → 获取失败 → 409 "正在处理中"
5. try:
   a. 移除队列中 waiting/delayed jobs
   b. Sandbox.connect → kill（try-catch）
   c. prisma.project.delete()（级联删除 6 张子表）
   d. clearCancelled(id)
6. finally:
   a. releaseProjectLock(id, token)
7. 返回 200
```

### 6.2 三层防护

```
┌─────────────────────────────────────────────────────┐
│ 第一层：状态检查                                      │
│ 活跃状态（generating/building/fixing）→ 409 拒绝      │
├─────────────────────────────────────────────────────┤
│ 第二层：分布式锁                                      │
│ Worker 持有锁 → acquireProjectLock 失败 → 409 拒绝   │
├─────────────────────────────────────────────────────┤
│ 第三层：Worker 防御性检查                             │
│ Job 启动时 findUnique → 项目不存在 → 跳过            │
└─────────────────────────────────────────────────────┘
```

### 6.3 数据库级联删除

Prisma schema 中所有子表配置 `onDelete: Cascade`：

```
Project (delete)
  ├── Message          (cascade)
  ├── ProjectFile      (cascade)
  ├── BuildLog         (cascade)
  ├── AgentRun         (cascade)
  ├── SandboxSession   (cascade)
  └── AgentConversation (cascade)
```

一次 `prisma.project.delete()` 由 PostgreSQL 自动清理所有关联数据。

### 6.4 权限校验

```typescript
where: { id, userId: DEMO_USER_ID }
```

即使当前是 demo 用户，也按 userId 限定查询。未来接入真实认证后，只需替换 `DEMO_USER_ID` 为当前用户 ID。

### 6.5 前端交互

两个入口：
- **侧边栏**：hover 项目时右侧显示 Trash2 图标，点击 confirm 后删除；如果删除的是当前查看的项目，跳转首页
- **首页卡片**：hover 时右上角显示 Trash2 图标，同样带确认

409 响应处理：`alert(data.error)` 提示用户先停止项目。

---

## 7. 并发问题与竞态分析

### 7.1 TOCTOU：状态检查与删除之间的竞态

**问题：**
```
T1: DELETE 读到 status = "created"，通过检查
T2: Worker 开始消费 job，改 status = "code_generating"
T3: DELETE 执行 prisma.project.delete()
```

**解决：** DELETE 在状态检查后还要获取项目锁。Worker 通过 `withProjectLock` 持有锁，DELETE 的 `acquireProjectLock` 会失败，返回 409。

**反向竞态：**
```
T1: DELETE 获取锁
T2: Worker 尝试 withProjectLock → 失败 → job 抛错
```

这是安全的。Worker job 失败后 BullMQ 会重试，重试时 `findUnique` 发现项目已删除，直接跳过。

### 7.2 Stop 后立即 Delete 的竞态

**问题：**
```
T1: 用户点停止 → setCancelled + status = stopped
T2: 用户立即点删除 → status 不在 ACTIVE_STATUSES → 通过
T3: Worker 还没读到 cancel flag，仍在执行
T4: DELETE 尝试获取锁 → Worker 持有锁 → 409
```

**结果：** 安全。锁保护了这个窗口期。用户看到"正在处理中，请稍后再试"，等 Worker 退出后再删除即可。

### 7.3 队列 Job 与删除的竞态

**问题：**
```
T1: 用户创建项目 → enqueueGenerate → status = "created"
T2: DELETE 通过状态检查 + 获取锁 + 删除项目
T3: Worker 消费 job → orchestrateGenerate → prisma.project.update 报错
```

**解决：** 双重防护：
1. DELETE 在锁保护下移除 waiting/delayed jobs
2. Worker 启动时 `findUnique` 检查项目是否存在

### 7.4 锁过期导致的互斥丢失

**问题：**
```
T1: Worker 获取锁（TTL=600s）
T2: 任务执行超过 600s，锁过期
T3: DELETE 获取新锁，删除项目
T4: Worker 继续执行，写已删除项目
```

**解决：** 心跳续租（每 200s）+ 锁丢失时 setCancelled：
- 正常情况：续租保持锁有效，DELETE 拿不到锁
- 异常情况（续租失败）：setCancelled 通知 agent loop 退出

**残余风险：** 如果 Redis 完全不可达超过 400s（续租失败 + 剩余 TTL 耗尽），锁过期且 cancel flag 也设不上。这是基础设施级灾难，需要 Redis Sentinel/Cluster 保障，不在应用层解决。

### 7.5 并发删除同一项目

**问题：** 两个 DELETE 请求同时到达。

**解决：** `acquireProjectLock` 是 `SET NX`，只有一个能成功。另一个返回 409。

### 7.6 Cancel flag 残留影响新任务

**问题：**
```
T1: 用户停止 → setCancelled(id)，TTL=600s
T2: 用户 30s 后发新消息 → enqueueIterate
T3: Worker 启动 orchestrateIterate → agent loop 第一步读到旧 cancel flag → 立即退出
```

**解决：** `orchestrateGenerate` 和 `orchestrateIterate` 开头都调用 `clearCancelled(projectId)`。新任务启动 = 用户意图继续，旧取消信号失效。

---

## 8. 用户操作路径

### 8.1 停止并删除活跃项目

```
用户在 ChatPanel 点击停止按钮（红色 Square 图标）
  → POST /api/projects/:id/stop
  → setCancelled + kill sandbox + status = stopped
  → Agent loop 在检查点退出
  → 前端 SSE 收到 status_change: stopped

用户在侧边栏 hover 项目，点击删除图标
  → confirm("确定要删除？")
  → DELETE /api/projects/:id
  → 锁获取成功 → 级联删除 → 200
  → 项目从列表消失
```

### 8.2 删除非活跃项目（created/failed/stopped）

```
用户在首页/侧边栏 hover 项目，点击删除图标
  → confirm("确定要删除？")
  → DELETE /api/projects/:id
  → 状态检查通过 → 锁获取成功 → 级联删除 → 200
```

### 8.3 删除活跃项目（被拒绝）

```
用户尝试删除 code_generating 状态的项目
  → DELETE 返回 409: "项目正在运行中，请先停止项目"
  → 前端 alert 提示
```

### 8.4 删除时 Worker 仍在处理（锁保护）

```
用户停止后立即删除
  → DELETE 尝试获取锁 → Worker 还持有锁 → 409: "正在处理中，请稍后再试"
  → 用户等几秒后重试 → Worker 已退出释放锁 → 删除成功
```

---

## 9. 改动文件清单

| 文件 | 职责 |
|------|------|
| `src/lib/queue/cancel.ts` (新增) | Redis cancel flag：setCancelled / isCancelled / clearCancelled |
| `src/lib/queue/lock.ts` (重写) | 分布式锁：owner token + Lua 释放 + 心跳续租 + 锁丢失保护 |
| `src/lib/queue/index.ts` | 导出 cancel 和 lock 函数 |
| `src/lib/agent/loop.ts` | for 循环中加两处 isCancelled 检查点 |
| `src/app/api/projects/[id]/stop/route.ts` | 加 setCancelled + 移除队列 jobs + 兼容无 sandbox |
| `src/app/api/projects/[id]/route.ts` | DELETE：状态检查 + 锁互斥 + 队列清理 + 级联删除 |
| `src/worker.ts` | Job handler 开头加项目存在性检查 |
| `src/lib/queue/orchestrator.ts` | 开头 clearCancelled + 识别"已取消"跳过后续写入 |
| `src/components/chat-panel.tsx` | 输入框区域加停止按钮（生成中显示） |
| `src/components/session-sidebar.tsx` | 项目列表加删除按钮 + 409 处理 |
| `src/app/page.tsx` | 首页项目卡片加删除按钮 + 409 处理 |

---

## 10. Redis Key 一览

| Key | 用途 | TTL | 设置方 | 清理方 |
|-----|------|-----|--------|--------|
| `project-lock:{id}` | 互斥锁 | 600s（心跳续租） | Worker / DELETE | 持有者 compare-and-delete |
| `project-cancelled:{id}` | 取消信号 | 600s | stop / 锁丢失 | 新任务开始 / DELETE |

---

## 11. 已知限制与后续演进

### 11.1 当前限制

| 限制 | 影响 | 缓解措施 |
|------|------|----------|
| 取消延迟最大 ~150s | 用户点停止后不会立即停 | UI 显示"正在停止..." |
| Redis 完全不可达时锁失效 | 极端情况下互斥被破坏 | 需要 Redis 高可用（Sentinel/Cluster） |
| getJobs 遍历全部 waiting jobs | 队列很大时性能差 | 当前单用户 demo 可接受 |
| 删除活跃项目需要两步操作 | 用户体验略繁琐 | 前端可串联 stop + delete |

### 11.2 后续可选优化

| 方案 | 适用场景 | 复杂度 |
|------|----------|--------|
| 前端串联 stop → delete | 一键删除活跃项目 | 低 |
| 软删除（deletedAt + 定时清理） | 需要回收站/撤销功能 | 中 |
| BullMQ Job ID 按 projectId 索引 | 大量 job 时快速定位移除 | 低 |
| AbortController 穿透 agent loop | 更快的取消响应（<1s） | 高 |
| Redis Sentinel / Cluster | 锁的高可用保障 | 基础设施层 |
| Cancel flag 带 runId | 精确取消特定 run，不影响后续 | 中 |
