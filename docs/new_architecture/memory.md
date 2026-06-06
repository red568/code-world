# V8 - Memory 机制设计

## 一、问题定义

当前系统已有 `AgentConversation` 表存储完整 messages，并在沙箱过期时生成 summary。但存在以下问题：

### 1.1 Summary 太粗糙，丢失关键上下文

当前 `generateConversationSummary` 只提取 user/assistant content 的前 200 字，生成自然语言摘要。这导致：

- 用户的设计决策（"导航栏要固定"）被泛化成"修改了导航栏"
- 技术约束（"不要用动画"）完全丢失
- 文件结构信息（"Hero 组件在 src/components/Hero.tsx"）无法恢复

### 1.2 没有跨 Project 的用户偏好记忆

用户在 Project A 说"我喜欢深色主题"，在 Project B 又要重复一遍。

### 1.3 没有从失败中学习的机制

Build 失败 → 修复 → 成功，这个过程的经验没有沉淀。下次遇到类似错误还是要重新推理。

---

## 二、设计原则

### 2.1 渐进式增强，不引入外部依赖

不使用 Mem0、Letta、MCP Server 等外部框架。基于现有的 AgentConversation + Prisma + PostgreSQL 做增强。

### 2.2 与现有架构深度契合

- **Run 隔离兼容** — Memory 写入在 run 结束后，天然符合 runId 写权限机制
- **Sandbox 生命周期感知** — 精确在 sandbox 过期时触发 memory 提取
- **Human-in-the-Loop 协同** — 可以从 ask_user 的回答中提取偏好

### 2.3 可追溯、可调试

每条 memory 记录 source 字段（来自哪个 runId），方便追溯和调试。

---

## 三、整体架构

### 3.1 三层 Memory 体系

```
┌─────────────────────────────────────────────────────────────┐
│  Phase 1: ProjectMemory（项目级结构化记忆）                    │
│  替代粗糙的 summary，存储关键 facts                            │
│  触发时机：沙箱过期时                                          │
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

### 3.2 与现有系统的关系

| 表 | 职责 | 生命周期 | 读者 |
|---|---|---|---|
| `AgentConversation` | 沙箱活着时的完整 messages | 沙箱过期时压缩 | Worker |
| `ProjectMemory` | 沙箱过期后的结构化 facts | 永久（直到 project 删除） | Worker |
| `UserPreference` | 用户通用偏好 | 永久（直到 user 删除） | Worker |
| `Message` | 前端聊天气泡 | 永久 | 前端 |

## 四、Phase 1：ProjectMemory（项目级结构化记忆）

### 4.1 核心思路

沙箱过期时，不生成自然语言 summary，而是让 LLM 提取**结构化的 facts**，存入新表。

### 4.2 Schema 设计

```prisma
model ProjectMemory {
  id        String   @id @default(uuid())
  projectId String
  category  String   // "decision" | "constraint" | "architecture" | "style"
  fact      String   // 一条简短的事实陈述（不超过 30 字）
  source    String?  // "run:{runId}" | "conversation_summary" | "user_explicit"
  createdAt DateTime @default(now())
  
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  @@index([projectId])
  @@index([projectId, category])
}
```

**字段说明：**

- `category` — 分类，便于后续按类型筛选或扩展
- `fact` — 完整的陈述句，如"导航栏固定在顶部"而非"导航栏"
- `source` — 可追溯来源，方便调试

### 4.3 提取时机

在 `orchestrator.ts` 的 `handleSandboxExpiredConversation` 中（第 172 行），替代现有的 `generateConversationSummary`。

**旧逻辑：**
```typescript
const summary = await generateConversationSummary(oldMessages);
await prisma.agentConversation.update({
  where: { projectId },
  data: { summary }
});
```

**新逻辑：**
```typescript
await extractAndSaveProjectMemories(projectId, oldMessages);
// summary 字段不再使用，可以置为 null
```

### 4.4 提取实现

**新建文件：`src/lib/agent/memory.ts`**

```typescript
import OpenAI from "openai";
import { getProviderConfig } from "@/lib/llm/providers";
import { prisma } from "@/lib/prisma";

