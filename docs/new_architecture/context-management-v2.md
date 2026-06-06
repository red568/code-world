# v10 - 上下文管理系统 v2：全量落盘 + 动态组装

## 目标

替换当前的有损压缩器（context-compressor.ts），实现一套**不丢失信息**的上下文管理系统。核心思想：

- 每一步的完整信息结构化落盘
- 每次调 LLM 前，从落盘数据中按需组装最优上下文
- 利用代码的结构化特性（AST 骨架、依赖图、diff）实现高压缩比的信息表达

## 现状问题

当前 `context-compressor.ts` 的工作方式：

```
触发: 每 10 步检查一次，超过 60K token 时压缩
策略: 把旧的工具调用结果替换为 "[已执行 tool]"
保留: 最近 5 轮完整
```

问题：
1. 信息永久丢失 — Agent 无法回忆之前读过的文件内容或做过的决策
2. 无差别裁剪 — 不考虑"哪些历史对当前任务最有价值"
3. 被动触发 — 等满了再压，而非主动规划 token 预算

## 实施层次（从简单到复杂，每层可独立上线）

---

## Layer 1：结构化落盘 + 异步外部压缩（替换 compressor）

### 核心设计原则

1. **沙盒无状态化**：沙盒本身不负责持久存储，所有需要跨生命周期保留的数据都落盘到外部系统
2. **压缩外置**：压缩由外部服务异步完成，沙盒 Agent 只需等待结果返回后继续下一轮
3. **本地状态保持**：Repo Map 和 grep_ast 等结构化索引在沙盒内存中维护，不随压缩丢失
4. **周期性同步**：用户代码定期（而非仅在 write_file 时）同步到外部存储，确保数据安全

### 整体流程图

```
沙盒 (E2B Sandbox)                          外部系统 (Backend + DB/OSS)
┌─────────────────────┐                     ┌─────────────────────────────┐
│                     │                     │                             │
│  Agent Loop         │                     │  压缩服务                    │
│  ┌───────────────┐  │    ① 达到阈值       │  ┌─────────────────────┐    │
│  │ Step 1..N     │──┼──────────────────→  │  │ 存储全量历史         │    │
│  │               │  │    发送历史记录      │  │ 调 LLM 压缩          │    │
│  │ [Repo Map]    │  │                     │  │ 返回 summary         │    │
│  │ [grep_ast]    │  │    ② 返回 summary   │  └─────────────────────┘    │
│  │ [TaskSummary] │←─┼──────────────────── │                             │
│  │               │  │                     │  代码存储                    │
│  │ Step N+1..    │  │    ③ 周期性同步代码  │  ┌─────────────────────┐    │
│  │ (继续执行)    │──┼──────────────────→  │  │ DB / OSS             │    │
│  └───────────────┘  │                     │  └─────────────────────┘    │
│                     │                     │                             │
│  ┌───────────────┐  │    ④ 销毁前最终同步  │                             │
│  │ Lifecycle Hook│──┼──────────────────→  │  最终落盘:                   │
│  │ (pre-destroy) │  │    代码 + 未压缩历史 │  - 剩余 messages            │
│  └───────────────┘  │                     │  - 全量代码文件              │
└─────────────────────┘                     └─────────────────────────────┘
```

### 触发条件（双阈值策略）

压缩不再被动等待溢出，而是在以下任一条件满足时主动触发：

| 条件 | 阈值 | 说明 |
|------|------|------|
| 对话轮数 | 每 N 轮（默认 12 轮） | 轮数 = user message + assistant response 的完整往返 |
| Token 累积 | 超过 M tokens（默认 50K） | 基于 tiktoken 估算，包含 tool results |
| 取较先触发者 | — | 避免短对话但大量工具输出的场景漏掉 |

```typescript
// context-trigger.ts
interface CompressionTrigger {
  turnThreshold: number;      // 默认 12
  tokenThreshold: number;     // 默认 50000
  currentTurns: number;
  currentTokens: number;
}

function shouldTriggerCompression(trigger: CompressionTrigger): boolean {
  return trigger.currentTurns >= trigger.turnThreshold
    || trigger.currentTokens >= trigger.tokenThreshold;
}
```

### 三类数据的关系

一次 Run 结束后，外部系统中应该有:

┌─────────────────────────────────────────────────────────┐
│ 1. 全量历史对话记录                                      │
│                                                          │
│    完整的 messages[]，一条不丢                            │
│    包括: system prompt, user messages,                   │
│          assistant thinking, tool_calls, tool results    │
│    用途: 审计、回溯、重新压缩、调试                       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ 2. 压缩产物（summaries）                                 │
│                                                          │
│    由外部压缩服务生成                                     │
│    压缩完成后返回给沙盒 Agent，作为后续轮次的历史上下文    │
│    可能有多条（一次 run 中多次触发压缩）                   │
│    用途: Agent 继续工作时注入 / 跨 run 恢复               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ 3. 用户生成的代码文件                                    │
│                                                          │
│    周期性同步 + 最终同步确保不丢                          │
│    存储在外部 DB 或对象存储（OSS/S3）                     │
│    用途: 用户资产、下次 run 恢复文件系统、部署            │
└─────────────────────────────────────────────────────────┘

### 数据模型设计

```
ConversationHistory (全量历史 - 存储在外部 DB)
├── id
├── projectId
├── runId
├── messages: JSON          // 这一批的完整 messages
├── startStep: number       // 这批从第几步开始
├── endStep: number         // 到第几步结束
├── tokenCount: number      // 这批的 token 数（统计用）
├── isFinal: boolean        // 是否为沙盒销毁前最终存储
├── createdAt
└── 关系: 一个 run 可能有多条（压缩触发时 + 销毁前各存一批）

CompressionSummary (外部压缩服务产物)
├── id
├── projectId
├── runId
├── summary: string         // 压缩后的摘要文本
├── summaryTokens: number   // 摘要占多少 token
├── coversStepStart: number // 覆盖起始步骤
├── coversStepEnd: number   // 覆盖结束步骤
├── version: number         // 第几次压缩（1, 2, 3...）
├── modelUsed: string       // 压缩使用的模型
├── createdAt
└── 关系: 一个 run 可能有多条（每次压缩产生一条，最新的用于恢复）

ProjectFile (用户代码资产 - DB 或 OSS)
├── id
├── projectId
├── path: string            // "src/components/Hero.tsx"
├── content: string         // 文件完整内容
├── size: number            // 文件大小
├── syncSource: string      // "periodic" | "final" | "write_file"
├── updatedAt
└── 关系: 一个 project 有多个文件，path 唯一
```

