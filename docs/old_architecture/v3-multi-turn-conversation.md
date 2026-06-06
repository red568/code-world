# 多轮对话历史存储与压缩 — 技术方案

## 一、核心思路

**沙箱活着时**：Agent 拥有完整的 messages 历史（像 Claude Code 一样持续对话），每轮迭代直接在末尾追加新消息继续。

**沙箱过期时**：自动触发一次 LLM 摘要生成，将完整历史压缩为一段简短摘要。下次新建沙箱时，摘要作为上下文注入，让 Agent 不完全失忆。

---

## 二、数据模型

新增 `AgentConversation` 表，独立于 Project 表，按**用户维度 + 项目维度**划分：

```prisma
model AgentConversation {
  id            String   @id @default(uuid())
  projectId     String   @unique
  userId        String                       // 冗余存储，方便未来用户维度 memory 查询
  sandboxId     String?                      // 这份 messages 对应的沙箱
  messages      Json     @default("[]")      // Agent 完整 messages 数组
  summary       String?                      // 沙箱过期后生成的摘要
  tokenEstimate Int      @default(0)         // 粗略 token 估算
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

### 设计决策说明

| 决策 | 理由 |
|------|------|
| 独立表而非 Project 加字段 | messages JSON 可能 100KB-2MB，避免拖慢 Project 查询 |
| projectId @unique（一对一） | 同一时间只有一个活跃会话，不需要按沙箱维度保留多条历史 |
| 加 userId 字段 | 为后续用户维度 memory 管理预留，避免跨表 JOIN |
| 不按 session/沙箱维度拆分 | 过期的 messages 在摘要生成后被覆盖，无保留价值 |

### 与现有表的职责划分

| 表 | 职责 | 读者 | 生命周期 |
|---|---|---|---|
| `Message` | 前端展示聊天气泡 | 前端 | 永久 |
| `AgentConversation` | Agent 内部工作记忆 | Worker | 沙箱过期时压缩覆盖 |
| `SandboxSession` | 沙箱连接信息 | Worker | 跟沙箱同步 |

---

## 三、Agent Loop 接口改造

入参新增 `existingMessages`：

```typescript
export interface AgentLoopConfig {
  projectId: string;
  sandbox: Sandbox;
  systemPrompt: string;
  userMessage: string;
  existingMessages?: OpenAI.ChatCompletionMessageParam[];  // 新增
  maxSteps?: number;
  maxTokensPerTurn?: number;
}
```

返回值新增 `finalMessages`：

```typescript
export interface AgentLoopResult {
  success: boolean;
  summary: string;
  steps: number;
  previewUrl: string | null;
  finalMessages: OpenAI.ChatCompletionMessageParam[];  // 新增
}
```

内部初始化逻辑变化：

```typescript
const messages = config.existingMessages
  ? [...config.existingMessages, { role: "user", content: userMessage }]
  : [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
```

---

## 四、三种场景的完整流程

### 场景 1：首次生成（generate）

```
1. 创建沙箱
2. agentLoop（无 existingMessages，从零开始）
3. 成功后：
   - keepAlive(sandbox, 15min)
   - upsert AgentConversation:
       userId, projectId, sandboxId,
       messages = result.finalMessages,
       tokenEstimate = 估算值,
       summary = null
   - Message 表存一条 assistant 摘要（给前端展示）
```

### 场景 2：迭代 — 沙箱复用成功

```
1. 查 AgentConversation（where: projectId）
2. connectSandbox(conversation.sandboxId) → 成功
3. agentLoop:
     existingMessages = conversation.messages
     userMessage = buildIteratePromptReused(prompt)
4. 成功后：
   - keepAlive(sandbox, 15min)
   - 更新 AgentConversation:
       messages = result.finalMessages
       tokenEstimate = 新值
   - Message 表存 assistant 摘要
```

### 场景 3：迭代 — 沙箱过期，降级新建

```
1. 查 AgentConversation
2. connectSandbox(conversation.sandboxId) → 失败
3. 触发摘要生成：
     summary = await generateConversationSummary(conversation.messages)
     更新 conversation.summary = summary
4. 创建新沙箱 + 恢复文件
5. agentLoop:
     existingMessages = null（从零开始）
     userMessage = buildIteratePromptWithContext(prompt, summary)
     // summary 注入到 prompt 中，让 Agent 知道项目历史
6. 成功后：
   - keepAlive(sandbox, 15min)
   - 覆盖 AgentConversation:
       sandboxId = 新 ID
       messages = result.finalMessages
       summary = null（新会话开始，旧摘要已注入不再需要）
       tokenEstimate = 新值
```

---

## 五、摘要生成

### 触发时机

仅在沙箱过期、降级新建时触发一次。不是定时任务。

### 实现方式

1. 从 messages 数组中提取所有 user 消息 + assistant 的 content（不含 tool_call 细节）
2. 调 LLM（用同一个 provider，便宜模型即可）生成 200 字以内的结构化摘要
3. 摘要内容包含：项目是什么、做了哪些关键修改、用户偏好

### 容错

LLM 调用失败时 summary 设为 null，降级为无上下文的普通 iterate prompt（不阻塞主流程）。

---

## 六、Token 超限保护

### 场景

沙箱一直活着，用户连续迭代 15-20 轮，messages 接近 128K context 上限。

### 策略

每轮结束存入 DB 前检查 tokenEstimate，超过 80K 时就地压缩。

### 压缩规则

- 保留 system prompt（第一条）
- 保留最近 3 轮的完整内容（含 tool_call/tool_result）
- 更早的轮次：只保留 user 消息 + assistant 的 content 文本，丢弃 tool_call 参数和 tool_result

### 效果

压缩后 Agent 仍然知道早期做了什么（通过 assistant 的思考文本），但不占用大量 token 存文件内容。

---

## 七、并发安全

### 问题

用户快速连续发两条消息，两个 iterate 任务同时读/写同一个 conversation。

### 方案

Worker 内存中维护 project 级别锁，保证同一 project 的任务串行执行。

```typescript
const projectLocks = new Map<string, Promise<void>>();

async function withProjectLock(projectId: string, fn: () => Promise<void>) {
  const existing = projectLocks.get(projectId);
  const task = (existing || Promise.resolve()).then(fn).finally(() => {
    if (projectLocks.get(projectId) === task) {
      projectLocks.delete(projectId);
    }
  });
  projectLocks.set(projectId, task);
  return task;
}
```

Worker 处理 iterate 任务时包裹在 `withProjectLock(projectId, ...)` 中。不同 project 的任务仍然并发（concurrency: 2），同一 project 的任务串行。

---

## 八、新增 Prompt 函数

新增 `buildIteratePromptWithContext`（沙箱过期降级时使用）：

```typescript
export function buildIteratePromptWithContext(
  userRequest: string,
  summary: string | null
): string {
  const contextBlock = summary
    ? `## 项目背景\n${summary}\n\n`
    : "";

  return `用户要求对现有项目进行修改。

${contextBlock}## 用户需求
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

---

## 九、边界情况处理

| 边界情况 | 处理方式 |
|---------|---------|
| 首次生成，无 AgentConversation 记录 | agentLoop 从零开始，结束后 create 记录 |
| 沙箱复用成功，但 messages 为空或解析失败 | 当作无历史处理，从零开始 |
| 沙箱复用成功，但 conversation.sandboxId 与实际不匹配 | 清空 messages，从零开始 |
| 摘要生成 LLM 调用失败 | summary 设为 null，降级为无上下文 iterate prompt |
| tokenEstimate 超限（>80K） | 存入前压缩，保留最近 3 轮完整 + 早期只留 user/assistant content |
| Agent Loop 中途崩溃 | messages 不更新（保持上一次成功状态） |
| 并发：同一 project 两个 iterate | project 级别内存锁保证串行 |
| 项目删除 | onDelete: Cascade 自动清理 |
| Worker 重启 | 内存锁丢失，但 BullMQ 同一 job 不会重复消费，无并发风险 |

---

## 十、改动文件清单

| 文件 | 改动内容 |
|------|---------|
| `prisma/schema.prisma` | 新增 `AgentConversation` 模型 + Project 加 relation |
| `src/lib/agent/loop.ts` | 接口加 `existingMessages` 入参 + 返回 `finalMessages` |
| `src/lib/agent/prompt.ts` | 新增 `buildIteratePromptWithContext()` |
| `src/lib/agent/conversation.ts`（新建） | `generateConversationSummary()` + `compressMessagesIfNeeded()` |
| `src/lib/queue/orchestrator.ts` | generate/iterate 中管理 conversation 生命周期 |
| `src/worker.ts` | iterate 任务包裹 `withProjectLock()` |

---

## 十一、数据流全景

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 1 轮（generate）                                                      │
│                                                                         │
│ messages = [system, user:"做摄影网站"]                                    │
│     ↓ Agent Loop 执行                                                    │
│ messages = [system, user, asst+tool_call, tool, asst+tool_call, ...]    │
│     ↓ 结束                                                               │
│ → DB: AgentConversation.messages = 完整数组                               │
│ → DB: AgentConversation.sandboxId = "sb_001"                            │
│ → sandbox.keepAlive(15min)                                              │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓ 用户 3 分钟后追问
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 2 轮（iterate，沙箱复用成功）                                           │
│                                                                         │
│ 读取 DB: conversation.messages（上轮完整历史）                             │
│ messages = [...history, user:"把标题改红"]                                │
│     ↓ Agent Loop 继续                                                    │
│ messages = [...history, user, asst+tool_call, tool, ...]                │
│     ↓ 结束                                                               │
│ → DB: AgentConversation.messages = 更新后的完整数组                        │
│ → sandbox.keepAlive(15min)                                              │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓ 用户 30 分钟后回来
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 3 轮（iterate，沙箱过期）                                              │
│                                                                         │
│ connect(sb_001) → 失败！                                                 │
│ 触发摘要生成：                                                            │
│   LLM(conversation.messages) → "暗色摄影作品集，含 Hero/Gallery/About，   │
│                                  标题已改为红色，6 个文件，Vite 构建通过"   │
│ → DB: conversation.summary = 摘要                                        │
│                                                                         │
│ 创建新沙箱 sb_002 + 恢复文件                                              │
│ messages = [system, user: buildIteratePromptWithContext(prompt, summary)] │
│     ↓ Agent Loop 执行                                                    │
│ messages = [system, user, asst+tool_call, tool, ...]                    │
│     ↓ 结束                                                               │
│ → DB: AgentConversation = { sandboxId: "sb_002", messages: 新数组,       │
│                              summary: null, tokenEstimate: 新值 }        │
│ → sandbox.keepAlive(15min)                                              │
└─────────────────────────────────────────────────────────────────────────┘
```
