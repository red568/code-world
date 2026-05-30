# V4 Run 生命周期机制设计

## 1. 结论

Run 生命周期的目标是：

```text
Soft Stop + runId 写权限隔离 + sandbox 一次性使用。
```

也就是说：

- Stop 不强制中断正在执行中的 Worker / LLM / tool 调用。
- Stop 只负责让旧 run 失去继续写入项目的资格。
- 当前外部调用可以自然返回，但返回结果必须在写入前被丢弃。
- Stop 后旧 sandbox 不再复用。
- 下一次 run 重新创建 sandbox，并从数据库中的项目文件状态恢复。

因此，Run 生命周期的核心价值不是“强取消”，而是：

```text
明确每一次 Agent 执行的身份、状态、写权限和副作用边界。
```

## 2. 为什么需要 Run 生命周期

即使接受 Stop 后重新创建 sandbox，`ProjectRun` 仍然非常必要。

如果只用 `projectId` 表示任务，会继续存在这些问题：

- Stop 不知道停止的是哪一次执行。
- 旧 Worker 返回后可能覆盖新 run 的项目文件、preview、状态或日志。
- BullMQ retry 可能让旧任务重新执行。
- project 级 cancel flag 可能污染下一次任务。
- SSE 迟到事件可能污染当前 UI。
- Delete 无法准确判断是否还有旧 Worker 在执行。
- sandbox、build log、conversation、tool call 无法归属到某一次执行。

`ProjectRun` 解决的是执行隔离问题，而不是单纯的取消问题。

## 3. 核心原则

### 3.1 Project 与 Run 分离

`Project` 是长期对象，表示一个网站项目。

`ProjectRun` 是短期对象，表示一次 Agent 执行。

```text
Project A
  Run 1: 首次生成
  Run 2: 修改首页风格
  Run 3: 添加价格页
```

`projectId` 只表示归属。

`runId` 表示一次具体执行。

### 3.2 Stop 是写权限失效，不是强制中断

Stop 的语义定义为：

```text
从 Stop 生效开始，旧 run 不能再对 project 产生任何持久化副作用。
```

它不承诺：

- 立即中断 LLM 请求。
- 立即中断 shell 命令。
- 立即 kill sandbox。
- 立即结束 BullMQ job。

它承诺：

- 旧 run 的 DB 写入会被拒绝。
- 旧 run 的 SSE 事件会被前端过滤。
- 旧 run 的 sandbox 不会被后续 run 复用。
- 旧 run 最终会进入 `cancelled` 或被 Reaper 兜底终态化。

### 3.3 关键写入通过条件更新保护

项目终态写入（project.status）不能只依赖 `projectId`，必须通过 `finalizeRun` 的条件更新保护。

中间写入（sandbox 文件、build log、SSE 事件）通过检查点的 `assertRunWritable` 拦截。即使极端情况下漏过一次，也不会破坏系统一致性：

- sandbox 文件：Stop 后 sandbox 不复用，写了也白写。
- build log：归属到 runId，不影响项目状态。
- SSE 事件：前端按 runId 过滤，旧 run 事件不会污染新 UI。

检查点写法：

```ts
await assertRunWritable(runId);
// 后续操作...
```

终态写法（`finalizeRun` 内部）：

```ts
await tx.projectRun.updateMany({
  where: { id: runId, status: "running" },
  data: { status: result, finishedAt: new Date() },
});
// count=0 说明 Stop 已介入，不覆盖
```

### 3.4 Sandbox 复用策略

Sandbox 是否可复用取决于上一次 run 的终态：

| 上一次 run 终态 | Sandbox 状态 | 是否可复用 |
|----------------|-------------|:---:|
| succeeded | 文件系统与 DB 一致，状态干净 | ✓ |
| failed | 可能部分写入，但 Agent 已完成错误处理 | ✓ |
| cancelled | 可能写了一半，状态不可信 | ✗ |

复用条件：

