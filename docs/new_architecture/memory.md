# V8 - Memory 机制设计

## 一、问题定义

### 1.1 Memory 的定位

Memory 在本项目中的核心作用：**从历史中提炼出规则**。

与 CompressionSummary 的职责分工：

| | CompressionSummary | ProjectMemory |
|--|--|--|
| 回答的问题 | "上次 run 里我做了什么" | "这个项目有哪些不可违背的约束" |
| 类比 | 工作日志 | 项目规范文档 |
| 生命周期 | 每次 run 产生新的，旧的可能被新版本覆盖 | 累积式，跨所有 run 持续生效 |
| 信息密度 | ~6000 token 的叙事 | 30-80 条 × 30 字的结构化规则 |
| 信息类型 | 操作历史（做了什么、为什么这么做） | 约束与决策（什么必须遵守） |

Memory 不是"记住历史"——那是 summary 的活。Memory 是**从历史中提炼出长期有效的规则**。

### 1.2 要解决的问题

1. **项目约束跨 Run 丢失** — 用户说过"导航栏要固定"、"不要动画"，新 Run 的 Agent 不知道这些约束，可能做出违背用户意图的修改
2. **没有跨 Project 的用户偏好记忆** — 用户在 Project A 说"我喜欢深色主题"，在 Project B 又要重复一遍
3. **没有从失败中学习的机制** — Build 失败 → 修复 → 成功，这个经验没有沉淀

---

## 二、设计原则

### 2.1 与 context-management-v2 深度集成

Memory 不是独立系统，而是压缩流程的自然延伸：
- **提取与压缩同步** — 在同一次 LLM 调用中完成 summary 生成 + facts 提取，零额外成本
- **纳入统一 Slot 体系** — ProjectMemory 占据 Slot B'，有明确的 token 预算
- **淘汰与压缩联动** — 每次压缩时同步清理过时 facts

### 2.2 自动注入 + 可选主动写入

- **底线保障** — 所有 facts 每次自动注入，Agent 无需主动 recall 也不会遗漏约束
- **灵活扩展** — 提供 `remember` 工具，Agent 在对话中实时感知到重要约束时可立刻写入
- **不依赖 Agent 判断力** — 自动注入确保 constraint 类 facts 一定被看到

### 2.3 渐进式增强，不引入外部依赖

不使用 Mem0、Letta、MCP Server 等外部框架。基于 Prisma + PostgreSQL 做增强。

### 2.4 可追溯、可调试

每条 memory 记录 source 字段，方便追溯来源和调试。

---

## 三、整体架构

### 3.1 三层 Memory 体系

```
┌─────────────────────────────────────────────────────────────┐
│  Phase 1: ProjectMemory（项目级结构化记忆）                    │
│  从压缩对话中提取关键约束和决策                                 │
│  触发时机：压缩触发时（与 summary 同一次 LLM 调用）              │
│  作用范围：单个 project 内跨 run                               │
├─────────────────────────────────────────────────────────────┤
│  Phase 2: UserPreference（用户级偏好记忆）                     │
│  跨项目记住用户的通用偏好                                       │
│  触发时机：每次 run 结束时                                     │
│  作用范围：同一 user 的所有 projects                           │
├─────────────────────────────────────────────────────────────┤
│  Phase 3: BuildErrorPattern（错误-修复知识库，可选）           │
│  从失败中学习，积累错误修复经验                                 │
│  触发时机：build 失败后成功修复时                               │
│  作用范围：全局共享                                            │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 与 context-management-v2 的关系

```
Context Slot 分配（1M window）：
┌─────────────────────────────────────────────────────────────┐
│ Slot A: System Prompt + Tool Defs + UserPreference  (~5500) │  ← Phase 2 注入点
├─────────────────────────────────────────────────────────────┤
│ Slot B: Compression Summary                         (~6000) │
├─────────────────────────────────────────────────────────────┤
│ Slot B': ProjectMemory (跨 Run facts)               (~800)  │  ← Phase 1 注入点
├─────────────────────────────────────────────────────────────┤
│ Slot C: Repo Map                                    (~5000) │
├─────────────────────────────────────────────────────────────┤
│ Slot D: Task Summary                                (~500)  │
├─────────────────────────────────────────────────────────────┤
│ Slot E: Retrieved Episodes                          (~10000)│
├─────────────────────────────────────────────────────────────┤
│ Slot F: Recent Messages                             (剩余)  │
├─────────────────────────────────────────────────────────────┤
│ [预留] Output Reserve                               (~8192) │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 数据流全景