### 写入时机（四种触发点）

```
时间线:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━→

Step 1    5       10    12(压缩触发)  15      20    25    28(结束/销毁)
 │        │        │        │          │       │     │      │
 │        │        │        ├─ ① 发送历史到外部 DB               │
 │        │        │        ├─ ② 外部异步压缩，返回 summary       │
 │        │        │        ├─ Agent 用 summary 替换旧 messages   │
 │        │        │        ├─ Agent 保留 Repo Map + grep_ast    │
 │        │        │        │                                     │
 ├────────┼────────┼────────┼──────────┼───────┼─────┼──────────┤
 │        ③                 ③                  ③                  │
 │     周期性代码同步（每 5 步或每 3 分钟）                        │
 ├────────────────────────────────────────────────────────────────┤
 │                                                                │
 │                                                   ④ 销毁前:    │
 │                                                   ├─ 最终代码全量同步
 │                                                   ├─ 未压缩的剩余 messages 存储
 │                                                   └─ 更新 run 状态
```

**四种写入触发点说明**：

| 触发点 | 时机 | 写入内容 | 是否阻塞 Agent |
|--------|------|----------|---------------|
| ① 压缩触发 | 轮数 ≥ 12 或 token ≥ 50K | 全量历史 messages → 外部 DB | 是（等待 summary 返回） |
| ② 压缩返回 | 外部完成压缩后 | summary 注入 Agent context | — |
| ③ 周期代码同步 | 每 5 步或每 3 分钟（取先到者） | 变更过的代码文件 → DB/OSS | 否（后台异步） |
| ④ 销毁前同步 | 沙盒生命周期 pre-destroy hook | 全量代码 + 剩余 messages | 是（必须完成才销毁） |

### 具体写入流程

#### ① 压缩触发时（达到阈值）

```typescript
// 沙盒侧：检测到需要压缩
async function onCompressionTrigger(ctx: AgentContext): Promise<string> {
  const { projectId, runId, messages, previousSummary, startStep, endStep } = ctx;

  // 调用外部 API（同步等待结果）
  const response = await fetch(`${BACKEND_URL}/api/internal/context/compress`, {
    method: "POST",
    body: JSON.stringify({
      projectId,
      runId,
      messages,              // 待压缩的原始 messages（全量）
      previousSummary,       // 上次压缩的 summary（如果有，用于增量压缩）
      startStep,
      endStep,
      // 告知外部服务需要保留哪些信息维度
      preserveHints: {
        recentErrors: true,
        keyDecisions: true,
        fileModifications: true,
      },
    }),
  });

  const { summary } = await response.json();

  // Agent 侧状态更新：
  // - 用 summary 替换掉旧的 messages（释放 token 空间）
  // - 保留 Repo Map 缓存（不受压缩影响）
  // - 保留 grep_ast 索引（不受压缩影响）
  // - 保留 TaskSummary（不受压缩影响）
  ctx.replaceHistoryWithSummary(summary, endStep);

  return summary;
}
```

```typescript
// 外部后端：接收并处理
async function handleCompress(req: Request): Promise<Response> {
  const { projectId, runId, messages, previousSummary, startStep, endStep, preserveHints } = req.body;

  // 1. 存全量历史（永不丢失）
  await db.conversationHistory.create({
    data: {
      projectId, runId, messages,
      startStep, endStep,
      tokenCount: estimateTokens(messages),
    },
  });

  // 2. 调 LLM 生成 summary（可以用更便宜的模型如 haiku）
  const summary = await compressWithLLM({
    previousSummary,
    messages,
    preserveHints,
    maxOutputTokens: 2000, // 压缩到 ~2000 token
  });

  // 3. 存压缩产物
  const prevVersion = await db.compressionSummary.count({ where: { projectId, runId } });
  await db.compressionSummary.create({
    data: {
      projectId, runId, summary,
      summaryTokens: estimateTokens(summary),
      coversSteps: `1-${endStep}`,  // 累积覆盖范围
      version: prevVersion + 1,
    },
  });

  // 4. 返回给沙盒 Agent
  return Response.json({ summary });
}
```

#### ② Agent 收到 summary 后继续执行

```typescript
// context-assembler.ts - 压缩后的 context 组装
function assemblePostCompression(ctx: AgentContext): ChatMessage[] {
  return [
    // Slot A: System prompt + tool definitions
    { role: "system", content: ctx.systemPrompt },

    // Slot B: 压缩摘要（替代所有旧 messages）
    { role: "system", content: `[历史上下文摘要]\n${ctx.compressionSummary}` },

    // Slot C: Repo Map（始终保留，不受压缩影响）
    { role: "system", content: `[项目代码骨架]\n${ctx.repoMap}` },

    // Slot D: TaskSummary 摘要（始终保留）
    { role: "system", content: `[任务状态]\n${ctx.taskSummarizer.toSlotD()}` },

    // Slot E: 压缩后产生的新 messages（从 step endStep+1 开始）
    ...ctx.recentMessages,
  ];
}
```

**关键点**：Repo Map 和 grep_ast 是沙盒内存中的结构化索引，不属于对话历史，因此压缩时不受影响。Agent 在压缩后仍能：
- 通过 Repo Map 了解项目整体结构
- 通过 grep_ast 进行符号搜索
- 通过 TaskSummary 了解任务进度和决策

#### ③ 周期性代码同步（后台异步）

