# V6 - Human-in-the-Loop 意图识别与澄清系统

## 1. 问题定义

用户在描述需求时往往无法精确表达想要的功能。当前 Agent Loop 采用"直接执行"模式——用户说什么就做什么，缺乏中间确认环节。这导致：

- 方向性错误：用户说"做个官网"，Agent 猜测风格/结构，做完发现不是用户想要的
- 细节歧义：用户说"加个表格"，到底是展示型还是可编辑型？
- 无效循环：做错了再改，浪费算力和用户时间

## 2. 设计目标

1. **前置拦截**：在进入 Agent Loop 之前，对模糊需求进行意图分析和选项澄清
2. **过程中兜底**：在 Agent Loop 执行过程中，对关键决策点支持向用户提问（极度克制）
3. **最小打断**：过程中提问依赖语义级 prompt 约束让模型自我克制，仅保留一个防极端情况的 failsafe 计数器
4. **体验流畅**：选项卡片式交互，用户点选即可；同时提供 Other 选项允许自由输入补充

## 3. 整体架构

```
用户发送消息
  │
  ▼
┌──────────────────────────────────────────────────┐
│            快速跳过判断（纯代码规则）                │
│                                                  │
│  短消息/明确修改指令/非首轮迭代 → 直接进入 agentLoop │
│  其他情况 → 进入前置意图分析                        │
└──────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────┐
│           前置意图分析（Phase 1）                   │
│                                                  │
│  同一 LLM → structured JSON output               │
│  判断 clarity: high / medium / low                │
│                                                  │
│  high → 直接进入 agentLoop（用 rewritten_query）   │
│  medium → 展示 rewritten_query 让用户确认          │
│  low → 推送选项卡片让用户选择                       │
└──────────────────────────────────────────────────┘
          │ 用户选择/确认后
          ▼
┌──────────────────────────────────────────────────┐
│            Agent Loop（Phase 2）                   │
│                                                  │
│  正常 tool_call → 继续执行                        │
│  ask_user tool_call:                             │
│    ├── failsafe 计数器 < 3 → 挂起等待             │
│    └── failsafe 计数器 >= 3 → 返回"请自行决策"     │
└──────────────────────────────────────────────────┘
```

## 4. Phase 1：前置意图分析

### 4.1 触发时机与快速跳过

在调用 LLM 之前，先用纯代码规则判断是否需要做意图分析：

```typescript
function shouldSkipIntentAnalysis(content: string, isFirstMessage: boolean): boolean {
  // 规则1：非首轮对话 + 短消息（迭代修改场景），直接执行
  if (!isFirstMessage && content.length < 80) return true;

  // 规则2：明显的具体修改指令
  if (/^(把|将|修改|删除|去掉|添加|加个|换成|改成)/.test(content)) return true;

  // 规则3：极短的指令（<30字），通常是明确的
  if (content.length < 30) return true;

  return false;
}
```

设计意图：**意图分析主要作用于首轮对话且用户输入比较模糊时**。后续迭代轮次几乎不触发，避免每条消息多等 2-4 秒。

### 4.2 意图分析 Prompt

```
你是一个需求分析助手。用户想要构建或修改一个网站。请分析用户的输入，判断需求是否足够清晰可以直接执行。

## 输出格式（严格 JSON）

{
  "clarity": "high" | "medium" | "low",
  "intent": "build_new" | "modify_existing" | "explain" | "other",
  "rewritten_query": "扩写后的完整需求描述（无论 clarity 值如何都要填写）",
  "missing_info": [
    {
      "aspect": "缺失的维度名称",
      "question": "要问用户的问题",
      "options": ["选项1", "选项2", "选项3"]
    }
  ]
}

## clarity 判断标准（偏保守：宁可漏判不要误判）

- high：用户明确说出了要什么页面、什么功能、什么风格（至少2个维度清晰）
- medium：大方向清楚但缺少关键细节（如只说了类型没说风格，或只说了功能没说结构）
- low：非常模糊，可以有多种完全不同的理解（仅限"做个官网"这种极度模糊的情况）

## 限制

- missing_info 最多 3 项
- 每项的 options 为 2-4 个
- options 必须是互斥的、具体的选项，不要有"其他"这种兜底项（前端会自动加 Other 入口）
- 如果 clarity 为 high，missing_info 应为空数组
- 偏向判定为 high——如果你犹豫是 medium 还是 high，选 high

## 示例

用户输入: "帮我做个官网"
→ clarity: low
→ missing_info: [页面结构, 视觉风格, 行业/内容]

用户输入: "做一个简约风格的个人博客，要有文章列表和详情页"
→ clarity: high
→ missing_info: []

用户输入: "加个联系表单"
→ clarity: medium
→ missing_info: [表单字段/复杂度]
```