- 上一次 run 自然终止（succeeded 或 failed）。
- sandbox 仍然存活（未过期、未被 kill）。
- sandbox 属于同一个 project。

不可复用时（上一次 run 被 Stop）：

- 旧 sandbox 视为废弃，不要求 Stop API 立刻 kill。
- Worker 自然结束后可以 best-effort 清理。
- Reaper 可以清理遗留 sandbox。
- 新 run 必须创建新 sandbox，从 DB 中的项目文件状态恢复。

为什么 cancelled 的 sandbox 不可复用：

- Stop 时 Worker 可能正在执行 `npm install`、写文件、或运行 shell 命令。
- 这些操作可能只完成了一半（文件写了一部分、依赖装了一半）。
- 文件系统状态和 DB 中记录的项目文件不一致。
- 与其尝试修复不一致状态，不如重建——成本可控，正确性有保证。

实现建议：

```ts
async function getOrCreateSandbox(projectId: string, runId: string) {
  // 查找上一次 run 的 sandbox
  const lastRun = await prisma.projectRun.findFirst({
    where: {
      projectId,
      status: { in: [“succeeded”, “failed”] },
      sandboxId: { not: null },
    },
    orderBy: { finishedAt: “desc” },
  });

  if (lastRun?.sandboxId) {
    try {
      const sandbox = await Sandbox.connect(lastRun.sandboxId);
      // 连接成功，复用
      return sandbox;
    } catch {
      // sandbox 已过期或不可达，降级为新建
    }
  }

  // 新建 sandbox + 从 DB 恢复项目文件
  return await createFreshSandbox(projectId, runId);
}
```

## 4. Run 状态机

### 4.1 状态定义

```text
queued       已创建并入队，等待 Worker 消费
running      Worker 已获取任务并开始执行
cancelling   用户已请求停止，该 run 已失去写入资格
cancelled    已停止，终态
succeeded    成功完成，终态
failed       失败，终态
```

### 4.2 状态流转

```text
queued
  -> running
      -> succeeded
      -> failed
      -> cancelling -> cancelled

queued
  -> cancelled
```

这里建议对 queued run 做一个简化：如果 run 还没有被 Worker 消费，Stop API 可以直接把它从 `queued` 改成 `cancelled`，并尝试移除 waiting job。

原因是 queued run 没有执行现场，不需要等待 Worker 做清理。

### 4.3 Active 与 Terminal

Active 状态：

```text
queued | running | cancelling
```

Terminal 状态：

```text
cancelled | succeeded | failed
```

第一版建议同一个 project 同时只允许一个 active run。

也就是说，用户点击 Stop 后，如果旧 run 仍在 `cancelling`，新 run 暂时返回 409，等旧 run 进入 `cancelled` 后再允许创建。

这是最稳的版本。

## 5. 数据模型

建议新增 Prisma enum 和 model：

```prisma
enum ProjectRunType {
  generate
  iterate
}

enum ProjectRunStatus {
  queued
  running
  cancelling
  cancelled
  succeeded
  failed
}

model ProjectRun {
  id          String           @id @default(uuid())
  projectId   String
  userId      String
  type        ProjectRunType
  status      ProjectRunStatus @default(queued)
  prompt      String
  error       String?
  sandboxId   String?
  previewUrl  String?
  startedAt   DateTime?
  finishedAt  DateTime?
  heartbeatAt DateTime?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  project     Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
  @@index([userId])
  @@index([status])
  @@index([projectId, status])
}
```

建议相关表补充 `runId`：

```prisma
model BuildLog {
  id        String   @id @default(uuid())
  projectId String
  runId     String?
  command   String
  stdout    String   @default("")
  stderr    String   @default("")
  exitCode  Int?
  diagnosis String?
  attempt   Int      @default(1)
  createdAt DateTime @default(now())
}
```

`ProjectFile` 可以增加 `lastRunId`：