```typescript
// code-sync.ts - 定时器 + 步数双重触发
class CodeSyncScheduler {
  private lastSyncStep: number = 0;
  private lastSyncTime: number = Date.now();
  private dirtyFiles: Set<string> = new Set();
  private syncInterval = 3 * 60 * 1000;  // 3 分钟
  private stepInterval = 5;               // 每 5 步

  // 每次 write_file 时标记脏文件
  markDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
  }

  // 每步结束时检查是否需要同步
  async checkAndSync(currentStep: number, projectId: string): Promise<void> {
    const timeSinceLastSync = Date.now() - this.lastSyncTime;
    const stepsSinceLastSync = currentStep - this.lastSyncStep;

    const shouldSync = this.dirtyFiles.size > 0 && (
      stepsSinceLastSync >= this.stepInterval ||
      timeSinceLastSync >= this.syncInterval
    );

    if (shouldSync) {
      // 后台异步，不阻塞 Agent
      this.syncInBackground(projectId);
    }
  }

  private async syncInBackground(projectId: string): Promise<void> {
    const filesToSync = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    this.lastSyncStep = currentStep;
    this.lastSyncTime = Date.now();

    // 批量同步（不等待结果，fire-and-forget）
    fetch(`${BACKEND_URL}/api/internal/files/sync-batch`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        files: await Promise.all(
          filesToSync.map(async (path) => ({
            path,
            content: await fs.readFile(join(PROJECT_DIR, path), "utf-8"),
          }))
        ),
      }),
    }).catch(err => logger.warn("Background sync failed, will retry next cycle", err));
  }
}
```

```typescript
// 外部后端：批量同步接口
// POST /api/internal/files/sync-batch
async function handleSyncBatch(req: Request): Promise<Response> {
  const { projectId, files } = req.body;

  // 使用事务批量 upsert
  await db.$transaction(
    files.map((file: { path: string; content: string }) =>
      db.projectFile.upsert({
        where: { projectId_path: { projectId, path: file.path } },
        update: { content: file.content, updatedAt: new Date() },
        create: { projectId, path: file.path, content: file.content },
      })
    )
  );

  return Response.json({ synced: files.length });
}
```

#### ④ 沙盒销毁前最终同步（Lifecycle Hook）

这是数据安全的最后一道保障。沙盒在被销毁之前**必须**完成以下操作：

```typescript
// sandbox-lifecycle.ts
class SandboxLifecycle {
  // 注册到 E2B sandbox 的 pre-destroy hook
  async onBeforeDestroy(ctx: AgentContext): Promise<void> {
    const { projectId, runId } = ctx;

    // 1. 全量代码文件同步（不依赖 dirtyFiles 标记，强制全量）
    const allFiles = await this.collectAllProjectFiles(ctx.projectDir);
    await fetch(`${BACKEND_URL}/api/internal/files/sync-final`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        files: allFiles,
        isFinal: true,  // 标记为最终态
      }),
    });

    // 2. 存储最后一轮未被压缩的历史信息
    const remainingMessages = ctx.getMessagesAfterLastCompression();
    if (remainingMessages.length > 0) {
      await fetch(`${BACKEND_URL}/api/internal/context/store-remaining`, {
        method: "POST",
        body: JSON.stringify({
          projectId,
          runId,
          messages: remainingMessages,
          startStep: ctx.lastCompressedStep + 1,
          endStep: ctx.currentStep,
        }),
      });
    }

    // 3. 更新 run 状态为已完成
    await fetch(`${BACKEND_URL}/api/internal/run/finalize`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        runId,
        status: "completed",
        totalSteps: ctx.currentStep,
        lastSummaryVersion: ctx.lastSummaryVersion,
      }),
    });

    logger.info("Pre-destroy sync completed", {
      projectId, files: allFiles.length,
      remainingMessages: remainingMessages.length,
    });
  }

  private async collectAllProjectFiles(projectDir: string): Promise<FileEntry[]> {
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json", ".md"];
    const files: FileEntry[] = [];

    for await (const entry of walk(projectDir, { skip: ["node_modules", ".git", "dist"] })) {
      if (extensions.some(ext => entry.path.endsWith(ext))) {
        files.push({
          path: relative(projectDir, entry.path),
          content: await fs.readFile(entry.path, "utf-8"),
        });
      }
    }
    return files;
  }
}
```

**容错设计**：如果沙盒意外崩溃（未触发 pre-destroy hook），外部系统仍然拥有：
- 最近一次压缩时存储的全量历史
- 最近一次周期同步的代码文件
- 数据丢失窗口 = min(5 步, 3 分钟) 的增量变更

### 恢复流程（新 Run 启动 / 沙盒重建）

```typescript
// restore.ts - 新 sandbox 启动时的恢复流程
async function restoreAgentState(projectId: string, newRunId: string): Promise<AgentContext> {

  // 1. 读取最新的 compression summary
  const latestSummary = await fetch(
    `${BACKEND_URL}/api/internal/context/latest-summary?projectId=${projectId}`
  ).then(r => r.json());

  // 2. 读取 summary 之后未压缩的 messages（如果有）
  const pendingMessages = await fetch(
    `${BACKEND_URL}/api/internal/context/pending-messages?projectId=${projectId}&afterStep=${latestSummary?.coversEndStep || 0}`
  ).then(r => r.json());

  // 3. 读取项目文件（恢复文件系统 — 代码本身是项目最完整的状态）
  const files = await fetch(
    `${BACKEND_URL}/api/internal/files/list?projectId=${projectId}`
  ).then(r => r.json());

  // 4. 恢复文件到沙盒文件系统（这是跨 run 认知的第一来源）
  for (const file of files) {
    await fs.mkdir(dirname(join(PROJECT_DIR, file.path)), { recursive: true });
    await fs.writeFile(join(PROJECT_DIR, file.path), file.content, "utf-8");
  }

  // 5. 重建 Repo Map（从代码文件生成 — 代码即认知）
  const repoMap = await generateRepoMap(PROJECT_DIR);

  // 6. 重建 grep_ast 索引
  const grepIndex = await buildGrepAstIndex(PROJECT_DIR);

  // 7. 组装初始 context
  return {
    projectId,
    runId: newRunId,
    compressionSummary: latestSummary?.summary || "",
    recentMessages: pendingMessages || [],
    repoMap,
    grepIndex,
    lastCompressedStep: latestSummary?.coversEndStep || 0,
    currentStep: (latestSummary?.coversEndStep || 0) + (pendingMessages?.length || 0),
  };
}
```