```
压缩触发（35轮 / 500K token）
  │
  ├─→ 发送 messages + 现有 facts 到外部压缩服务
  │
  ├─→ 一次 LLM 调用，输出:
  │     {
  │       "summary": "叙事性摘要...（~6000 token）",
  │       "new_facts": [...],           ← 新提取的 facts
  │       "obsolete_fact_ids": [...]    ← 标记过时的旧 facts
  │     }
  │
  ├─→ summary → 返回沙箱 Agent（Slot B）
  ├─→ new_facts → 写入 ProjectMemory 表
  └─→ obsolete_fact_ids → 从 ProjectMemory 表删除
```

### 3.4 与现有系统的关系

| 表 | 职责 | 生命周期 | 读者 |
|---|---|---|---|
| `ConversationHistory` | 全量对话历史 | 永久（审计/回溯） | 压缩服务 |
| `CompressionSummary` | 压缩后的叙事摘要 | 跨 Run 延续 | Agent（Slot B） |
| `ProjectMemory` | 项目约束/决策 facts | 永久（直到 project 删除或被淘汰） | Agent（Slot B'） |
| `UserPreference` | 用户通用偏好 | 永久（直到 user 删除） | Agent（Slot A） |
| `ProjectFile` | 用户代码资产 | 永久 | Agent + 用户 |

---

## 四、Phase 1：ProjectMemory（项目级结构化记忆）

### 4.1 核心思路

在压缩的同一次 LLM 调用中，同时完成：
- 生成 summary（叙事性摘要）
- 提取 new facts（新发现的约束/决策）
- 标记 obsolete facts（已过时的旧规则）

零额外 LLM 成本，三个产出共享同一份输入（待压缩的 messages）。

### 4.2 Schema 设计

```prisma
model ProjectMemory {
  id        String   @id @default(uuid())
  projectId String
  category  String   // "decision" | "constraint" | "architecture" | "style"
  fact      String   // 一条简短的事实陈述（不超过 30 字）
  source    String?  // 来源标记（见下方说明）
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  @@index([projectId])
  @@index([projectId, category])
}
```

**source 字段取值：**

| source 值 | 含义 |
|-----------|------|
| `compression:{runId}:{version}` | 来自压缩触发时的自动提取 |
| `finalize:{runId}` | 来自 Run 结束时的补充提取 |
| `agent_remember:{runId}` | Agent 主动调用 remember 工具写入 |

### 4.3 提取时机（双触发）

```
时间线:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━→

Step 1    ...     35(压缩触发)    ...     60(Run结束/沙箱销毁)
                   │                              │
                   ├─ ① 主触发：压缩时提取          ├─ ② 补充触发：剩余 messages 提取
                   │   （与 summary 同一次调用）     │   （覆盖压缩后的新对话）
                   │   成本：零（已包含在压缩中）     │   成本：一次小型 LLM 调用
```

**为什么需要 ② 补充触发：**
- 压缩发生在 step 35，但 step 36-60 的对话中可能有新的约束
- Run 结束时从剩余 messages（压缩后产生的部分）中补充提取
- 如果剩余 messages 很短（< 5 轮），可以跳过（信息量不够）

### 4.4 提取实现 — 与压缩服务集成

**外部压缩服务改动（在 context-management-v2 的 handleCompress 中扩展）：**