type Message = OpenAI.ChatCompletionMessageParam;

interface ExtractedFact {
  category: "decision" | "constraint" | "architecture" | "style";
  fact: string;
}

/**
 * 从对话历史中提取结构化 facts
 */
export async function extractAndSaveProjectMemories(
  projectId: string,
  messages: Message[]
): Promise<void> {
  const facts = await extractProjectFacts(messages);
  
  if (facts.length === 0) return;
  
  await prisma.projectMemory.createMany({
    data: facts.map(f => ({
      projectId,
      category: f.category,
      fact: f.fact,
      source: 'conversation_summary'
    })),
    skipDuplicates: true
  });
  
  console.log(`[Memory] 提取了 ${facts.length} 条 project memories`);
}

async function extractProjectFacts(messages: Message[]): Promise<ExtractedFact[]> {
  const providerConfig = getProviderConfig();
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || providerConfig.baseURL,
  });
  const model = process.env.LLM_MODEL || providerConfig.defaultModel;

  const conversationSummary = summarizeMessages(messages);

  const prompt = `从以下对话历史中提取值得记住的关键事实。

## 输出格式（严格 JSON 数组）
[
  {"category": "decision", "fact": "用户要求导航栏固定在顶部"},
  {"category": "constraint", "fact": "不使用动画效果"},
  {"category": "architecture", "fact": "页面分为 Header/Hero/Features/Footer 四个区块"},
  {"category": "style", "fact": "使用深色主题配合圆角按钮"}
]

## 规则
- 每条 fact 是一个完整的陈述句，不超过 30 字
- category 只能是：decision, constraint, architecture, style
- 只提取对未来修改有用的信息，不要提取临时的调试细节
- 最多提取 10 条
- 如果没有值得记住的内容，返回空数组 []

## 对话历史
${conversationSummary}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content || "[]";
    return JSON.parse(content);
  } catch (error) {
    console.error("[Memory] 提取 facts 失败:", error);
    return [];
  }
}

function summarizeMessages(messages: Message[]): string {
  const keyPoints: string[] = [];
  
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      keyPoints.push(`用户: ${msg.content.slice(0, 200)}`);
    }
    if (msg.role === "assistant" && "content" in msg && typeof msg.content === "string" && msg.content) {
      keyPoints.push(`Agent: ${msg.content.slice(0, 200)}`);
    }
  }
  
  return keyPoints.slice(0, 30).join("\n");
}
```

### 4.5 注入方式

**修改 `src/lib/agent/prompt.ts` 的 `buildIteratePromptWithContext` 函数：**

```typescript
export async function buildIteratePromptWithContext(
  userRequest: string,
  projectId: string
): Promise<string> {
  // 加载 project memories
  const memories = await prisma.projectMemory.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  
  const memoryBlock = memories.length > 0
    ? `## 项目记忆\n${memories.map(m => `- [${m.category}] ${m.fact}`).join('\n')}\n\n`
    : '';
  
  return `用户要求对现有项目进行修改。

${memoryBlock}## 用户需求
${userRequest}

## 工作方式
1. 先用 list_files() 查看当前项目结构
2. 用 read_file() 查看需要修改的文件
3. 理解现有代码结构后，进行针对性修改
4. 只修改必要的文件，保持其他文件不变
5. 修改完成后 run_shell("npm run build") 验证
6. 构建成功后启动预览并获取 URL
7. 获取到预览 URL 后任务完成，不再调用任何工具

## 注意
- 保持现有代码风格和结构
- 只返回需要修改的文件
- 不要重写未变动的文件`;
}
```

**注意：** 函数签名需要改为 `async`，并且调用处也要相应改为 `await`。

### 4.6 优势

| 维度 | 旧方案（summary） | 新方案（ProjectMemory） |
|------|------------------|------------------------|
| **精准度** | "修改了导航栏" | "导航栏固定在顶部" |
| **结构化** | 自然语言段落 | 分类的 fact 列表 |
| **Token 开销** | 200 字 ≈ 60 token | 10 条 × 30 字 ≈ 100 token |
| **可查询** | 全文匹配 | 按 category 筛选 |
| **可扩展** | 难以扩展 | 可加 embedding 做语义检索 |

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

在 `orchestrator.ts` 的 `handleResult` 中，run 成功后调用：

```typescript
async function handleResult(
  runId: string,
  projectId: string,
  result: AgentLoopResult,
  sandbox: Sandbox,
  sandboxId: string | undefined,
  totalDuration: string,
  isReused: boolean
): Promise<void> {
  // ... 现有逻辑 ...
  
  if (result.success) {
    await saveConversation(projectId, result.finalMessages, sandboxId ?? undefined);
    
    // 新增：提取用户偏好
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { userId: true }
    });
    await extractUserPreferences(project.userId, result.finalMessages);
    
    await finalizeRun(runId, projectId, "succeeded");
    // ...
  }
}
```

### 5.4 提取实现

**在 `src/lib/agent/memory.ts` 中新增：**

```typescript
interface ExtractedPreference {
  category: "style" | "tech" | "workflow";
  preference: string;
}