### 数据量估算

一次典型的 run（25 步）：

```
ConversationHistory:
  - 压缩触发 ~2 次 → 3 条记录（step 1-12, step 13-24, step 25）
  - 每条 ~50-100KB（JSON messages）
  - 总计 ~200-300KB

CompressionSummary:
  - 2 条记录（每次压缩产生一条）
  - 每条 ~3-6KB（纯文本摘要，~2000 token）

ProjectFile:
  - 10-20 个文件
  - 每个 1-10KB
  - 总计 ~100KB

周期性同步开销:
  - 每次同步仅传输 dirty files（增量）
  - 平均每次 ~20-50KB
  - 一次 run 中同步 3-5 次 → ~100-250KB 网络传输
```

一个活跃项目（10 次 iterate）：~3-5MB。完全不是负担。

### 沙盒内存中保持的状态（不随压缩丢失，独立于对话历史）

| 状态 | 用途 | 产出层 | 压缩时行为 | 沙盒销毁后恢复方式 |
|------|------|--------|-----------|-------------------|
| Repo Map 缓存 | 代码骨架导航 (Slot C) | L2 | 不受影响 | 文件恢复后重新生成 |
| grep_ast 索引 | 符号搜索 | L2 | 不受影响 | 文件恢复后重新索引 |
| Episodes 数组 | 历史检索召回 (Slot E) | L3 | 不受影响 | 不恢复，从空开始 |
| TaskSummary | 即时全局定位 (Slot D) | L3 | 不受影响 | 不恢复，从空开始（summary 提供历史认知） |
| dirtyFiles Set | 增量同步标记 | L1 | 不受影响 | 无需恢复（重启后全量同步一次） |

这些状态**不需要**随历史消息一起压缩——它们要么可以从代码文件重建（Repo Map、grep_ast），要么仅在单次 run 内有意义（Episodes、TaskSummary、dirtyFiles）。

压缩只做一件事：用 summary 替换旧的 messages，释放 token 空间给 Slot F（Recent Messages）。

### Prisma Schema 变更

```prisma
model ConversationHistory {
  id         String   @id @default(cuid())
  projectId  String
  runId      String
  messages   Json                    // 完整的 messages[]
  startStep  Int
  endStep    Int
  tokenCount Int                    // 统计用
  isFinal    Boolean  @default(false) // 是否为销毁前最终存储
  createdAt  DateTime @default(now())

  project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  @@index([projectId, runId])
  @@index([projectId, startStep])
}

model CompressionSummary {
  id              String   @id @default(cuid())
  projectId       String
  runId           String
  summary         String   @db.Text   // 压缩后的摘要文本
  summaryTokens   Int                 // 摘要 token 数
  coversStepStart Int                 // 覆盖起始步骤
  coversStepEnd   Int                 // 覆盖结束步骤
  version         Int                 // 第几次压缩
  modelUsed       String?             // 压缩用的模型（如 haiku）
  createdAt       DateTime @default(now())

  project         Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  @@index([projectId, version])
  @@index([projectId, runId])
}

model ProjectFile {
  id         String   @id @default(cuid())
  projectId  String
  path       String              // "src/components/Hero.tsx"
  content    String   @db.Text   // 文件完整内容
  size       Int?                // 文件大小（bytes）
  syncSource String   @default("periodic") // "periodic" | "final" | "write_file"
  updatedAt  DateTime @updatedAt
  createdAt  DateTime @default(now())

  project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  @@unique([projectId, path])
  @@index([projectId, updatedAt])
}
```

### 需求与实现对应关系

| 需求 | DB 表 | 写入时机 | 备注 |
|------|-------|----------|------|
| 全量历史对话 | ConversationHistory | 压缩触发时 + 沙盒销毁前 | 分批存，按 step 范围索引，永不丢失 |
| 压缩后的摘要 | CompressionSummary | 外部压缩服务生成后 | 返回给 Agent 继续使用，跨 run 恢复 |
| 用户生成的代码 | ProjectFile | 周期同步(每5步/3分钟) + 销毁前全量 | 外部 DB 或 OSS，用户资产永久保存 |

三者互相独立，任何一个丢了不影响另外两个。但组合起来可以：

- 完整重建任何时刻的 Agent 状态
- 用户随时查看/下载自己的代码
- 跨 run 无缝延续（代码文件 = 全量项目状态，summary = 历史上下文，Repo Map = 从代码重建的结构导航）

### Layer 1 验证标准

- [ ] 压缩触发后，Agent 仍能通过 Repo Map 定位文件（证明结构索引未丢失）
- [ ] 沙盒意外销毁后重建，代码文件丢失不超过最近 5 步的增量
- [ ] 外部压缩耗时 < 5s（使用 haiku 级模型），Agent 阻塞感知 < 可接受阈值
- [ ] 跨 run 恢复后，Agent 能正确理解之前的任务上下文（摘要质量人工评估）
- [ ] 周期性同步不影响 Agent 响应延迟（后台异步，无阻塞）

---

## 跨层数据流与协作机制

在进入 Layer 2-4 之前，先明确各层之间的数据流动关系以及它们如何与 Layer 1 配合。

### 统一的 Context Slot 分配

每次调 LLM 前，Context Assembler 按以下固定顺序组装 slots：