```typescript
// 外部后端：压缩 + Memory 提取（同一次 LLM 调用）
async function handleCompress(req: Request): Promise<Response> {
  const { projectId, runId, messages, previousSummary, startStep, endStep } = req.body;

  // 1. 存全量历史（现有逻辑，不变）
  await db.conversationHistory.create({ ... });

  // 2. 加载现有 facts（用于去重 + 淘汰判断）
  const existingFacts = await db.projectMemory.findMany({
    where: { projectId },
    select: { id: true, category: true, fact: true }
  });

  // 3. 一次 LLM 调用，同时输出 summary + facts
  const result = await compressAndExtractMemory({
    previousSummary,
    messages,
    existingFacts,
    maxSummaryTokens: 6000,
  });

  // 4. 存压缩产物（现有逻辑）
  await db.compressionSummary.create({ ... });

  // 5. 新增：写入新 facts
  if (result.newFacts.length > 0) {
    await db.projectMemory.createMany({
      data: result.newFacts.map(f => ({
        projectId,
        category: f.category,
        fact: f.fact,
        source: `compression:${runId}:${version}`,
      })),
    });
  }

  // 6. 新增：删除过时 facts
  if (result.obsoleteFactIds.length > 0) {
    await db.projectMemory.deleteMany({
      where: { id: { in: result.obsoleteFactIds } }
    });
  }

  // 7. 返回 summary 给沙箱 Agent
  return Response.json({ summary: result.summary });
}
```

**压缩 + Memory 提取的 LLM Prompt：**

```typescript
async function compressAndExtractMemory(params: {
  previousSummary: string | null;
  messages: Message[];
  existingFacts: Array<{ id: string; category: string; fact: string }>;
  maxSummaryTokens: number;
}): Promise<{
  summary: string;
  newFacts: ExtractedFact[];
  obsoleteFactIds: string[];
}> {
  const { previousSummary, messages, existingFacts } = params;

  const existingFactsBlock = existingFacts.length > 0
    ? `## 当前已有的项目记忆（用于去重和淘汰判断）\n${existingFacts.map(f => `- [${f.id}] [${f.category}] ${f.fact}`).join('\n')}`
    : '## 当前没有已有的项目记忆';

  const prompt = `你需要完成两个任务：

## 任务 1：生成对话摘要（summary）

将以下对话历史压缩为一段叙事性摘要，保留：
- 用户的核心需求和目标
- Agent 做出的关键决策及理由
- 文件修改记录（哪些文件被创建/修改/删除）
- 遇到的错误及解决方式
- 当前任务进度

${previousSummary ? `上一次的摘要（请在此基础上追加，不要重复）：\n${previousSummary}\n` : ''}

## 任务 2：提取/淘汰项目记忆（facts）

从对话中提取**对未来修改长期有效**的约束和决策。同时判断哪些已有的 facts 已经过时。

${existingFactsBlock}

## 输出格式（严格 JSON）

{
  "summary": "叙事性摘要文本...",
  "new_facts": [
    {"category": "constraint", "fact": "不使用动画效果"},
    {"category": "decision", "fact": "导航栏固定在顶部"}
  ],
  "obsolete_fact_ids": ["id1", "id2"]
}

## Facts 提取规则
- category 只能是：decision, constraint, architecture, style
- 每条 fact 是完整陈述句，不超过 30 字
- 只提取长期有效的规则，不要提取临时的调试细节
- 如果新 fact 与已有 fact 语义重复，不要重复提取
- 如果已有 fact 被对话中的新决策推翻（如用户改了主题颜色），将其 id 放入 obsolete_fact_ids
- new_facts 最多 10 条
- 如果没有新 facts 或需要淘汰的，对应字段为空数组

## 对话历史
`;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: prompt },
      ...messages,  // 完整的待压缩 messages
    ],
    temperature: 0.3,
    max_tokens: 8000,
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
}
```

**Token 开销分析：**
```
压缩调用的输入构成：
  - 待压缩的 messages        ~420-525K token（大头）
  - previousSummary          ~6K token
  - prompt 指令              ~500 token
  - 现有 facts 列表          ~800 token  ← Memory 新增的部分

facts 占比：800 / 530000 ≈ 0.15%，完全可忽略