### 4.3 输出结构定义

```typescript
// src/lib/agent/intent.ts

interface IntentAnalysis {
  clarity: "high" | "medium" | "low";
  intent: "build_new" | "modify_existing" | "explain" | "other";
  rewritten_query: string;
  missing_info: ClarificationItem[];
}

interface ClarificationItem {
  aspect: string;
  question: string;
  options: string[];  // 2-4 项（前端额外渲染 Other 入口）
}
```

### 4.4 前端交互流程

```
clarity: high
  → 无感知，直接进入生成流程
  → 内部使用 rewritten_query 替代原始 input（更丰富的上下文给 Agent）

clarity: medium
  → 推送 SSE 事件 clarification_needed
  → 前端展示: "我理解你想要：{rewritten_query}，对吗？"
  → 用户可选: [确认开始] [我再补充一下]
  → 确认后用 rewritten_query 进入 agentLoop

clarity: low
  → 推送 SSE 事件 clarification_needed
  → 前端渲染选项卡片（每个 missing_info 一组）
  → 每组选项下方有 Other 入口（次级文字链接）
  → 用户逐项选择后，拼装增强 prompt 进入 agentLoop
  → 始终包含一个全局兜底: [让 AI 自由发挥，直接开始]
```

### 4.5 Other 选项设计

**定位：逃生通道，不是主要交互路径。**

- A/B/C 选项是大按钮，一眼可见
- Other 是底部一行小字链接："以上都不是？补充说明"
- 点击后展开一个 input（限 200 字符），确认后提交
- Other 的输入内容同样作为该 aspect 的选择结果，拼入增强 prompt

大部分用户会直接从选项中选一个（0.5 秒完成），少数情况才会打字。

### 4.6 SSE 事件新增

```typescript
// 新增到 SSEEvent 联合类型
| { type: "clarification_needed"; data: {
    clarity: "medium" | "low";
    rewritten_query: string;
    missing_info: ClarificationItem[];
  }}
| { type: "clarification_resolved"; data: {
    enhanced_prompt: string;
  }}
```

### 4.7 API 变更

```
POST /api/projects/:id/messages
  请求体新增可选字段:
  {
    content: string;
    clarification_response?: {
      selections: Record<string, string>;  // aspect → 选中的 option 或 Other 输入内容
      skip?: boolean;  // true = 用户选了"让 AI 自由发挥"
    }
  }

  流程:
  1. 如果有 clarification_response → 拼装增强 prompt → 创建 run → enqueue
  2. 如果没有 → shouldSkipIntentAnalysis 判断 → 跳过则直接执行
  3. 不跳过 → 调用意图分析 → 根据 clarity 决定直接执行还是推送选项
```

### 4.8 增强 Prompt 拼装逻辑

```typescript
function buildEnhancedPrompt(
  original: string,
  rewritten: string,
  selections: Record<string, string>
): string {
  const selectionLines = Object.entries(selections)
    .map(([aspect, choice]) => `- ${aspect}: ${choice}`)
    .join("\n");

  return `## 用户原始需求
${original}

## 需求细化
${rewritten}

## 用户确认的偏好
${selectionLines}`;
}
```

注意：只有 `enhanced_prompt` 最终进入 agent loop 的 messages，中间的 options 结构不保留。这是控制上下文膨胀的关键。

## 5. Phase 2：过程中 Human-in-the-Loop

### 5.1 设计哲学

> "约束应该是语义级的，不是代码级的。让模型理解什么场景该问、什么场景不该问，而不是用机械规则拦它。"

核心思路：**提高 ask_user 的心理门槛，降低"自行决策"的心理负担。**

不采用复杂的 guard 函数（频率限制 + 冷却期 + runType 判断），而是：
- 通过 system prompt 中的**自检框架**让模型内化克制
- 仅保留一个极简 failsafe 计数器防极端情况

### 5.2 ask_user 工具定义