```
┌─────────────────────────────────────────────────────────────┐
│ Slot A: System Prompt + Tool Definitions      (~3500 token) │  固定
├─────────────────────────────────────────────────────────────┤
│ Slot B: Compression Summary                   (~2000 token) │  Layer 1 产出
├─────────────────────────────────────────────────────────────┤
│ Slot C: Repo Map (代码骨架)                    (~1000 token) │  Layer 2 产出
├─────────────────────────────────────────────────────────────┤
│ Slot D: Task Summary (任务状态)                 (~300 token)  │  Layer 3 产出
├─────────────────────────────────────────────────────────────┤
│ Slot E: Retrieved Episodes (检索召回)           (动态分配)    │  Layer 3 产出
├─────────────────────────────────────────────────────────────┤
│ Slot F: Recent Messages (最近对话)              (剩余空间)    │  Layer 1 维护
├─────────────────────────────────────────────────────────────┤
│ [预留] Output Reserve                          (~4096 token) │  模型输出
└─────────────────────────────────────────────────────────────┘
```

### 各层产出物的生命周期

| 产出物 | 产出层 | 存活位置 | 压缩时是否丢失 | 沙盒销毁后恢复方式 |
|--------|--------|----------|---------------|-------------------|
| Compression Summary | L1 | 外部 DB | 否（就是压缩产物） | 从 DB 读取 |
| Repo Map | L2 | 沙盒内存 | 否（不属于对话历史） | 文件恢复后重新生成 |
| Episodes | L3 | 仅沙盒内存 | 否（不属于对话历史） | 不恢复，从空开始 |
| TaskSummary | L3 (子模块) | 仅沙盒内存 | 否（不属于对话历史） | 不恢复，从空开始 |

### Episodes 策略（仅沙盒内存）

Episodes 是 Layer 3 检索的核心数据源，**仅在沙盒内存中维护**，不持久化到外部 DB。

**为什么不持久化：**
- 跨 run 时 Agent 靠恢复的代码文件（最完整的项目状态）+ CompressionSummary（操作历史浓缩）获得认知，不需要逐步检索上一次 run 的操作细节
- 当前 run 内的检索需求 → Episodes 在内存中实时构建，完全够用
- 如果 summary 遗漏了某个细节 → Agent 重新 read_file，成本仅 1-2 步，可接受
- 外部 DB 只需存最原始的三样东西：ConversationHistory + CompressionSummary + ProjectFile

**数据结构（内存中）：**

```typescript
interface Episode {
  stepNumber: number;
  toolName: string;
  toolSuccess: boolean;
  relatedFiles: string[];
  relatedSymbols: string[];
  resultSummary: string;
  codeChange?: { file: string; type: "create" | "modify" | "delete" };
  thinking: string;
}
```

**生命周期：**
- 沙盒启动 → Episodes = 空数组
- 每步执行后 → push 新 Episode
- 压缩触发 → Episodes 不受影响（不属于 messages），继续累积
- 沙盒销毁 → Episodes 自然消失（信息已被 summary 覆盖）

### Task Summary 策略（Layer 3 子模块 — 仅沙盒内存）

TaskSummary 是 Episodes 的聚合视图，纯内存对象，不持久化到外部。原因：
- 跨 run 时 Agent 通过代码文件（项目最完整的状态）+ summary（Slot B）+ Repo Map（Slot C）已能获得足够的历史认知
- TaskSummary 的所有字段（goal、phase、filesWritten、decisions）都可从 summary 中获取
- 它的唯一价值是在单次 run 内提供压缩后的即时全局定位（~200 token，零 IO 开销）

沙盒销毁后 TaskSummary 自然消失，新 run 从空对象开始积累。

### 更新后的完整恢复流程

跨 run 的认知来源优先级：**代码文件 > Repo Map > Summary > pending messages**

代码本身是项目最完整的状态快照——它包含了所有最终决策的结果。Summary 补充"为什么这么做"的上下文，Repo Map 提供全局导航，三者配合让 Agent 无需回溯细粒度历史就能继续工作。

```typescript
async function restoreAgentState(projectId: string, newRunId: string): Promise<AgentContext> {
  // Layer 1: 从外部 DB 恢复基础数据
  const latestSummary = await fetchLatestSummary(projectId);
  const pendingMessages = await fetchPendingMessages(projectId, latestSummary?.coversStepEnd);
  const files = await fetchProjectFiles(projectId);
  await restoreFilesToDisk(files);  // 代码文件 = 项目最完整的状态

  // Layer 2: 从代码文件重建结构化认知
  const repoMap = await generateRepoMap(PROJECT_DIR);   // 代码骨架 → Agent 全局导航
  const grepIndex = await buildGrepAstIndex(PROJECT_DIR); // 符号索引 → 精准定位

  // Layer 3: Episodes 和 TaskSummary 从空开始（纯内存，不跨 run）
  const episodes: Episode[] = [];
  const taskSummarizer = new TaskSummarizer();

  // Agent 的跨 run 认知 = 代码文件（全量状态）+ summary（历史上下文）+ Repo Map（结构导航）
  return { latestSummary, pendingMessages, repoMap, grepIndex, episodes, taskSummarizer };
}
```

### 压缩触发时的完整动作清单

```
触发条件: 轮数 >= 12 OR token >= 50K
├── Layer 1: 发送 messages → 外部 DB 存储 + LLM 压缩 → 返回 summary
└── Agent 侧: 用 summary 替换旧 messages，保留 Repo Map / grep_ast / Episodes / TaskSummary
```

### 沙盒销毁前的完整动作清单

```
触发: pre-destroy lifecycle hook
├── Layer 1: 全量代码同步 + 剩余 messages 存储 + run 状态更新
└── 确保以上全部完成后才允许沙盒销毁
```

---

## Layer 2：Repo Map 集成（代码骨架视图）

**目标**：给 Agent 一个全局代码导航能力，不用逐个 read_file 也能了解项目结构

**依赖**：Layer 1 完成

### 2.1 E2B Template 改动

在 `e2b.Dockerfile` 中加装 Python 环境：