```prisma
model ProjectFile {
  id        String   @id @default(uuid())
  projectId String
  path      String
  content   String
  version   Int      @default(1)
  lastRunId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

`SandboxSession` 不建议再设计成 project 唯一、长期复用的 session。更推荐按 run 记录：

```prisma
model SandboxSession {
  id        String        @id @default(uuid())
  projectId String
  runId     String
  sandboxId String
  provider  String        @default("e2b")
  status    SandboxStatus @default(creating)
  previewUrl String?
  startedAt DateTime      @default(now())
  stoppedAt DateTime?
  expiresAt DateTime?

  @@index([projectId])
  @@index([runId])
  @@index([sandboxId])
}
```

如果当前实现暂时保留 project 级 `SandboxSession`，也要确保 Stop 后不会复用旧 session。

## 6. 队列模型

BullMQ job payload 只携带身份，不携带主要业务事实：

```ts
export interface AgentJobData {
  runId: string;
  projectId: string;
  userId: string;
}
```

Worker 必须从 DB 加载 run：

```ts
const run = await prisma.projectRun.findUnique({
  where: { id: runId },
  include: { project: true },
});
```

不要只相信 BullMQ payload。

jobId 建议使用 `runId`：

```ts
await agentQueue.add("agent-run", data, {
  jobId: runId,
  attempts: 3,
  backoff: { type: "fixed", delay: 5000 },
});
```

Retry 时必须重新读取 run 状态。只有 `queued` 的 run 才允许重新启动。

## 7. 创建 Run

### 7.1 首次生成

```text
POST /api/projects
  -> 创建 Project
  -> 创建 Message
  -> 创建 ProjectRun(status=queued, type=generate)
  -> 入队 { runId, projectId, userId }
  -> 返回 { projectId, runId }
```

### 7.2 迭代修改

```text
POST /api/projects/:id/messages
  -> 校验项目归属
  -> 检查是否存在 active run
  -> 创建 Message
  -> 创建 ProjectRun(status=queued, type=iterate)
  -> 入队 { runId, projectId, userId }
  -> 返回 { runId }
```

active run 检查：

```ts
const activeRun = await tx.projectRun.findFirst({
  where: {
    projectId,
    status: { in: ["queued", "running", "cancelling"] },
  },
});

if (activeRun) {
  throw new ConflictError("Project already has an active run");
}
```

创建 run 与 Delete 之间仍然需要防 TOCTOU。第一版策略：

- Delete 在获取 project lock 后执行锁内 double-check。
- 创建 run 的 API 不需要获取 project lock（避免每次发消息都抢锁）。
- Worker 启动时检查项目是否存在，不存在则静默退出。

这三层防护在第一版足够。如果后续需要更强保证，可以让创建 run 也获取 project lock，或引入软删除。

## 8. Worker 执行协议

### 8.1 启动 run

Worker 消费 job 后，第一步做条件状态转移：

```ts
const updated = await prisma.projectRun.updateMany({
  where: {
    id: runId,
    status: "queued",
  },
  data: {
    status: "running",
    startedAt: new Date(),
    heartbeatAt: new Date(),
  },
});