```typescript
{
  type: "function",
  function: {
    name: "ask_user",
    description: "暂停执行，向用户提出一个选择题。这是最后手段，不是默认行为。",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "简洁明确的问题，一句话"
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "选项名称，3-8字" },
              description: { type: "string", description: "选项含义说明" }
            },
            required: ["label", "description"]
          },
          minItems: 2,
          maxItems: 4,
          description: "互斥的选项列表"
        },
        context: {
          type: "string",
          description: "一句话解释为什么需要问这个问题"
        }
      },
      required: ["question", "options", "context"]
    }
  }
}
```

### 5.3 克制机制：语义级 Prompt 约束

不依赖代码级的频率限制/冷却期，而是在 system prompt 中植入自检框架：

```
## ask_user 工具

这个工具让你可以暂停执行，向用户提出一个选择题。

### 使用前的自检（每次想调用前，内心过一遍以下问题，全部为"是"才能使用）

1. 如果我猜错了，用户需要等我重新生成 50% 以上的代码吗？
   - 如果只是某个局部细节猜错了，用户可以下一轮告诉我修改 → 不要问

2. 我是否已经穷尽了上下文中的所有线索？
   - 用户的描述、已有代码风格、行业常识、前面的对话 → 先从这些推断

3. 这个问题是否只有用户本人能回答？
   - 如果一个有经验的开发者可以给出合理默认值 → 直接用默认值做

4. 用户此刻是否在等我出活？
   - 打断正在进行的生成流程，心理成本很高。你问的问题值得用户多等 30 秒吗？

### 你的默认立场

永远倾向于自行决策。做一个合理但可能不完美的选择，远好过停下来问用户。
用户可以在看到结果后告诉你"换一种方式"。这个迭代成本比打断流程更低。

### 典型的"不该问"场景

- 视觉偏好（颜色、字号、间距、动画风格）→ 选择当前最主流的做法
- 实现方案（用 grid 还是 flex、拆不拆组件）→ 你的判断就是答案
- 内容填充（示例文案、placeholder 数据）→ 合理编造
- 已经有一个明显更优的选项 → 直接用它，不需要用户确认你的判断
- 已经在前置澄清中确认过的维度 → 不要重复问

### 典型的"可以问"场景

- 用户说"加个表单"，但表单可以是 3 字段简单版或 10 字段完整版，两者 UI 结构完全不同
- 用户想要的功能存在两种互斥的交互模式（标签页切换 vs 手风琴折叠），无法从上下文推断
- 当前需求和已有代码存在结构性冲突，需要用户决定保留哪边
```

### 5.4 唯一的硬性 Failsafe

仅保留一个计数器，防止模型在极端 corner case 下陷入疯狂提问的死循环（如模型幻觉导致反复认为信息不足）：

```typescript
// 在 agentLoop 的 tool 执行分支中
if (fnName === "ask_user") {
  if (askUserCount >= 3) {
    messages.push({
      role: "tool",
      content: "系统限制：本次任务已多次向用户提问。请基于现有信息自行做出最佳判断，继续执行。",
      tool_call_id: toolCall.id,
    });
    continue;
  }
  askUserCount++;
  // ...正常的挂起流程
}
```

没有冷却期，没有 runType 判断，没有复杂 state 管理。就一个计数器防极端情况。

### 5.5 挂起/恢复机制（精确位置恢复）

#### 核心问题

OpenAI 兼容 API 有硬性约束：**assistant message 中的每个 tool_call 都必须有对应的 tool result，否则下次 LLM 调用报错。**

如果 LLM 在一次响应中返回了 `[write_file, ask_user]` 两个 tool_calls，不能只给一个 result。

#### 恢复策略：策略 B 为主 + 策略 A 兜底

**策略 B（主）**：Prompt 中约束 ask_user 必须独占一轮

在 system prompt 中加："当你决定使用 ask_user 时，这一轮只调用 ask_user 一个工具，不要和其他工具一起调用。"

此时状态保存极简：完整的 messages 数组 + 一个 tool_call_id。

**策略 A（兜底）**：如果 LLM 还是混合了多个 tool_calls

遍历 tool_calls 时，先执行 ask_user 之前的所有 tool_calls 并收集 results，然后再挂起。

**关键**：ask_user 之后的 tool_calls 也必须处理。assistant message 中所有 tool_call 都需要有对应的 tool result，否则恢复后下次 LLM 调用报错。处理方式：对 ask_user 之后的 tool_calls，注入合成 result（`"因用户交互中断，未执行此操作"`），或在保存 LoopSuspendState 时从 assistant message 中裁剪掉 ask_user 之后的 tool_calls。推荐裁剪方案——避免 LLM 误以为有操作被跳过从而产生困惑。