输出增量：
  - summary                  ~6000 token（原有）
  - new_facts + obsolete_ids ~200 token（新增，< 3%）
```

### 4.5 淘汰机制（方案 A：LLM 提取时标记过时）

**核心思路：** 每次压缩时，将现有 facts 列表喂给 LLM，让它在生成新 facts 的同时标记哪些旧 facts 已过时。

**触发场景举例：**

| 旧 fact | 用户新操作 | 结果 |
|---------|-----------|------|
| "使用蓝色主题" | 用户说"改成深色主题" | 旧 fact 被标记 obsolete，新 fact "使用深色主题" 写入 |
| "页面分为 4 个区块" | 用户增加了新区块 | 旧 fact 被标记 obsolete，新 fact 更新为 5 个区块 |
| "导航栏固定在顶部" | 本轮无相关讨论 | 保持不变 |

**兜底机制：** 数量硬上限 80 条。如果超过，按 createdAt 升序删除最早的（FIFO）。

```typescript
// 硬上限兜底（在写入新 facts 后执行）
async function enforceFactsLimit(projectId: string, maxFacts: number = 80): Promise<void> {
  const count = await db.projectMemory.count({ where: { projectId } });
  if (count > maxFacts) {
    const toDelete = await db.projectMemory.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      take: count - maxFacts,
      select: { id: true },
    });
    await db.projectMemory.deleteMany({
      where: { id: { in: toDelete.map(f => f.id) } }
    });
  }
}
```

**为什么硬上限不会超出 context window：**
```
80 条 facts × 每条 ~10 token ≈ 800 token
800 / 1,000,000 = 0.08%
即使 facts 写得稍长（每条 15 token），80 × 15 = 1200 token，仍然微不足道
```

### 4.6 注入方式 — 自动全量注入（Slot B'）

**不需要检索召回。** 数据量估算：

```
一个项目能积累多少 facts：
- 每次压缩提取 ≤ 10 条
- 一个活跃项目经历 5-10 次压缩（跨多个 Run）
- Agent 主动 remember 零散几条
- 去重 + 淘汰后总量 ≈ 30-80 条
- 每条 ~30 字 ≈ ~10 token
- 总共 ≈ 300-800 token

在 1M 窗口下，800 token 直接全量注入毫无压力
```

**Context Assembler 中的实现：**

```typescript
// context-assembler.ts 扩展 — Slot B' 组装
class ContextAssembler {
  // Slot B': ProjectMemory 注入
  private async assembleSlotBPrime(projectId: string): Promise<{ message: ChatMessage | null; tokensUsed: number }> {
    const facts = await db.projectMemory.findMany({
      where: { projectId },
      orderBy: [
        { category: 'asc' },      // 按类型分组
        { createdAt: 'desc' },     // 同类型内最新优先
      ],
    });

    if (facts.length === 0) {
      return { message: null, tokensUsed: 0 };
    }

    // 按 category 分组展示
    const grouped = this.groupByCategory(facts);
    const content = this.formatFactsBlock(grouped);
    const tokens = this.estimateTokens(content);

    return {
      message: { role: "system", content },
      tokensUsed: tokens,
    };
  }

  private formatFactsBlock(grouped: Record<string, string[]>): string {
    const lines = ['[项目约束与决策]'];
    const categoryLabels: Record<string, string> = {
      constraint: '约束',
      decision: '决策',
      architecture: '架构',
      style: '样式',
    };

    for (const [category, facts] of Object.entries(grouped)) {
      lines.push(`${categoryLabels[category] || category}:`);
      for (const fact of facts) {
        lines.push(`  - ${fact}`);
      }
    }
    return lines.join('\n');
  }
}
```

**注入后 Agent 看到的效果：**
```
[项目约束与决策]
约束:
  - 不使用动画效果
  - 页面加载时间不超过 3 秒
决策:
  - 导航栏固定在顶部
  - 使用 Next.js App Router
架构:
  - 页面分为 Header/Hero/Features/CTA/Footer 五个区块
  - 所有组件放在 src/components/ 下