if (updated.count === 0) {
  return;
}
```

如果 Stop 已经把 queued run 改成 `cancelled`，Worker 直接退出。

### 8.2 执行过程

Worker 可以继续使用 project lock 来保证同一个 project 内只有一个 run 真正执行。

但业务事实来源必须是 `ProjectRun.status`，不是 Redis lock。

```ts
await withProjectLock(projectId, async () => {
  await executeRun(runId);
});
```

锁是优化手段，不是正确性保证。即使锁过期（极端情况），正确性仍由 `assertRunWritable` + 条件更新保证：

- 旧 Worker 锁过期后继续执行 → 下一个 `assertRunWritable` 检查点仍然能通过（只要 run 还是 running）。
- 如果 Stop 已经把 run 改成 cancelling → `assertRunWritable` 会 throw，旧 Worker 停止写入。
- 如果 Delete 拿到了锁 → Delete 会检查 active run，发现 run 还在 running/cancelling → 返回 409。

所以锁过期的最坏后果是"Delete 短暂拿到锁但发现不能操作"，不会导致数据损坏。

### 8.3 Heartbeat

Heartbeat 合并在 `assertRunWritable` 中，每 N 个检查点更新一次（见 Section 9.2）。

不需要后台 interval。如果业务逻辑卡死不再经过检查点，heartbeat 自然停止，Reaper 能检测到。

Reaper 超时阈值建议 5-10 分钟，heartbeat 间隔建议每 5 个检查点更新一次。正常 run 每步 2-3 个检查点，50 步 run 大约更新 20-30 次 heartbeat，间隔远小于 Reaper 阈值。

### 8.4 结束 run

Worker 结束时根据当前状态决定终态：

- 正常完成且 run 仍是 `running`：标记 `succeeded`。
- 执行中发现 run 已经不是 `running`：丢弃结果，标记 `cancelled`。
- 发生可归因于本 run 的异常：标记 `failed`。

推荐封装：

```ts
async function finalizeRun(
  runId: string,
  projectId: string,
  result: "succeeded" | "cancelled" | "failed",
  error?: string
) {
  await prisma.$transaction(async (tx) => {
    // 条件更新：只有 status=running 时才能写 succeeded/failed
    // 这防止 Worker 覆盖 Stop 已写入的 cancelling
    const updated = await tx.projectRun.updateMany({
      where: { id: runId, status: "running" },
      data: {
        status: result,
        error,
        finishedAt: new Date(),
      },
    });

    if (updated.count === 1) {
      // 成功拿到终态写入权
      await tx.project.update({
        where: { id: projectId },
        data: { status: RUN_TO_PROJECT_STATUS[result] },
      });
      return;
    }

    // count=0：有人已经改过了（Stop 或 Reaper）
    // 重新读取，尊重当前状态
    const run = await tx.projectRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });

    if (run?.status === "cancelling") {
      // Stop 已经介入，Worker 必须尊重 Stop 的意图
      await tx.projectRun.updateMany({
        where: { id: runId, status: "cancelling" },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      await tx.project.update({
        where: { id: projectId },
        data: { status: "stopped" },
      });
    }
    // 如果已经是终态（cancelled/succeeded/failed），什么都不做
  });
}
```

#### 为什么必须用条件更新

在 PostgreSQL Read Committed 下，如果 finalizeRun 用无条件 `update`（只 WHERE id），会出现：

```text
T1: Worker tx: SELECT → 看到 status = "running"
T2: Stop tx: UPDATE status='cancelling' → 提交
T3: Worker tx: UPDATE status='succeeded' WHERE id=runId → 覆盖成功！
```

Worker 的 succeeded 覆盖了 Stop 的 cancelling。用户看到"我点了停止，但系统显示成功"。

改为 `updateMany WHERE status='running'` 后：

```text
T1: Worker tx: updateMany WHERE status='running' → 等待行锁
T2: Stop tx: UPDATE status='cancelling' → 提交，释放行锁
T3: Worker tx: 重新评估 WHERE → status='cancelling' ≠ 'running' → count=0
```

Worker 不会覆盖 Stop。这是 PostgreSQL Read Committed 的标准行为。

这里的重点是：如果 run 已经 `cancelling`，即使 Worker 手里拿到了成功结果，也不能把项目标记为成功。Stop 后旧 run 只能 cancelled，不能 succeeded。

Run 终态到 Project.status 的映射：

| Run 终态 | Project.status |
|----------|---------------|
| succeeded | ready |
| cancelled | stopped |
| failed | failed |

```ts
const RUN_TO_PROJECT_STATUS: Record<string, string> = {
  succeeded: "ready",
  cancelled: "stopped",
  failed: "failed",
};
```

## 9. Agent Loop 协议

Agent loop 参数必须包含 `runId`：

```ts
await agentLoop({
  runId,
  projectId,
  sandbox,
  systemPrompt,
  userMessage,
});
```

### 9.1 检查点

检查点至少包括：

- 每轮 LLM 调用前。
- 每次 LLM 调用返回后。
- 每次 tool 执行前。
- 每次 tool 执行后。
- 每次 DB 写入前。
- 保存 conversation 前。
- 写 preview URL 前。
- 写 build log 前。
- 写 project status 前。

### 9.2 写权限检查（纯 DB 方案）

不使用 Redis 缓存。写权限校验直接查 DB。

#### 检查点校验（省 token）

在 LLM/tool 调用前检查，避免浪费后续 token：

```ts
async function assertRunWritable(runId: string) {
  const run = await prisma.projectRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (!run || run.status !== "running") {
    throw new RunNotWritableError(runId);
  }
}
```

开销：一次 SELECT，1-3ms。后续 LLM 调用 5-30s，比例上可以忽略。

检查点足够密集（每次 LLM 调用前、每次 tool 执行前），Stop 到达后最坏延迟 = 一次 LLM 调用 + 一次 tool 执行 ≈ 150s。在这个时间窗口内，Worker 可能执行了一些操作（写文件到 sandbox、写 build log），但这些都不会破坏系统一致性：

- sandbox 写入：Stop 后 sandbox 不复用，写了也白写。
- build log：归属到 runId，不影响项目状态。
- project.status：由 `finalizeRun` 条件更新保护，不会被覆盖。

真正需要保护的终态写入（project.status、run 终态）由 `finalizeRun` 的 `updateMany WHERE status='running'` 保证，不需要额外的事务 fencing。

#### Heartbeat 合并

heartbeat 可以在 assertRunWritable 内顺带更新（每 N 次检查点更新一次）：

```ts
let heartbeatCounter = 0;
const HEARTBEAT_INTERVAL = 5;