```dockerfile
# 在现有 Node.js 环境基础上加装
RUN apt-get update && apt-get install -y python3-minimal python3-pip && \
    pip3 install tree-sitter grep-ast networkx --break-system-packages && \
    rm -rf /var/lib/apt/lists/*

# 复制 repomap 工具
COPY agent-runtime/tools/python/ /agent-runtime/tools/python/
```

### 2.2 Python 工具脚本

```python
# e2b-template/agent-runtime/tools/python/repomap_service.py

"""
精简版 Repo Map 生成器
从 aider 的 repomap.py 提取核心逻辑，独立运行无外部依赖（除 tree-sitter）

输入: JSON stdin {"repo_path": "...", "max_tokens": 1024, "focus_files": [...]}
输出: JSON stdout {"map": "...", "tokens": N, "files_count": N}
"""

import sys
import json
import os
from pathlib import Path

# tree-sitter 相关导入
from grep_ast import TreeContext, filename_to_lang
from tree_sitter_languages import get_language, get_parser


def get_repo_map(repo_path: str, max_tokens: int = 1024,
                 focus_files: list[str] = None) -> dict:
    """生成仓库的结构骨架"""
    src_path = Path(repo_path) / "src"
    if not src_path.exists():
        src_path = Path(repo_path)

    # 收集所有源码文件
    extensions = {".ts", ".tsx", ".js", ".jsx", ".css"}
    all_files = []
    for ext in extensions:
        all_files.extend(src_path.rglob(f"*{ext}"))

    # 排除 node_modules
    all_files = [f for f in all_files if "node_modules" not in str(f)]

    if not all_files:
        return {"map": "No source files found.", "tokens": 0, "files_count": 0}

    # 对每个文件提取骨架
    skeleton_lines = []
    total_tokens = 0

    for filepath in sorted(all_files):
        rel_path = filepath.relative_to(repo_path)
        lang = filename_to_lang(str(filepath))
        if not lang:
            continue

        try:
            code = filepath.read_text(encoding="utf-8")
            # 使用 tree-sitter 提取定义
            definitions = extract_definitions(code, lang)

            if definitions:
                skeleton_lines.append(f"\n## {rel_path}")
                for defn in definitions:
                    skeleton_lines.append(f"  {defn}")
                    total_tokens += len(defn) // 4

                if total_tokens >= max_tokens:
                    skeleton_lines.append(f"\n... (truncated at {max_tokens} tokens)")
                    break
        except Exception:
            # 解析失败跳过
            continue

    map_text = "\n".join(skeleton_lines)
    return {
        "map": map_text,
        "tokens": total_tokens,
        "files_count": len(all_files),
    }


def extract_definitions(code: str, lang: str) -> list[str]:
    """从代码中提取函数/类/接口/type 定义的签名行"""
    try:
        parser = get_parser(lang)
        tree = parser.parse(bytes(code, "utf-8"))
    except Exception:
        return []

    definitions = []
    # 定义节点类型（TypeScript/JavaScript）
    def_types = {
        "function_declaration",
        "method_definition",
        "class_declaration",
        "interface_declaration",
        "type_alias_declaration",
        "export_statement",
        "lexical_declaration",  # const/let with arrow functions
    }

    def visit(node, depth=0):
        if depth > 3:  # 不递归太深
            return
        if node.type in def_types:
            # 取第一行作为签名
            first_line = code[node.start_byte:node.end_byte].split("\n")[0]
            if len(first_line) > 120:
                first_line = first_line[:120] + "..."
            definitions.append(first_line)
        for child in node.children:
            visit(child, depth + 1)

    visit(tree.root_node)
    return definitions[:50]  # 单文件最多 50 个定义


if __name__ == "__main__":
    # CLI 模式: python repomap_service.py <repo_path> [max_tokens]
    if len(sys.argv) >= 2:
        repo_path = sys.argv[1]
        max_tokens = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
        result = get_repo_map(repo_path, max_tokens)
        print(json.dumps(result, ensure_ascii=False))
    else:
        # Stdin JSON 模式
        input_data = json.loads(sys.stdin.read())
        result = get_repo_map(**input_data)
        print(json.dumps(result, ensure_ascii=False))
```

### 2.3 Node.js 工具注册

在 tools.ts 中新增两个工具：

```typescript
// 新增工具定义
{
  type: "function" as const,
  function: {
    name: "get_repo_map",
    description: "获取项目源码的结构骨架视图（函数签名、组件定义、类型声明、导入关系）。用于快速了解项目整体架构，无需逐个读取文件。",
    parameters: {
      type: "object",
      properties: {
        max_tokens: {
          type: "number",
          description: "骨架的最大 token 数，默认 1024。需要更多细节时可以增大。",
        },
      },
    },
  },
},
{
  type: "function" as const,
  function: {
    name: "search_symbol",
    description: "在项目代码中搜索符号（函数名、类名、变量名、类型名）的定义位置和引用关系。比 read_file 更精准，适合定位特定代码。",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "要搜索的符号名或模式",
        },
        scope: {
          type: "string",
          description: "限定搜索范围，如 'src/components/' 或 '*.tsx'",
        },
      },
      required: ["pattern"],
    },
  },
},
```

工具执行实现：

```typescript
// tools.ts 中新增
import { execFile } from "node:child_process";

async function executeGetRepoMap(
  args: { max_tokens?: number },
  ctx: ToolContext
): Promise<ToolResult> {
  const maxTokens = args.max_tokens || 1024;

  return new Promise((resolve) => {
    execFile(
      "python3",
      ["/agent-runtime/tools/python/repomap_service.py", ctx.projectDir, String(maxTokens)],
      { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            output: `Repo map generation failed: ${stderr || error.message}`,
          });
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve({ success: true, output: result.map });
        } catch {
          resolve({ success: true, output: stdout });
        }
      }
    );
  });
}

async function executeSearchSymbol(
  args: { pattern: string; scope?: string },
  ctx: ToolContext
): Promise<ToolResult> {
  const scopeArg = args.scope || "src/";
  const searchDir = join(ctx.projectDir, scopeArg);

  return new Promise((resolve) => {
    execFile(
      "python3",
      ["-m", "grep_ast", args.pattern, searchDir],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024, cwd: ctx.projectDir },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({
            success: false,
            output: `Search failed: ${stderr || error.message}`,
          });
          return;
        }
        const output = stdout.slice(0, 3000);
        resolve({ success: true, output: output || "No matches found." });
      }
    );
  });
}
```