样式:
  - 使用深色主题配合圆角按钮
  - 主色调为 indigo-600
```

### 4.7 Agent 主动写入 — `remember` 工具

作为自动提取的补充，提供 `remember` 工具让 Agent 在对话中实时写入：

```typescript
// 工具定义
{
  type: "function" as const,
  function: {
    name: "remember",
    description: "记住一条对未来修改有用的项目约束或决策。只在用户明确表达了长期有效的规则时使用（如'不要动画'、'必须支持移动端'）。不要用于记录临时的调试细节。",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["decision", "constraint", "architecture", "style"],
          description: "fact 的类型",
        },
        fact: {
          type: "string",
          description: "一条完整的陈述句，不超过 30 字",
        },
      },
      required: ["category", "fact"],
    },
  },
}
```

**执行实现：**

```typescript
async function executeRemember(
  args: { category: string; fact: string },
  ctx: ToolContext
): Promise<ToolResult> {
  const { projectId, runId } = ctx;

  // 去重检查：如果已有语义相同的 fact，跳过
  const existing = await db.projectMemory.findMany({
    where: { projectId, category: args.category },
    select: { fact: true },
  });

  // 简单的文本相似度判断（包含关系）
  const isDuplicate = existing.some(e =>
    e.fact.includes(args.fact) || args.fact.includes(e.fact)
  );

  if (isDuplicate) {
    return { success: true, output: "已有类似记忆，跳过" };
  }

  await db.projectMemory.create({
    data: {
      projectId,
      category: args.category,
      fact: args.fact,
      source: `agent_remember:${runId}`,
    },
  });

  // 硬上限兜底
  await enforceFactsLimit(projectId);

  return { success: true, output: `已记住: [${args.category}] ${args.fact}` };
}
```

**写入路径对比：**

| 路径 | 时机 | 精度 | 覆盖率 | 成本 |
|------|------|------|--------|------|
| 压缩时自动提取 | 35 轮/500K token 触发 | 中（LLM 猜测哪些重要） | 高（批量扫描全部 messages） | 零（与压缩共享调用） |
| Run 结束时补充提取 | 沙箱销毁前 | 中 | 覆盖压缩后的新对话 | 一次小型 LLM 调用 |
| Agent 主动 remember | 实时 | 高（有完整推理上下文） | 低（依赖 Agent 判断力） | 零（只是 DB 写入） |

三者互补：自动提取保证不遗漏，Agent 主动写入保证高精度。

### 4.8 跨 Run 恢复流程

```typescript
// restore.ts 扩展 — 新 Run 启动时加载 Memory
async function restoreAgentState(projectId: string, newRunId: string): Promise<AgentContext> {
  // Layer 1: 从外部 DB 恢复基础数据（现有逻辑）
  const latestSummary = await fetchLatestSummary(projectId);
  const pendingMessages = await fetchPendingMessages(projectId, latestSummary?.coversStepEnd);
  const files = await fetchProjectFiles(projectId);
  await restoreFilesToDisk(files);

  // Layer 2: 从代码文件重建结构化认知（现有逻辑）
  const repoMap = await generateRepoMap(PROJECT_DIR);
  const grepIndex = await buildGrepAstIndex(PROJECT_DIR);

  // Layer 3: Episodes 和 TaskSummary 从空开始（现有逻辑）
  const episodes: Episode[] = [];
  const taskSummarizer = new TaskSummarizer();

  // Memory: 加载 ProjectMemory（全量注入到 Slot B'）
  const projectMemories = await db.projectMemory.findMany({
    where: { projectId },
    orderBy: [{ category: 'asc' }, { createdAt: 'desc' }],
  });

  return {
    latestSummary, pendingMessages, repoMap, grepIndex,
    episodes, taskSummarizer,
    projectMemories,  // ← 新增
  };
}
```

### 4.9 Run 结束时的补充提取

```typescript
// 沙箱销毁前，从剩余 messages 中补充提取 facts
async function extractRemainingFacts(
  projectId: string,
  runId: string,
  remainingMessages: Message[]
): Promise<void> {
  // 如果剩余对话太短（< 5 轮），信息量不够，跳过
  const userMessages = remainingMessages.filter(m => m.role === 'user');
  if (userMessages.length < 5) return;

  const existingFacts = await db.projectMemory.findMany({
    where: { projectId },
    select: { id: true, category: true, fact: true },
  });

  // 单独的小型 LLM 调用（只做 facts 提取，不做 summary）
  const result = await extractFactsOnly({
    messages: remainingMessages,
    existingFacts,
  });

  if (result.newFacts.length > 0) {
    await db.projectMemory.createMany({
      data: result.newFacts.map(f => ({
        projectId,
        category: f.category,
        fact: f.fact,
        source: `finalize:${runId}`,
      })),
    });
  }

  if (result.obsoleteFactIds.length > 0) {
    await db.projectMemory.deleteMany({
      where: { id: { in: result.obsoleteFactIds } },
    });
  }

  await enforceFactsLimit(projectId);
}
```

### 4.10 验证标准

- [ ] 压缩调用产出的 JSON 能正确解析出 summary + new_facts + obsolete_fact_ids
- [ ] Agent 跨 Run 后能遵守之前记录的 constraint（如"不要动画"）
- [ ] facts 淘汰正确：用户推翻旧决策后，旧 fact 被标记 obsolete
- [ ] 硬上限 80 条生效：超过后最早的 facts 被清理
- [ ] 全量注入不超过 1000 token（80 条极限情况下）
- [ ] `remember` 工具去重生效：相同语义的 fact 不重复写入
- [ ] 压缩的 LLM 调用延迟无明显增加（< 1s 额外开销，因为输出只多 ~200 token）

---

## 五、Phase 2：UserPreference（用户级偏好记忆）

### 5.1 核心思路

在每次 run 结束时，判断用户是否表达了**通用偏好**（适用于所有项目），提取并存储。

### 5.2 Schema 设计

```prisma
model UserPreference {
  id         String   @id @default(uuid())
  userId     String
  category   String   // "style" | "tech" | "workflow"
  preference String   // "喜欢深色主题" | "不使用动画" | "优先使用 Tailwind"
  weight     Int      @default(1)  // 被确认次数，越高越重要
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@unique([userId, category, preference])
  @@index([userId])
}
```

**字段说明：**

- `weight` — 每次被确认时 +1，用于排序（高权重的偏好优先注入）
- `@@unique` — 同一用户的同一偏好只存一条，通过 weight 累加

### 5.3 提取时机

在 run 结束时调用。与 ProjectMemory 不同，UserPreference 不搭压缩的便车——因为它只需要看最近几轮用户发言，不需要扫描全量 messages。

```typescript
async function handleResult(
  runId: string,
  projectId: string,
  result: AgentLoopResult,
  ...
): Promise<void> {
  if (result.success) {
    await saveConversation(projectId, result.finalMessages, sandboxId ?? undefined);
    
    // 提取用户偏好（只看最近 10 条消息）
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { userId: true }
    });
    await extractUserPreferences(project.userId, result.finalMessages);
    
    await finalizeRun(runId, projectId, "succeeded");
  }
}
```

### 5.4 提取实现

```typescript
interface ExtractedPreference {
  category: "style" | "tech" | "workflow";
  preference: string;
}