#### 保存的状态结构

```typescript
interface LoopSuspendState {
  messages: OpenAI.ChatCompletionMessageParam[];  // 包含最后的 assistant message
  completedToolResults: {                          // ask_user 之前已执行的 tool results
    tool_call_id: string;
    content: string;
  }[];
  pendingToolCallId: string;                      // ask_user 的 tool_call_id
  step: number;
  askUserCount: number;
  previewUrl: string | null;
}
```

#### 恢复逻辑

```typescript
async function resumeLoop(runId: string, userAnswer: string) {
  const saved = await loadLoopState(runId);

  // 重建 messages：先追加已完成的 tool results，再追加 ask_user 的 result
  const messages = [...saved.messages];
  for (const result of saved.completedToolResults) {
    messages.push({ role: "tool", content: result.content, tool_call_id: result.tool_call_id });
  }
  messages.push({ role: "tool", content: userAnswer, tool_call_id: saved.pendingToolCallId });

  // 此时 messages 是完整且合法的 → 传入 agentLoop 继续执行
  await agentLoop({
    ...originalConfig,
    existingMessages: messages,
    // 从 saved.step + 1 继续计数
  });
}
```

所有 tool_calls 都有对应的 results，LLM 可以正常继续推理。

### 5.6 恢复 API

```
POST /api/projects/:id/answer
{
  runId: string;
  answerToken: string;       // 幂等 token，防双重恢复
  answer: string;            // 用户选择的 option label，或 Other 输入内容
  isOther?: boolean;         // 是否是 Other 自由输入
  skipAndContinue?: boolean; // 用户点了"跳过，AI 自行决定"
}
```

answer 作为 tool result 注入 messages 的格式：
- 选择选项: `"用户选择了：{label}"`
- Other 输入: `"用户选择了 [其他]，补充说明：{用户输入}"`
- 跳过: `"用户选择跳过，请自行选择最合理方案继续执行。"`

### 5.7 前端处理

```typescript
// use-project-stream.ts 新增 action
| { type: "ASK_USER"; question: string; options: AskUserOption[]; context: string }

// 渲染规则：
// - 卡片出现在 timeline 中间（不是弹窗/modal），不阻断信息流
// - 用灰色/中性色调，视觉权重轻
// - 标题: "快速确认"
// - 上下文说明: context 字段
// - 选项按钮: 2-4 个（主要交互）
// - Other 入口: 底部小字"以上都不是？补充说明"，点击展开 input（限 200 字符）
// - 兜底: "跳过，让 AI 自行决定"（视觉弱于选项按钮）
// - 超时: 60 秒后显示"AI 将自动继续"，90 秒自动恢复
```

## 6. 潜在问题与对策

### 6.1 并发问题

| 问题 | 风险 | 对策 |
|------|------|------|
| 用户等待期间发新消息 | waiting_for_user 状态下新消息创建 run 的冲突 | `waiting_for_user` 纳入 active run 判断（返回 409），前端禁用输入框 |
| 双重恢复竞态 | 用户点了回答 + 前端超时同时触发恢复 | `/answer` 接口幂等设计（answerToken 去重） |
| 进程崩溃后孤儿状态 | Loop state 保存成功但进程挂了 | 定时任务扫描 `waiting_for_user` 超过 5 分钟的 run，标记为 failed |

### 6.2 安全问题

| 问题 | 风险 | 对策 |
|------|------|------|
| rewritten_query 中的注入 | LLM 改写可能"洗白"恶意输入 | rewritten_query 长度限制 500 字符；选项制本身大幅降低风险 |
| Other 自由输入的注入 | 用户在 Other 中写恶意指令 | 限制 200 字符 + 作为 tool result role 注入（权重低于 system/user） |
| ask_user 回答注入 | 回答内容影响后续 Agent 行为 | 回答仅从预设 options 选择或受限的 Other 输入，不允许无限制文本 |

### 6.3 性能问题

| 问题 | 影响 | 对策 |
|------|------|------|
| 前置分析额外 LLM 调用（1.5-4s） | clarity: high 场景纯属浪费 | shouldSkipIntentAnalysis 快速跳过规则，大部分迭代消息不走分析 |
| 挂起后沙箱超时 | 恢复时沙箱可能已过期（10分钟） | 恢复前检查沙箱存活，必要时重建并恢复文件 |
| Loop State 序列化/反序列化 | 典型 run 的 messages 可能 50KB+ | 只在 ask_user 触发时才序列化（不是每步都存） |