### 2.4 Context Assembler 中的 Repo Map 自动注入

对应统一 Slot 分配中的 **Slot C**：

```typescript
// context-assembler.ts 扩展

interface AssemblerConfig {
  // ... Layer 1 的配置
  repoMapBudget: number;        // Repo Map 的 token 预算（默认 1000）
  autoInjectRepoMap: boolean;   // 是否在每次组装时自动注入骨架
}

class ContextAssembler {
  private cachedRepoMap: string | null = null;
  private repoMapHash: string | null = null;

  // Slot C: Repo Map 注入
  private assembleSlotC(remainingBudget: number): { message: ChatMessage | null; tokensUsed: number } {
    if (!this.config.autoInjectRepoMap || !this.cachedRepoMap) {
      return { message: null, tokensUsed: 0 };
    }

    const tokens = this.estimateTokens(this.cachedRepoMap);
    if (tokens > remainingBudget) {
      // 预算不够时截断
      const truncated = this.truncateToTokens(this.cachedRepoMap, remainingBudget);
      return {
        message: { role: "system", content: `[项目代码骨架]\n${truncated}` },
        tokensUsed: remainingBudget,
      };
    }

    return {
      message: { role: "system", content: `[项目代码骨架]\n${this.cachedRepoMap}` },
      tokensUsed: tokens,
    };
  }

  // 更新缓存的 Repo Map（由 loop.ts 在首步或文件变更后调用）
  setRepoMap(map: string): void {
    this.cachedRepoMap = map;
  }
}
```

**与 Layer 1 的配合**：
- 压缩触发时，Repo Map 缓存不受影响（不属于 messages）
- 沙盒重建时，文件恢复完毕后立即调用 `generateRepoMap()` 重新生成并 `setRepoMap()`
- Repo Map 的 token 预算可根据任务阶段动态调节（planning 阶段多给，implementing 阶段少给）

### 2.5 Layer 2 验证标准

- [ ] Agent 在"给项目加一个新页面"任务中，是否能不调 list_files + 多次 read_file 就直接定位到正确位置
- [ ] 对比有无 Repo Map 时的平均 read_file 调用次数（期望减少 50%+）
- [ ] Python 冷启动延迟测量（期望 < 1s，只在首次调用时触发）
- [ ] Repo Map 输出质量人工评估（是否包含了关键的函数签名和组件结构）

---

## Layer 3：多路召回 + 符号关联

**目标**：检索精度从"只靠文件名匹配"提升到"理解代码语义关系"

**依赖**：Layer 1 + Layer 2

**与 Layer 1 的关键配合点**：
- Layer 3 的检索对象是 **Episodes**（结构化元数据），而非 raw messages
- 压缩只清理对话历史中的 messages，Episodes 在沙盒内存中保留不受影响
- 这意味着即使发生多次压缩，Agent 仍能通过 Episodes 召回任意历史步骤的文件/符号关联信息
- 对应统一 Slot 分配中的 **Slot E**（Retrieved Episodes）

### 3.1 增强 Episode 元数据提取

利用 Repo Map 的 tree-sitter 能力，在记录 Episode 时同时提取符号信息：

```typescript
// episode-recorder.ts 增强

class EpisodeRecorder {
  // 新增：从 read_file 的结果中提取符号
  private extractSymbols(toolName: string, result: ToolResult): string[] {
    if (toolName !== "read_file" || !result.success) return [];

    const symbols: string[] = [];
    const content = result.output;

    // 正则提取（轻量级，不依赖 tree-sitter）
    // 函数/方法定义
    const funcMatches = content.matchAll(
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g
    );
    for (const m of funcMatches) symbols.push(m[1]);

    // 箭头函数 / const 组件
    const constMatches = content.matchAll(
      /(?:export\s+)?const\s+(\w+)\s*[=:]/g
    );
    for (const m of constMatches) symbols.push(m[1]);

    // interface / type
    const typeMatches = content.matchAll(
      /(?:export\s+)?(?:interface|type)\s+(\w+)/g
    );
    for (const m of typeMatches) symbols.push(m[1]);

    return [...new Set(symbols)];
  }
}
```

### 3.2 多路召回融合

扩展 context-assembler 的 `retrieveRelevant` 方法：

```typescript
// context-assembler.ts 增强检索

private retrieveRelevant(
  episodes: Episode[],
  currentMessage: string,
  recentMessages: OpenAI.ChatCompletionMessageParam[],
  budget: number
): string[] {
  const mentionedFiles = this.extractMentionedFiles(currentMessage, recentMessages);
  const mentionedSymbols = this.extractMentionedSymbols(currentMessage, recentMessages);

  const scored = episodes.map(ep => {
    let score = 0;

    // 路径 1: 文件关联 (权重 0.35)
    const fileOverlap = ep.relatedFiles.filter(f => mentionedFiles.has(f)).length;
    score += fileOverlap * 10 * 0.35;

    // 路径 2: 符号关联 (权重 0.25)
    const symbolOverlap = (ep.relatedSymbols || [])
      .filter(s => mentionedSymbols.has(s)).length;
    score += symbolOverlap * 8 * 0.25;

    // 路径 3: 错误关联 (权重 0.20)
    if (this.isErrorContext(currentMessage)) {
      if (!ep.toolSuccess) score += 8 * 0.20;
      if (ep.toolName === "run_shell") score += 5 * 0.20;
    }

    // 路径 4: 代码变更关联 (权重 0.15)
    if (ep.codeChange && mentionedFiles.has(ep.codeChange.file)) {
      score += 12 * 0.15;
    }

    // 路径 5: 时间衰减 (权重 0.05)
    const recency = Math.exp(-0.05 * (episodes.length - ep.stepNumber));
    score += recency * 5 * 0.05;

    return { episode: ep, score };
  });

  // 排序 + 按预算填充（同 Layer 1）
  return this.fillByBudget(scored, budget);
}

private extractMentionedSymbols(
  currentMessage: string,
  recentMessages: OpenAI.ChatCompletionMessageParam[]
): Set<string> {
  const symbols = new Set<string>();
  const allText = currentMessage + recentMessages
    .map(m => typeof m.content === "string" ? m.content : "")
    .join(" ");

  // 匹配 PascalCase（组件名）和 camelCase（函数名）
  const matches = allText.match(/\b[A-Z][a-zA-Z0-9]+\b/g); // PascalCase
  if (matches) matches.forEach(s => symbols.add(s));

  const camelMatches = allText.match(/\b[a-z][a-zA-Z0-9]{3,}\b/g); // camelCase (4+字符)
  if (camelMatches) camelMatches.forEach(s => symbols.add(s));

  return symbols;
}

private isErrorContext(message: string): boolean {
  const errorKeywords = ["错误", "error", "Error", "失败", "fix", "bug", "问题", "报错"];
  return errorKeywords.some(k => message.includes(k));
}
```

