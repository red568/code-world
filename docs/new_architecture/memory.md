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