/**
 * 从对话中提取用户通用偏好
 */
export async function extractUserPreferences(
  userId: string,
  messages: Message[]
): Promise<void> {
  // 只看最近 10 条消息（最近 5 轮对话）
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
      create: {
        userId,
        category: pref.category,
        preference: pref.preference,
        weight: 1
      },
      update: {
        weight: { increment: 1 },
        updatedAt: new Date()
      }
    });
  }
  
  console.log(`[Memory] 提取了 ${prefs.length} 条 user preferences`);
}

async function extractPreferences(messages: Message[]): Promise<ExtractedPreference[]> {
  const providerConfig = getProviderConfig();
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || providerConfig.baseURL,
  });
  const model = process.env.LLM_MODEL || providerConfig.defaultModel;

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
${JSON.stringify(messages.slice(-10))}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content || "[]";
    return JSON.parse(content);
  } catch (error) {
    console.error("[Memory] 提取 preferences 失败:", error);
    return [];
  }
}
```

### 5.5 注入方式

**修改 `src/lib/agent/prompt.ts`，在 system prompt 中注入用户偏好：**

```typescript
export async function buildSystemPromptWithUserContext(
  userId: string
): Promise<string> {
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

**在 `orchestrator.ts` 中调用：**

```typescript
// executeGenerate 和 executeIterate 中
const systemPrompt = await buildSystemPromptWithUserContext(userId);

const result = await agentLoop({
  runId,
  projectId,
  sandbox,
  systemPrompt,  // 使用增强后的 system prompt
  userMessage,
  existingMessages,
  maxSteps: 50,
});
```

### 5.6 示例场景

**场景：用户在 Project A 中说"我喜欢深色主题"**

1. Run 结束后，`extractUserPreferences` 提取到：`{"category": "style", "preference": "喜欢深色主题"}`
2. 存入 `UserPreference` 表，`weight = 1`

**场景：用户在 Project B 中创建新项目**

1. `buildSystemPromptWithUserContext` 加载用户偏好
2. System prompt 末尾追加：`## 用户偏好\n- 喜欢深色主题`
3. Agent 自动使用深色主题，无需用户重复说明

**场景：用户在 Project C 中再次确认"对，我就是喜欢深色主题"**

1. `upsert` 逻辑将该偏好的 `weight` 增加到 2
2. 下次加载时，高 weight 的偏好排在前面

## 六、Phase 3：BuildErrorPattern（错误-修复知识库，可选）

### 6.1 核心思路

当 build 失败后成功修复时，记录错误特征和修复方式，形成知识库。下次遇到类似错误时，可以直接参考已知解决方案。

### 6.2 Schema 设计

```prisma
model BuildErrorPattern {
  id          String   @id @default(uuid())
  errorHash   String   @unique  // 错误特征的 hash（如错误类型 + 关键词）
  errorSample String   // 错误信息示例（前 500 字符）
  solution    String   // 修复方式描述
  successRate Float    @default(0.0)  // 修复成功率（0.0-1.0）
  usedCount   Int      @default(0)    // 被使用次数
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  @@index([errorHash])
}
```

### 6.3 提取时机

在 `agentLoop` 中，当检测到 build 失败后又成功时：

```typescript
// 伪代码示例
if (previousBuildFailed && currentBuildSucceeded) {
  await recordErrorPattern(
    errorMessage: previousError,
    solution: extractSolutionFromMessages(messages)
  );
}
```

### 6.4 使用方式

在 build 失败时，查询是否有已知解决方案：

```typescript
const errorHash = hashError(buildError);
const pattern = await prisma.buildErrorPattern.findUnique({
  where: { errorHash }
});

if (pattern && pattern.successRate > 0.5) {
  // 注入到 tool result 中
  return {
    success: false,
    output: `${buildError}\n\n已知解决方案：${pattern.solution}`
  };
}
```

### 6.5 实施建议

Phase 3 是可选的，建议在 Phase 1 和 Phase 2 稳定后再考虑。因为：

- 需要设计错误特征提取算法（hash 函数）
- 需要处理误报（不同错误被误判为相同）
- 需要定期清理低成功率的 pattern

## 七、实施路径

### 7.1 Phase 1 实施步骤（优先级：高，工作量：1 天）

**Step 1：数据库 Schema**

```bash
# 在 prisma/schema.prisma 中添加 ProjectMemory 表
# 然后执行 migration
npx prisma migrate dev --name add_project_memory
```

**Step 2：实现 memory.ts**

创建 `src/lib/agent/memory.ts`，实现：
- `extractAndSaveProjectMemories(projectId, messages)`
- `extractProjectFacts(messages)` — 调用 LLM 提取 facts

**Step 3：修改 orchestrator.ts**

在 `handleSandboxExpiredConversation` 中：
```typescript
// 替换
const summary = await generateConversationSummary(oldMessages);

// 为
await extractAndSaveProjectMemories(projectId, oldMessages);
```

**Step 4：修改 prompt.ts**

将 `buildIteratePromptWithContext` 改为 async 函数，加载并注入 memories。

**Step 5：测试验证**

1. 创建项目 A，生成一个网站
2. 迭代修改（沙箱复用）
3. 等待 15 分钟，沙箱过期
4. 再次迭代，检查是否触发 memory 提取
5. 查看数据库 `ProjectMemory` 表，确认 facts 已存储
6. 再次迭代，检查 Agent 是否使用了 memories

---

### 7.2 Phase 2 实施步骤（优先级：中，工作量：半天）

**前置条件：** Phase 1 已稳定运行

**Step 1：数据库 Schema**

```bash
npx prisma migrate dev --name add_user_preference
```

**Step 2：在 memory.ts 中新增**

- `extractUserPreferences(userId, messages)`
- `extractPreferences(messages)` — 调用 LLM 提取偏好

**Step 3：修改 orchestrator.ts**

在 `handleResult` 的 success 分支中调用 `extractUserPreferences`。

**Step 4：修改 prompt.ts**

新增 `buildSystemPromptWithUserContext(userId)` 函数。

**Step 5：修改 orchestrator.ts 调用处**

在 `executeGenerate` 和 `executeIterate` 中使用增强后的 system prompt。

**Step 6：测试验证**

1. 在 Project A 中明确表达偏好："我喜欢深色主题"
2. 检查 `UserPreference` 表是否记录
3. 创建 Project B，检查 Agent 是否自动应用深色主题

### 7.3 Phase 3 实施步骤（优先级：低，工作量：1-2 天）

**前置条件：** Phase 1 和 Phase 2 已稳定运行，且确实需要错误知识库

**实施建议：** 先观察 Phase 1/2 的效果，如果 Agent 仍然频繁遇到相同的 build 错误，再考虑 Phase 3。

---

## 八、与外部方案对比

### 8.1 为什么不用 Mem0 / Letta / MCP Server？

| 维度 | 外部方案 | 本方案 |
|------|---------|--------|
| **架构侵入性** | 需要额外服务/进程 | 零侵入，复用现有 Prisma + PostgreSQL |
| **与 Run 隔离的兼容性** | 需要适配 runId 写权限机制 | 天然兼容，memory 写入在 run 结束后 |
| **与 Sandbox 生命周期的配合** | 不感知 sandbox 过期 | 精确在 sandbox 过期时触发提取 |
| **与 Human-in-the-Loop 的协同** | 独立系统，需要桥接 | 可以从 ask_user 的回答中提取偏好 |
| **渐进式实施** | 一次性引入完整框架 | Phase 1 → Phase 2 → Phase 3 逐步验证 |
| **Token 开销** | Vector 检索 + Graph 查询 | 直接 SQL 查询，10-20 条 fact 注入 |
| **调试和可观测性** | 黑盒，难以追踪 memory 来源 | 每条 memory 有 source 字段，可追溯到 runId |
| **学习成本** | 需要学习新框架的 API | 基于现有技术栈，无额外学习成本 |

### 8.2 未来扩展方向

如果 Phase 1 的 ProjectMemory 条目过多（> 50 条/project），可以考虑：

**方案 A：加 pgvector 做语义检索**

```sql
CREATE EXTENSION vector;
ALTER TABLE "ProjectMemory" ADD COLUMN embedding vector(1536);
CREATE INDEX ON "ProjectMemory" USING ivfflat (embedding vector_cosine_ops);
```

在注入时，根据 userRequest 的 embedding 检索最相关的 5-10 条 memories。

**方案 B：集成 Mem0**

如果需要更复杂的 Graph + Vector 能力，可以在 Phase 1/2 的基础上，将 ProjectMemory 同步到 Mem0：

```typescript
import { MemoryClient } from 'mem0ai';

const mem0 = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });

// 在 extractAndSaveProjectMemories 后
await mem0.add(facts.map(f => f.fact), {
  user_id: userId,
  metadata: { project_id: projectId }
});
```

但这是可选的，不是必需的。

## 九、关键设计决策

### 9.1 为什么在沙箱过期时提取，而不是每次 run 结束？

**原因：**

- 沙箱活着时，完整的 messages 已经足够好，不需要额外的 memory
- 只有沙箱过期、messages 被丢弃时，才需要结构化的 facts 作为补偿
- 减少 LLM 调用次数，降低成本

### 9.2 为什么用 LLM 提取而不是规则匹配？

**原因：**

- 用户表达方式多样，规则难以覆盖（"导航栏固定" vs "把导航栏钉在上面"）
- LLM 可以理解语义，提取真正的意图而非字面文本
- 可以过滤掉临时的、无价值的信息

### 9.3 为什么 ProjectMemory 不存 embedding？

**原因：**

- Phase 1 的目标是验证结构化 memory 的有效性，不是优化检索性能
- 一个 project 的 memories 通常不会超过 20 条，全量注入的 token 开销可接受
- 如果未来确实需要，可以在 Phase 1 稳定后再加 pgvector（见 8.2）

### 9.4 为什么 UserPreference 用 weight 而不是时间戳排序？

**原因：**

- 被多次确认的偏好更重要，应该优先注入
- 时间戳排序会让旧的、但重要的偏好被挤出 top 5
- weight 机制可以自然淘汰低频偏好（用户不再提及的偏好 weight 不增长）

### 9.5 为什么不在 ask_user 时提取 memory？

**原因：**

- ask_user 是 Agent Loop 内部的暂停点，此时 run 还未结束
- 如果在 ask_user 时写入 memory，需要处理 run 被 cancel 的情况（回滚 memory）
- 在 run 结束后提取更简单，且符合 runId 写权限隔离的原则

---

## 十、监控和调试

### 10.1 关键指标

**Phase 1 效果指标：**

- 沙箱过期后的 iterate run，Agent 是否正确理解了项目背景？
- 提取的 facts 数量分布（平均每次提取几条？）
- facts 的 category 分布（是否平衡？）

**Phase 2 效果指标：**

- 用户在新项目中是否减少了重复说明偏好？
- UserPreference 的 weight 分布（是否有明显的高频偏好？）
- 误提取率（提取了不是偏好的内容）

### 10.2 调试工具

**查看某个 project 的 memories：**

```sql
SELECT category, fact, source, createdAt 
FROM "ProjectMemory" 
WHERE "projectId" = 'xxx'
ORDER BY "createdAt" DESC;
```

**查看某个 user 的 preferences：**

```sql
SELECT category, preference, weight, updatedAt
FROM "UserPreference"
WHERE "userId" = 'xxx'
ORDER BY weight DESC;
```

**查看 memory 提取日志：**

```bash
# Worker 日志中搜索
grep "\[Memory\]" logs/worker.log
```

### 10.3 常见问题排查

**问题：沙箱过期后，Agent 仍然不理解项目背景**

排查步骤：
1. 检查 `ProjectMemory` 表是否有数据
2. 检查 `buildIteratePromptWithContext` 是否正确加载并注入了 memories
3. 检查提取的 facts 是否足够具体（不要太泛化）

**问题：UserPreference 提取了错误的内容**

排查步骤：
1. 检查提取 prompt 是否强调"通用偏好"而非"当前项目需求"
2. 调整 prompt 中的示例，让 LLM 更好地理解边界
3. 考虑加入人工审核机制（前端展示提取的偏好，让用户确认）

---

## 十一、总结

### 11.1 核心价值

本方案通过**渐进式增强现有架构**，在不引入外部依赖的前提下，实现了三层 memory 体系：

1. **ProjectMemory** — 解决沙箱过期后的上下文丢失问题
2. **UserPreference** — 解决跨项目的偏好重复说明问题
3. **BuildErrorPattern** — 解决重复错误的学习问题（可选）

### 11.2 与现有系统的契合度

- ✅ 完全兼容 Run 隔离机制（memory 写入在 run 结束后）
- ✅ 精确感知 Sandbox 生命周期（在过期时触发提取）
- ✅ 可与 Human-in-the-Loop 协同（从 ask_user 回答中提取偏好）
- ✅ 可追溯、可调试（每条 memory 有 source 字段）

### 11.3 实施建议

**优先级排序：**

1. **Phase 1（必做）** — ProjectMemory，解决最核心的上下文丢失问题
2. **Phase 2（推荐）** — UserPreference，提升跨项目体验
3. **Phase 3（可选）** — BuildErrorPattern，根据实际需求决定

**风险控制：**

- 每个 Phase 独立验证，确认有效后再进入下一个
- 保留现有的 `AgentConversation.summary` 字段作为降级方案
- 在 memory 提取失败时，不影响主流程（try-catch + 日志）

**成本估算：**

- Phase 1：每次沙箱过期时调用 1 次 LLM（约 500 tokens）
- Phase 2：每次 run 结束时调用 1 次 LLM（约 300 tokens）
- 总增量成本：< 5% 的 LLM 调用成本

---

## 附录：完整的 Prisma Schema 变更

```prisma
// 在 schema.prisma 中添加以下三个表

// Phase 1: 项目级结构化记忆
model ProjectMemory {
  id        String   @id @default(uuid())
  projectId String
  category  String   // "decision" | "constraint" | "architecture" | "style"
  fact      String   // 一条简短的事实陈述（不超过 30 字）
  source    String?  // "run:{runId}" | "conversation_summary" | "user_explicit"
  createdAt DateTime @default(now())
  
  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  
  @@index([projectId])
  @@index([projectId, category])
}

// Phase 2: 用户级偏好记忆
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

// Phase 3: 错误-修复知识库（可选）
model BuildErrorPattern {
  id          String   @id @default(uuid())
  errorHash   String   @unique  // 错误特征的 hash
  errorSample String   // 错误信息示例（前 500 字符）
  solution    String   // 修复方式描述
  successRate Float    @default(0.0)  // 修复成功率（0.0-1.0）
  usedCount   Int      @default(0)    // 被使用次数
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  @@index([errorHash])
}
```