### 3.3 动态精度控制

根据预算决定每个 Episode 展示多少细节：

```typescript
private formatEpisodeAdaptive(ep: Episode, budget: "full" | "medium" | "minimal"): string {
  switch (budget) {
    case "full":
      // 完整：思考 + 工具 + 结果摘要 + 涉及符号
      return [
        `[Step ${ep.stepNumber}] ${ep.thinking}`,
        `  → ${ep.toolName}(${ep.relatedFiles.join(", ")})`,
        `  → ${ep.resultSummary}`,
        ep.relatedSymbols?.length ? `  → 符号: ${ep.relatedSymbols.join(", ")}` : "",
      ].filter(Boolean).join("\n");

    case "medium":
      // 中等：工具 + 结果
      return `[Step ${ep.stepNumber}] ${ep.toolName}(${ep.relatedFiles[0] || ""}) → ${ep.resultSummary}`;

    case "minimal":
      // 极简：一行描述
      return `[Step ${ep.stepNumber}] ${ep.toolSuccess ? "✓" : "✗"} ${ep.toolName}`;
  }
}
```

### 3.4 Task Summary — Episodes 的聚合视图（Slot D）

TaskSummary 本质上是对 Episodes 数组的实时聚合，为 Agent 提供 ~200 token 的即时定位。它不是独立的一层，而是 Episode 系统的一个输出视角。

**设计原则**：仅沙盒内存维护，零 IO、零 LLM、不跨 run、不持久化。

```typescript
// 内嵌在 episode-recorder.ts 或独立为 task-summary.ts

interface TaskSummary {
  userGoal: string;
  currentPhase: string;       // "planning" | "implementing" | "debugging" | "polishing"
  totalSteps: number;
  filesWritten: string[];     // 最近 10 个
  recentDecisions: Array<{ step: number; decision: string; reason: string }>;
}

class TaskSummarizer {
  private summary: TaskSummary = {
    userGoal: "",
    currentPhase: "planning",
    totalSteps: 0,
    filesWritten: [],
    recentDecisions: [],
  };

  // 每步后调用，纯规则更新
  update(episode: Episode): void {
    this.summary.totalSteps++;

    if (episode.codeChange) {
      const file = episode.codeChange.file;
      if (!this.summary.filesWritten.includes(file)) {
        this.summary.filesWritten.push(file);
        if (this.summary.filesWritten.length > 10) {
          this.summary.filesWritten = this.summary.filesWritten.slice(-10);
        }
      }
    }

    // 根据工具使用模式自动推断阶段
    if (this.summary.totalSteps <= 2) {
      this.summary.currentPhase = "planning";
    } else if (!episode.toolSuccess && episode.toolName === "run_shell") {
      this.summary.currentPhase = "debugging";
    } else if (episode.codeChange) {
      this.summary.currentPhase = "implementing";
    }
  }

  // 生成 Slot D 内容（~150-200 token）
  toSlotD(): string {
    const s = this.summary;
    const lines: string[] = [];
    if (s.userGoal) lines.push(`目标: ${s.userGoal}`);
    lines.push(`阶段: ${s.currentPhase} | 已完成 ${s.totalSteps} 步`);
    if (s.filesWritten.length > 0) {
      lines.push(`已写入: ${s.filesWritten.slice(-5).join(", ")}`);
    }
    if (s.recentDecisions.length > 0) {
      lines.push(`决策: ${s.recentDecisions.map(d => d.decision).join("; ")}`);
    }
    return lines.join("\n");
  }

  setUserGoal(goal: string): void { this.summary.userGoal = goal; }

  addDecision(step: number, decision: string, reason: string): void {
    this.summary.recentDecisions.push({ step, decision, reason });
    if (this.summary.recentDecisions.length > 3) {
      this.summary.recentDecisions = this.summary.recentDecisions.slice(-3);
    }
  }
}
```

**生命周期**：随沙盒生灭。新 run 从空开始，Agent 靠代码文件（Repo Map 从中生成）+ summary（Slot B）获取跨 run 认知。压缩后 TaskSummary 不受影响（内存对象，不属于对话历史）。

### 3.5 Layer 3 验证标准

- [ ] 构造测试场景：Agent 在 step 5 读了 `PaymentService.ts`，step 15 用户说"修改 processPayment 函数"
  - 旧方案：Agent 需要重新 read_file
  - 新方案：assembler 自动召回 step 5 的相关信息
- [ ] 符号匹配准确率人工评估（抽样 20 个 case）
- [ ] 对比 Layer 1 vs Layer 3 在跨文件修改任务上的完成质量
- [ ] 对比有无 TaskSummary (Slot D) 时，压缩后第一步 Agent 的定位准确性
- [ ] 确认 toSlotD() 的 token 开销 < 300 token