export async function extractUserPreferences(
  userId: string,
  messages: Message[]
): Promise<void> {
  const recentMessages = messages.slice(-10);
  const prefs = await extractPreferences(recentMessages);
  
  if (prefs.length === 0) return;
  
  for (const pref of prefs) {
    await prisma.userPreference.upsert({
      where: {
        userId_category_preference: {
          userId,
          category: pref.category,
          preference: pref.preference
        }
      },
      create: { userId, category: pref.category, preference: pref.preference, weight: 1 },
      update: { weight: { increment: 1 }, updatedAt: new Date() }
    });
  }
}

async function extractPreferences(messages: Message[]): Promise<ExtractedPreference[]> {
  const prompt = `判断用户是否表达了通用偏好（适用于所有项目，而非当前项目特定需求）。

## 输出格式（严格 JSON 数组）
[
  {"category": "style", "preference": "喜欢深色主题"},
  {"category": "tech", "preference": "优先使用 Tailwind CSS"},
  {"category": "workflow", "preference": "不需要详细解释，直接开始"}
]

## 规则
- category 只能是：style, tech, workflow
- preference 是完整的陈述句，不超过 20 字
- 只提取明确的、可复用的偏好，不要提取当前项目的具体需求
- 如果没有通用偏好，返回空数组 []
- 最多提取 3 条

## 对话
${JSON.stringify(messages)}`;

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 500,
  });

  return JSON.parse(response.choices[0]?.message?.content || "[]");
}
```

### 5.5 注入方式 — Slot A 尾部

UserPreference 注入到 System Prompt 的末尾（Slot A），因为它是全局生效的用户画像，不依赖项目上下文。

```typescript
export async function buildSystemPromptWithUserContext(userId: string): Promise<string> {
  const prefs = await prisma.userPreference.findMany({
    where: { userId },
    orderBy: { weight: 'desc' },
    take: 5
  });
  
  const prefBlock = prefs.length > 0
    ? `\n\n## 用户偏好\n${prefs.map(p => `- ${p.preference}`).join('\n')}`
    : '';
  
  return BUILDER_SYSTEM_PROMPT + prefBlock;
}
```

### 5.6 示例场景

**Project A 中：** 用户说"我喜欢深色主题" → 提取 `{"style", "喜欢深色主题"}`, weight=1

**Project B 中：** 自动注入 `## 用户偏好\n- 喜欢深色主题` → Agent 默认使用深色主题