### 6.4 用户体验问题

| 问题 | 影响 | 对策 |
|------|------|------|
| clarity 误判为 low | 用户觉得"我说得很清楚了为什么还问我" | 阈值偏保守（宁可漏判不误判）；prompt 中强调"犹豫时选 high" |
| 选项无法覆盖用户需求 | 所有选项都不对，只有跳过可选 | Other 入口允许自由补充；"让 AI 自由发挥"兜底 |
| 过程中 ask_user 打断感 | 用户切了标签页回来发现 Agent 在等 | 90 秒超时自动继续 + 推送通知 |
| 选项间存在关联性 | 选了"企业官网"后风格选项应变化 | V1 不处理选项联动，接受这个局限性 |

### 6.5 上下文膨胀问题（最严重的隐患）

| 膨胀源 | Token 成本 | 对策 |
|--------|-----------|------|
| 前置分析的中间结构（options等） | ~500 tokens/次 | **只保留最终 enhanced_prompt，中间 JSON 不进入 messages** |
| ask_user 的 tool_call 消息 | ~300-500 tokens/次 | 恢复后可压缩为简短的 "asked X, user chose Y"（可选优化） |
| 多轮对话累积的历史澄清信息 | 线性增长 | 非首轮对话不触发前置分析（快速跳过规则已解决） |
| Loop 整体 messages 增长 | 每步 +1~3 条消息 | 现有 truncateOutput 机制 + 未来可做 context summarization |

**核心原则**：进入 agent loop 的 messages 中，只应该出现最终的增强 prompt 文本，不应该出现意图分析的中间过程。

## 7. 改动范围评估

### 7.1 后端改动

| 文件 | 改动 | 复杂度 |
|------|------|--------|
| `src/lib/agent/intent.ts` | **新建** - 意图分析模块（含快速跳过逻辑） | 中 |
| `src/lib/agent/tools.ts` | 新增 ask_user 工具定义 | 低 |
| `src/lib/agent/loop.ts` | 加入 ask_user 的挂起逻辑 + failsafe 计数器 | 高 |
| `src/lib/agent/prompt.ts` | system prompt 末尾追加自检框架 | 低 |
| `src/lib/streaming/events.ts` | 新增 SSE 事件类型 | 低 |
| `src/app/api/projects/[id]/messages/route.ts` | 加入前置意图分析分支 | 中 |
| `src/app/api/projects/[id]/answer/route.ts` | **新建** - 用户回答恢复 API（含幂等处理） | 中 |

### 7.2 前端改动

| 文件 | 改动 | 复杂度 |
|------|------|--------|
| `src/hooks/use-project-stream.ts` | 新增 clarification / ask_user 事件处理 | 中 |
| `src/components/chat-panel.tsx` | 渲染选项卡片 UI + 禁用输入框逻辑 | 中 |
| `src/components/clarification-card.tsx` | **新建** - 选项卡片组件（含 Other 展开输入） | 中 |

### 7.3 数据库改动

```prisma
// ProjectRun 的 status 枚举新增值
enum RunStatus {
  queued
  running
  waiting_for_user   // 新增
  completed
  failed
  cancelling
  cancelled
}

// 新建表存储 loop state
model LoopState {
  id           String   @id @default(cuid())
  runId        String   @unique
  messages     Json     // 序列化的 messages 数组
  step         Int
  state        Json     // askUserCount, completedToolResults, pendingToolCallId 等
  answerToken  String   @unique  // 幂等 token
  createdAt    DateTime @default(now())
}
```

## 8. 关键设计决策

### 8.1 为什么用语义约束替代代码级限制？

| 代码级限制（频率+冷却期） | 语义级 prompt 约束 |
|--------------------------|-------------------|
| 管次数不管质量——不该问的问题只要没超次数就放行 | 每次调用前自检，大部分情况自我否决 |
| 误杀真正需要问的场景（第 3 次确实需要问） | 模型自己判断值不值得问 |
| 代码复杂度高（guard 函数、state 管理、冷却逻辑） | 就是一段 prompt |
| 模型能力升级后还是老规则 | 自然适应，更聪明的模型更会克制 |