async function assertRunWritable(runId: string) {
  const run = await prisma.projectRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (!run || run.status !== "running") {
    throw new RunNotWritableError(runId);
  }

  heartbeatCounter++;
  if (heartbeatCounter % HEARTBEAT_INTERVAL === 0) {
    await prisma.projectRun.updateMany({
      where: { id: runId, status: "running" },
      data: { heartbeatAt: new Date() },
    });
  }
}
```

#### 为什么不用 Redis

| 维度 | Redis Cache-Aside | 纯 DB |
|------|------------------|-------|
| Stop 后最大脏写窗口 | cache TTL（最坏 60s） | 检查点间隔（最坏 ~150s，但脏写无害） |
| Redis 不可达时 | 需要降级逻辑 | 不受影响 |
| 组件依赖 | Redis + DB | 仅 DB |
| 每检查点开销 | Redis GET（0.1ms） | DB SELECT（1-3ms） |
| 正确性保证位置 | 仍需 finalizeRun 兜底 | finalizeRun 条件更新 |

LLM 调用 5-30 秒，tool 执行 1-120 秒。1-3ms 的 DB SELECT 在这个时间尺度下完全无感知。引入 Redis 只为节省这 1-3ms，但带来了缓存一致性问题、降级逻辑、额外组件依赖。不值得。

关键洞察：真正需要防止的"脏写"只有终态写入（project.status 被覆盖），而这由 `finalizeRun` 的条件更新天然保证。中间写入（sandbox 文件、build log）即使在 Stop 后发生也无害——sandbox 不复用，build log 归属 runId。因此不需要事务级 fencing 包裹每次写入。

Redis 在本系统中只用于：project lock（分布式互斥）和 SSE pub/sub（事件推送）。写权限校验不需要它。

### 9.3 当前外部调用自然返回

第一版不要求中断正在进行的 LLM 或 tool 调用。

流程是：

```text
1. Worker 发起 LLM/tool 调用
2. 用户 Stop，run.status -> cancelling
3. LLM/tool 自然返回
4. Worker 调用 assertRunWritable(runId)
5. assert 失败
6. Worker 丢弃返回结果
7. Worker finalize 为 cancelled
```

这就是 Soft Stop 的核心。

## 10. Stop 机制

### 10.1 API

推荐接口：

```text
POST /api/projects/:projectId/runs/:runId/stop
```

也可以保留兼容接口：

```text
POST /api/projects/:projectId/stop
```

兼容接口内部查询当前 active run。

### 10.2 Stop 流程

Stop API 只负责让 run 失去写权限。

```text
1. 校验项目归属
2. 查询 active run 或指定 runId
3. 如果 run.status = queued，直接改为 cancelled，并尝试 remove waiting/delayed job
4. 如果 run.status = running，改为 cancelling
5. 推送 SSE: run_status_changed
6. 返回 202 Accepted
```

示例：

```ts
await prisma.$transaction(async (tx) => {
  const run = await tx.projectRun.findFirst({
    where: {
      id: runId,
      projectId,
      status: { in: ["queued", "running"] },
    },
  });

  if (!run) return;

  if (run.status === "queued") {
    await tx.projectRun.update({
      where: { id: run.id },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return;
  }

  await tx.projectRun.update({
    where: { id: run.id },
    data: { status: "cancelling" },
  });
});
```

Stop 不需要操作 Redis。DB 状态变更后，Worker 在下一个检查点（assertRunWritable）会自动感知并退出。

### 10.3 Stop API 不做的事情

Stop API 不做这些事：

- 不 kill sandbox。
- 不改写项目文件。
- 不写入旧 run 的 tool 结果。
- 不把 running run 直接改成 succeeded / failed。
- 不试图 abort LLM 请求。
- 不依赖 BullMQ 立即停止 active job。

### 10.4 Stop 后的 sandbox

Stop 后旧 sandbox 视为不可复用（文件系统状态不可信）。

- Worker 自然结束后可以 best-effort kill。
- 如果 Worker 崩溃，Reaper 可以 best-effort kill。
- 下一次 run 必须创建新 sandbox，从 DB 恢复项目文件。

注意：只有 cancelled 的 run 的 sandbox 不可复用。succeeded/failed 的 run 的 sandbox 仍然可以被下一次 run 复用（见 Section 3.4）。

## 11. Delete 机制

Delete 仍然要严谨处理，因为 Stop 不强杀 Worker。

推荐第一版保守删除：

```text
DELETE /api/projects/:id
```

流程：

```text
1. 校验项目归属
2. 检查 active run
3. 如果存在 active run，返回 409（不做任何写入）
4. 获取 project lock
5. 锁内再次检查 active run（防止 step 2 和 step 4 之间有新 run 创建）
6. 如果仍有 active run，释放锁，返回 409
7. 移除 queued/delayed jobs by projectId
8. best-effort kill 无 active run 的 sandbox
9. delete project（级联删除 ProjectRun、Message 等子表）
10. 释放 project lock
```

注意：不在获取锁之前设置任何标记（如 `deleting=true`），避免"检查失败但标记已设"导致项目卡死。

Delete 判断能否删除必须基于 `ProjectRun`，不能只看 `Project.status`。

```ts
const activeRun = await prisma.projectRun.findFirst({
  where: {
    projectId,
    status: { in: ["queued", "running", "cancelling"] },
  },
});

if (activeRun) {
  return Response.json(
    { error: "Project has an active run" },
    { status: 409 }
  );
}
```

### 11.1 创建 Run 与 Delete 的 TOCTOU

```text
T1: DELETE 检查 active run → 没有
T2: 新消息到达 → 创建 run(queued) → 入队
T3: DELETE 获取锁 → 锁内再次检查 → 发现新 run → 返回 409
```

锁内 double-check 能捕获大部分情况。但如果创建 run 的 API 不获取 project lock，仍有极小窗口：

```text
T1: DELETE 获取锁 → 锁内检查 active run → 没有
T2: 创建 run API（不需要锁）→ 创建 run → 入队
T3: DELETE 执行 delete → 新 run 被级联删除
T4: Worker 消费 job → findUnique → 项目不存在 → return
```

第一版兜底：Worker 启动时检查项目和 run 是否存在。如果不存在，静默退出，不重试。这个极端场景的后果是"用户刚发的消息被吞"，但概率极低且用户可以重新发送。

如果未来需要更强保证，可以让创建 run 的 API 也获取 project lock，或引入 `project.deletedAt` 软删除。

### 11.2 后续可选：一键 Stop + Delete

如果希望 Delete 在用户点击 Stop 后立即可用，可以增加后台删除任务：

```text
project.deletedAt = now()（软删除，前端立即隐藏）
run -> cancelling
Worker/Reaper -> cancelled
DeleteWorker -> 真正物理删除
```

第一版不建议这么做，先返回 409 更简单。

## 12. Retry 策略

不要让所有错误都触发 BullMQ retry。

定义非重试错误：

```ts
class NonRetryableError extends Error {}
class RunNotWritableError extends NonRetryableError {}
class RunCancelledError extends NonRetryableError {}
class ProjectDeletedError extends NonRetryableError {}
class ProjectLockedError extends NonRetryableError {}
```

适合 retry：

- LLM 429。
- LLM timeout。
- E2B 临时网络错误。
- Redis/Postgres 短暂连接错误。

不适合 retry：

- 用户 Stop。
- run 已经不是 `queued` 或 `running`。
- project 已删除。
- 权限失败。
- project locked。
- old run retry。

Worker 每次 retry 启动时都必须重新读取 run 状态：

```ts
if (run.status !== "queued") {
  return;
}
```

如果旧 job 在 Stop 后 retry，看到 `cancelled` 或 `cancelling` 必须直接退出。

## 13. SSE 事件

SSE channel 可以继续按 project 维度：

```text
project:{projectId}:events
```

但每个事件必须携带 `runId`：

```ts
await publishEvent(projectId, {
  runId,
  type: "tool_call",
  data: { ... },
});
```

前端必须过滤：

```ts
if (event.runId !== currentRunId) {
  return;
}
```

这可以避免旧 run 的迟到事件污染新 run UI。

## 14. 并发场景分析

### 14.1 queued run 被 Stop

```text
T1: run.status = queued
T2: Stop API -> cancelled
T3: API 尝试 remove waiting/delayed job
T4: Worker 即使拿到 job，也发现 run 不再是 queued，直接退出
```

结果安全。

### 14.2 running run 被 Stop

```text
T1: Worker 正在 await LLM/tool
T2: Stop API -> cancelling
T3: LLM/tool 自然返回
T4: Worker 写入前 assertRunWritable 失败
T5: Worker 丢弃结果
T6: Worker finalize -> cancelled
```

结果安全。代价是当前外部调用可能继续消耗一点 token 或时间。

### 14.3 Stop 后用户立刻发起新 run

第一版策略：

```text
如果存在 active run，包括 cancelling，返回 409。
```

这能保证同一个 project 同时只有一个 run 在执行或收尾。

如果后续要优化体验，可以允许新 run 在旧 run `cancelling` 时创建，但那要求所有 project 写入都带 `currentRunId = runId` 条件，复杂度更高。第一版不建议。

### 14.4 Stop 后旧 run 产生结果

旧结果必须全部丢弃：

- 不写 ProjectFile。
- 不写 Project.previewUrl。
- 不写 Project.status 为成功。
- 不写当前 conversation 的最终 assistant message。
- 不污染新 run 的 SSE。

这正是 runId fencing 要解决的问题。

### 14.5 Stop 与 Delete 同时发生

DELETE 看到 run 是 `queued/running/cancelling`，返回 409。

等 Worker 或 Reaper 把 run 终态化为 `cancelled` 后，DELETE 才能继续。

如果希望“点击删除后自动等待停止完成再删”，需要另一个 DeleteWorker 或 tombstone 流程，不建议第一版加入。

### 14.6 Worker 崩溃

```text
T1: Worker 把 run 改成 running
T2: Worker 崩溃
T3: heartbeatAt 停止更新
T4: Reaper 扫描 stale running run
T5: Reaper 标记 failed
```

如果 run 已经是 `cancelling`，Reaper 超时后标记 `cancelled`。

## 15. Reaper

Reaper 是定时任务，用于处理 Worker 崩溃后的 stale run。

它不是正常 Stop 流程的一部分，只做兜底。

### 15.1 清理规则

```text
running + heartbeat 超时 -> failed
cancelling + updatedAt 超时 -> cancelled
queued + createdAt 超时 -> failed
```

### 15.2 事务要求

Reaper 不能用简单的 `$transaction([updateMany, project.update])` 盲写 project。

必须先检查 `updateMany.count`，只有确实抢到状态转移权，才能更新 project。

推荐：

```ts
await prisma.$transaction(async (tx) => {
  const updated = await tx.projectRun.updateMany({
    where: { id: run.id, status: "cancelling" },
    data: { status: "cancelled", finishedAt: now },
  });

  if (updated.count !== 1) {
    return;
  }

  await tx.project.update({
    where: { id: run.projectId },
    data: { status: "stopped" },
  });
});
```

否则会出现 run 状态没有更新成功，但 project 被错误改成 stopped/failed 的竞态。

### 15.3 Reaper 附带清理

Reaper 终态化 stale run 后，best-effort kill sandbox。E2B sandbox 本身有 TTL 会自动过期，所以这是加速清理，不做也不会造成数据问题。

```ts
if (run.sandboxId) {
  try {
    const sandbox = await Sandbox.connect(run.sandboxId);
    await sandbox.kill();
  } catch {
    // sandbox 可能已过期或不存在，忽略
  }
}
```

## 16. 第一版取舍

第一版建议：

- 保留 Worker。
- 引入 `ProjectRun`。
- 同一个 project 同时只允许一个 active run。
- Stop 采用 Soft Stop，不强制 abort 外部调用。
- Stop 后旧 sandbox 不可复用；succeeded/failed 的 sandbox 可复用。
- 检查点 assertRunWritable 拦截已失去写权限的 run，终态由 finalizeRun 条件更新保护。
- queued run 被 Stop 时可以直接改 `cancelled`。
- running run 被 Stop 时先改 `cancelling`，由 Worker 或 Reaper 终态化。
- Delete 遇到 active run 返回 409。
- 不做 force delete。
- 不做旧 run cancelling 与新 run 并发执行。
- Reaper 只做崩溃兜底。

这版的复杂度比强取消方案低很多，同时能挡住最危险的问题：Stop 后旧 run 继续写项目。

## 17. 被删除的复杂度

采用 Soft Stop + 纯 DB 校验后，可以不做或延后这些复杂能力：

| 不做的能力 | 原因 |
|---|---|
| 强制 abort LLM 请求 | 外部调用不一定可靠可取消，返回后丢弃即可 |
| Stop API kill sandbox | Stop 后 sandbox 不复用，清理可 best-effort |
| active BullMQ job 强制 remove | BullMQ active job 不能可靠同步停止 |
| project 级 cancel flag | 改成 run 级 DB 状态 |
| Redis cancel flag / 写权限缓存 | 纯 DB 校验，不需要 Redis 参与写权限判断 |
| 缓存一致性管理 | 没有缓存就没有一致性问题 |
| cancelled sandbox 状态修复 | 直接废弃，新 run 重建；succeeded/failed 的 sandbox 可复用 |
| Stop 后立即允许新 run 并发执行 | 第一版用 active run 串行降低复杂度 |
| force delete | 第一版 active run 返回 409 |

## 18. 最终目标

系统从：

```text
projectId 驱动的模糊后台任务
```

升级为：

```text
runId 驱动的、可隔离、可观测、可停止、可恢复的 Agent 执行系统
```

Stop 的最终语义不是：

```text
我一定要立刻杀死所有正在运行的东西。
```

而是：

```text
从现在开始，旧 run 的任何结果都不能再写入项目。
```

这是更容易实现、也更容易验证正确性的模型。