**Project C 中：** 用户再次确认"对，就是要深色" → weight 增加到 2，排序更靠前

---

## 六、Phase 3：BuildErrorPattern（错误-修复知识库，可选）

### 6.1 核心思路

当 build 失败后成功修复时，记录错误特征和修复方式，形成知识库。

### 6.2 Schema 设计

```prisma
model BuildErrorPattern {
  id          String   @id @default(uuid())
  errorHash   String   @unique  // 错误特征的 hash
  errorSample String   // 错误信息示例（前 500 字符）
  solution    String   // 修复方式描述
  successRate Float    @default(0.0)
  usedCount   Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  @@index([errorHash])
}
```

### 6.3 提取时机

在 `agentLoop` 中，当检测到 build 失败后又成功时：

```typescript
if (previousBuildFailed && currentBuildSucceeded) {
  await recordErrorPattern(
    errorMessage: previousError,
    solution: extractSolutionFromMessages(messages)
  );
}
```

### 6.4 使用方式

在 build 失败时，查询是否有已知解决方案，注入到 tool result 中：

```typescript
const errorHash = hashError(buildError);
const pattern = await prisma.buildErrorPattern.findUnique({ where: { errorHash } });

if (pattern && pattern.successRate > 0.5) {
  return {
    success: false,
    output: `${buildError}\n\n已知解决方案：${pattern.solution}`
  };
}
```

### 6.5 实施建议

Phase 3 建议在 Phase 1 和 Phase 2 稳定后再考虑。需要解决：
- 错误特征提取算法（hash 函数设计）
- 误报处理（不同错误被误判为相同）
- 定期清理低成功率的 pattern

---

## 七、实施优先级

| 阶段 | 内容 | 依赖 | 预估工作量 |
|------|------|------|-----------|
| Phase 1a | 压缩时自动提取 + 淘汰 + 全量注入 | context-management-v2 Layer 1 | 2-3 天 |
| Phase 1b | `remember` 工具 | Phase 1a | 0.5 天 |
| Phase 1c | Run 结束时补充提取 | Phase 1a | 0.5 天 |
| Phase 2 | UserPreference 提取 + 注入 | 无（独立） | 1-2 天 |
| Phase 3 | BuildErrorPattern | Phase 1 + Phase 2 稳定 | 2-3 天 |