唯一保留计数器 3 的原因：不是为了"正常使用"，而是防止模型在极端 corner case 下的死循环。这是 failsafe，不是约束。

### 8.2 为什么不用独立的轻量模型做意图分析？

- 同一模型对需求的理解一致性更好
- 避免引入额外的模型配置和运维复杂度
- 意图分析只是一次调用，成本增加有限
- 后续如果成本敏感，可以无缝切换为轻量模型（接口不变）

### 8.3 挂起/恢复 vs WebSocket 双向通信

选择挂起/恢复模式（保存状态 → 退出 loop → API 恢复）而非 WebSocket：
- 与现有 SSE + REST 架构一致，不引入新协议
- 天然支持断线重连（状态在 DB 中）
- 实现更简单，不需要维护长连接状态

### 8.4 为什么 Other 是次级入口？

- 选项制的核心价值是"降低用户认知负担"——看选项比组织语言快
- 如果 Other 和 A/B/C 平级，用户第一眼就跳到自由输入，失去了选项引导的意义
- Other 存在是为了覆盖"选项都不对"的 edge case，不是鼓励用户使用

## 9. 用户体验细节

### 9.1 前置澄清的卡片样式

```
┌─────────────────────────────────────────────────┐
│  💡 帮我确认几个细节，好让结果更符合你的预期        │
├─────────────────────────────────────────────────┤
│                                                 │
│  页面结构                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ 单页应用  │ │ 多页站点  │ │ 落地页    │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  以上都不是？补充说明                             │
│                                                 │
│  视觉风格                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ 简约现代  │ │ 大胆配色  │ │ 企业商务  │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  以上都不是？补充说明                             │
│                                                 │
│  ─────────────────────────────────────────────  │
│  [✨ 让 AI 自由发挥，直接开始]                    │
└─────────────────────────────────────────────────┘
```

### 9.2 过程中 ask_user 的卡片样式

```
┌─────────────────────────────────────────────────┐
│  ⚡ 快速确认                                     │
│                                                 │
│  "联系表单需要哪些字段？"                         │
│                                                 │
│  因为：两种实现差异较大，确认后可以一步到位          │
│                                                 │
│  ┌──────────────────────────────────────┐       │
│  │ 简单版（姓名+邮箱+留言）              │       │
│  └──────────────────────────────────────┘       │
│  ┌──────────────────────────────────────┐       │
│  │ 完整版（姓名+邮箱+电话+主题+留言）     │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│  以上都不是？补充说明                             │
│  [跳过，让 AI 自行决定]              [60s 后自动] │
└─────────────────────────────────────────────────┘
```

### 9.3 超时处理

- 前置澄清：无超时，等用户操作（因为还没开始生成，用户没有"等待焦虑"）
- 过程中 ask_user：60 秒无操作后显示"AI 将自动继续"倒计时，90 秒后自动以"用户未回答，请自行选择最合理方案"作为 tool result 恢复 loop

### 9.4 视觉权重原则

- 卡片出现在 timeline 中间，不是弹窗/modal，不阻断信息流
- 用灰色/中性色调，不要蓝色/橙色"请注意"风格
- 感受应该是："哦 AI 问了我一个问题，让我选一下" → 1 秒选完继续
- 而不是："AI 停下来了，需要我认真思考做决策"

## 10. 实施顺序建议

1. **Phase 1 先行**：前置意图分析 + 快速跳过逻辑 + 选项卡片 UI（含 Other）
   - 独立完整，不影响现有 agent loop
   - 低风险，可快速验证效果
2. **Phase 2 跟进**：ask_user tool + 挂起/恢复机制 + 幂等恢复 API
   - 需要改 agent loop 核心逻辑，风险较高
   - 建议先写好恢复逻辑的测试再上线
3. **调优**：根据实际使用数据调整 clarity 阈值、评估 ask_user 使用频率是否合理

## 11. 业界参考

| 产品 | 方案 | 借鉴点 |
|------|------|--------|
| Claude Code | AskUserQuestion tool + 选项卡片 | 选项结构设计、tool description 约束写法、Other 选项 |
| Cursor | Tab-to-accept 确认制 | 轻量确认不打断流程 |
| v0.dev | 前置模板选择 + 风格选项 | 前置澄清的 UX 模式 |
| Devin | Plan → Confirm → Execute | 计划确认制 |
| Bolt.new | 直接执行 + 快速迭代 | 对比：不确认但允许快速修改 |
| Dialogflow | Intent + Slot Filling | 结构化意图分类思路 |

## 12. Code Review 发现的 P0 问题

### 12.1 `/answer` 路由竞态 — 同一 run 被双重执行

**问题描述**

`/api/projects/:id/answer` 中，状态检查（`status !== "waiting_for_user"`）和状态更新（`status → "running"`）之间没有原子保护。双击按钮、网络重试等场景下：

```
请求A: 读取 status = "waiting_for_user" ✓
请求B: 读取 status = "waiting_for_user" ✓  (请求A的 update 还没落盘)
请求A: update status → "running", enqueueRun
请求B: update status → "running", enqueueRun  ← 同一个 run 被入队两次
```

后果：两个 worker 并行执行同一个 run，写同一批文件，输出交叉、数据损坏。

**解决思路**

用带条件的 `updateMany` 做乐观锁，把"检查+翻转"合成一条原子 SQL：

```typescript
const claimed = await prisma.projectRun.updateMany({
  where: { id: runId, status: "waiting_for_user" },
  data: { status: "running" },
});
if (claimed.count === 0) {
  return Response.json({ error: "Run is not waiting for user input" }, { status: 409 });
}
```

单条 UPDATE 在数据库层面天然串行化——两个请求同时执行，只有一个能 match 到 `status = "waiting_for_user"`。

---

### 12.2 消息重复写入 — 澄清流程产生脏数据

**问题描述**

流程追踪：
1. 用户发送模糊消息 → `messages/route.ts` 保存了一条 message（返回 202）
2. 用户选完选项后，前端带着相同 `content` + `clarification_response` 再次 POST
3. 进入 branch 1 → `createMessageAndRun` 又创建了一条相同内容的 message

后果：conversation history 出现重复的用户消息，Agent 后续 iterate 时读到重复上下文影响推理质量；前端 timeline 也会渲染两条一样的气泡。

**解决思路**

两种方案可选：

- 方案 A：status 202 时不保存 message，等用户确认后才保存（最干净）
- 方案 B：branch 1 中不创建 message，只创建 run 并引用已有的 messageId

推荐方案 A——保持"一次用户动作 = 一条 message"的不变式。

---

### 12.3 三步非原子操作 — 崩溃导致 run 永久卡死

**问题描述**

`/answer` 路由中三步操作没有原子性保证：

```typescript
await prisma.projectRun.update({ status: "running" });     // step 1
await prisma.loopState.update({ resumeReady: true });      // step 2
await enqueueRun(runId, id, DEMO_USER_ID);                 // step 3
```

如果进程在 step 1 之后、step 3 之前崩溃：run 状态变成 `running` 但没有 worker 会处理它（没入队或 loopState 没标记 resumeReady）。这个 run 将永远卡在 `running` 状态。

**解决思路：orchestrator 层加幂等 claim**

不在 `/answer` 路由层追求三步原子（跨 Redis 入队无法事务化），而是在消费侧（orchestrator）做幂等保护。利用现有的 `answerToken` 字段做 claim 标记：

```typescript
// orchestrator 中 claim resume 执行权
const claimed = await prisma.loopState.updateMany({
  where: { runId, answerToken: loopState.answerToken }, // answerToken 非空 = 还没被领
  data: { answerToken: "" },                            // 置空 = 标记已领取
});

if (claimed.count === 0) {
  // 别的 worker 已经抢走了，或重复入队，跳过
  return;
}

await executeResume(runId, projectId, loopState);
```

**原理**：PostgreSQL 单条 UPDATE 天然串行化。两个 worker 同时执行这条 SQL，只有一个能 match 到 `answerToken = "xxx"`（另一个执行时行已经被改成空字符串了）。不需要事务、不需要 `FOR UPDATE`、不需要加字段、不需要 Redis 锁。

**多 worker 横向扩展也安全**：这个方案不依赖应用层状态，完全靠数据库行级锁语义，多进程/多机器部署天然兼容。

**防御层次总结**：

| 层 | 防什么 | 手段 |
|----|--------|------|
| `/answer` API 层 | 双击/前端重试产生重复入队 | `updateMany` 乐观锁（12.1 的修复） |
| orchestrator 消费层 | 队列 at-least-once 投递 / 崩溃重启 redeliver | `answerToken` claim（本节方案） |

两层一起才稳——API 层减少误入队概率，orchestrator 层做最终的幂等保障。
