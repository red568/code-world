# AI Website Builder Skill 系统设计方案

## 一、核心设计哲学（借鉴 Claude Code）

### 四大原则

Claude Code 的 Skill 系统有几个关键特征值得借鉴：

1. **零注册，约定即发现** — 放一个文件到约定目录，就自动可用
2. **Skill = Markdown 声明** — 不是代码模块，而是一个描述文件，告诉 Agent "你现在多了这个能力"
3. **懒加载机制** — 元数据始终可见（供 Agent 判断何时使用），完整内容仅在调用时加载
4. **Skill ≠ Tool** — Skill 是更高层的"能力包"，可以包含 prompt 指导 + 多个 tool + 配置

### 与 Claude Code 的关键差异

你的场景和 Claude Code 有一个关键区别：Claude Code 的 Skill 运行在本地文件系统，而本项目 Agent 运行在 E2B 云沙箱里。所以需要做适配：

```
Claude Code:  Skill = 本地 .md 文件 → 注入 prompt → Agent 用已有 tools 执行
本项目:     Skill = DB 中的声明 → 注入 prompt + 动态注册 tools → Agent 在 sandbox 中执行
```
## 二、Skill 规范

### Manifest 结构

每个 Skill 的核心是一个 manifest 声明：

```typescript
interface SkillManifest {
  // 基础信息
  name: string;                    // kebab-case，如 "deploy-vercel"
  version: string;                 // semver
  description: string;             // 一句话，Agent 据此判断何时调用
  author: string;
  
  // Agent 可见部分
  prompt: string;                  // 注入 system prompt 的指导文本（Markdown）
  tools?: SkillToolDef[];          // 该 Skill 额外提供的 tools（可选）
  
  // 运行时配置
  permissions?: string[];          // 需要的权限声明，如 ["network", "env:API_KEY"]
  config_schema?: Record<string, ConfigField>;  // 用户安装时需填写的配置
  
  // 控制
  auto_invoke?: boolean;           // Agent 可否自动调用（默认 true）
  user_invocable?: boolean;        // 用户可否手动触发（默认 true）
}

interface SkillToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;          // OpenAI function schema 格式
  executor: "sandbox" | "server";  // 在哪里执行
  handler: string;                 // 执行入口（脚本路径或函数名）
}
```

### 示例：SEO 优化 Skill（Prompt-only）

```markdown
---
name: seo-optimizer
version: 1.0.0
description: 当用户提到 SEO、搜索引擎优化、meta 标签时自动激活
author: platform
auto_invoke: true
permissions: []
---

## 你现在具备 SEO 优化能力

当用户要求优化 SEO 或你判断网站需要 SEO 改进时：

1. 用 read_file 检查现有的 index.html 和各页面组件
2. 确保每个页面有正确的 <title>、<meta description>、Open Graph 标签
3. 检查语义化 HTML（h1-h6 层级、alt 属性、aria 标签）
4. 检查是否有 sitemap 和 robots.txt 需求
5. 用 write_file 写入优化后的代码

### 检查清单
- [ ] 每页唯一 title（50-60 字符）
- [ ] meta description（150-160 字符）
- [ ] OG 标签（og:title, og:description, og:image）
- [ ] 图片 alt 属性
- [ ] 语义化标签（header, main, nav, footer）
- [ ] heading 层级正确
```

**关键理念**：这个 Skill 没有额外的 tool，它只是给 Agent 注入了一段专业知识和工作流程。Agent 用现有的 read_file、write_file 就能完成。这就是 Claude Code 的核心理念：**大多数 Skill 只是 prompt，不是代码**。

## 三、系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│  前端层                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Skill 市场   │  │ 我的 Skills  │  │ 项目 Skill 配置   │  │
│  │ 浏览/安装    │  │ 管理/上传    │  │ 启用/禁用/参数    │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │ API
┌────────────────────────────▼────────────────────────────────┐
│  后端 API Layer                                              │
│  /api/skills          → CRUD、上传、安装                     │
│  /api/skills/resolve  → 给定 userId+projectId，返回生效 Skill│
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  Skill Registry (src/lib/skill/)                             │
│                                                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────┐  │
│  │ resolver │    │ loader   │    │ injector             │  │
│  │ 确定哪些  │───▶│ 加载完整  │───▶│ 注入 prompt + tools  │  │
│  │ skill 生效│    │ manifest │    │ 到 Agent Loop        │  │
│  └──────────┘    └──────────┘    └──────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  Agent Loop (改造点)                                         │
│                                                              │
│  1. 启动时调用 resolver → 获取当前生效的 skills              │
│  2. 拼接 system prompt = base prompt + skill prompts         │
│  3. 组装 tools = platform tools + skill tools                │
│  4. executeTool 增加 skill tool 分发逻辑                     │
└─────────────────────────────────────────────────────────────┘
```

### 对现有代码的最小改造

改动集中在 3 个文件，核心思路是**不破坏现有逻辑，只做扩展**：

#### 1. [src/lib/agent/tools.ts](src/lib/agent/tools.ts) — 从硬编码变为可组合

```typescript
// 现有的 AGENT_TOOLS 改名为 PLATFORM_TOOLS（内置工具）
export const PLATFORM_TOOLS = [ /* 现有 7 个工具不变 */ ];

// 新增：组装最终 tools 列表
export function buildTools(skillTools: SkillToolDef[]): OpenAI.ChatCompletionTool[] {
  const platformSchemas = PLATFORM_TOOLS;
  const skillSchemas = skillTools.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
  return [...platformSchemas, ...skillSchemas];
}

// executeTool 增加 fallback 到 skill executor
export async function executeTool(name, args, ctx, skillExecutors?) {
  switch (name) {
    // ... 现有 case 不变
    default:
      // 尝试从 skill executors 中找到对应处理器
      if (skillExecutors?.has(name)) {
        return skillExecutors.get(name)(args, ctx);
      }
      return { success: false, output: `Unknown tool: ${name}` };
  }
}
```

#### 2. [src/lib/agent/prompt.ts](src/lib/agent/prompt.ts) — system prompt 动态拼接

```typescript
export function buildSystemPrompt(skillPrompts: string[]): string {
  const skillSection = skillPrompts.length > 0
    ? `\n\n## 额外能力（Skills）\n\n${skillPrompts.join("\n\n---\n\n")}`
    : "";
  
  return BUILDER_SYSTEM_PROMPT + skillSection;
}
```

#### 3. [src/lib/agent/loop.ts](src/lib/agent/loop.ts) — 启动时注入 skills

```typescript
// AgentLoopConfig 新增字段
export interface AgentLoopConfig {
  // ... 现有字段
  skills?: ResolvedSkill[];  // 新增
}

// loop 内部使用
const tools = buildTools(config.skills?.flatMap(s => s.tools) ?? []);
const systemPrompt = buildSystemPrompt(config.skills?.map(s => s.prompt) ?? []);

// LLM 调用时用动态 tools
response = await client.chat.completions.create({
  model,
  messages,
  tools,  // 不再是硬编码的 AGENT_TOOLS
  ...
});
```
## 四、用户维度隔离

### Skill 生效优先级（从高到低）

1. **项目级配置** → 某个项目单独启用/禁用的 skill
2. **用户级安装** → 用户从市场安装的 skill（对该用户所有项目生效）
3. **平台内置** → 所有用户默认可用（如 seo-optimizer）

### 数据模型

```prisma
model Skill {
  id          String      @id @default(uuid())
  name        String      @unique        // kebab-case 唯一标识
  manifest    Json                       // 完整 SkillManifest
  source      String                     // "platform" | "community" | "custom"
  authorId    String?                    // 自定义 skill 的上传者
  published   Boolean     @default(false)
  installs    UserSkill[]
}

model UserSkill {
  userId    String
  skillId   String
  config    Json       @default("{}")    // 用户填写的配置值（如 API key）
  enabled   Boolean    @default(true)
  
  @@id([userId, skillId])
}

model ProjectSkillOverride {
  projectId  String
  skillName  String
  enabled    Boolean                     // 项目级开关
  
  @@id([projectId, skillName])
}
```

### Resolve 逻辑

```typescript
async function resolveSkills(userId: string, projectId: string): Promise<ResolvedSkill[]> {
  // 1. 获取平台内置 skills（published + source=platform）
  const platformSkills = await prisma.skill.findMany({
    where: { source: "platform", published: true }
  });
  
  // 2. 获取用户安装的 skills（UserSkill where userId, enabled=true）
  const userSkills = await prisma.userSkill.findMany({
    where: { userId, enabled: true },
    include: { skill: true }
  });
  
  // 3. 应用项目级 override（ProjectSkillOverride）
  const overrides = await prisma.projectSkillOverride.findMany({
    where: { projectId }
  });
  
  // 4. 合并去重，注入用户 config
  const allSkills = [...platformSkills, ...userSkills.map(us => us.skill)];
  const uniqueSkills = deduplicateByName(allSkills);
  
  // 5. 应用 override
  const finalSkills = uniqueSkills.filter(skill => {
    const override = overrides.find(o => o.skillName === skill.name);
    return override ? override.enabled : true;
  });
  
  // 6. 注入用户配置
  return finalSkills.map(skill => ({
    ...skill.manifest,
    config: userSkills.find(us => us.skillId === skill.id)?.config ?? {}
  }));
}
```
## 五、两类 Skill 的区别处理

|  | Prompt-only Skill | Tool-bearing Skill |
|---|---|---|
| **例子** | seo-optimizer, accessibility-checker | deploy-vercel, screenshot-page |
| **包含** | 只有 prompt 指导 | prompt + 自定义 tool 定义 + handler |
| **执行方式** | Agent 用平台内置 tools 完成 | Agent 调用 skill 专属 tool |
| **安全性** | 无风险（只是文字） | 需要审核 handler 代码 |
| **用户自定义** | 随便写，即时生效 | 需要在 sandbox 内执行 |

### Tool-bearing Skill 的安全执行

用户上传的 handler 代码在 E2B sandbox 内执行（你已有这个基础设施），不会影响主进程。

```typescript
// Skill handler 在 sandbox 内执行的机制
async function executeSkillTool(
  toolName: string,
  args: any,
  ctx: ExecutionContext
): Promise<ToolResult> {
  const skill = ctx.skills.find(s => s.tools?.some(t => t.name === toolName));
  if (!skill) throw new Error(`Tool ${toolName} not found`);
  
  const tool = skill.tools!.find(t => t.name === toolName)!;
  
  if (tool.executor === "sandbox") {
    // 在 E2B sandbox 内执行
    return await ctx.sandbox.runCode(tool.handler, args);
  } else {
    // 在服务器端执行（需要严格审核）
    return await executeServerHandler(tool.handler, args);
  }
}
```

## 六、实现路径建议

### Phase 1（最小可用）：只支持 Prompt-only Skill

- [ ] 新增 [src/lib/skill/](src/lib/skill/) 目录（resolver、loader）
- [ ] 改造 [loop.ts](src/lib/agent/loop.ts) 支持动态 prompt 注入
- [ ] 内置 2-3 个平台 Skill 验证流程
- [ ] 前端加一个简单的 Skill 开关面板

### Phase 2：支持 Tool-bearing Skill

- [ ] [tools.ts](src/lib/agent/tools.ts) 支持动态 tool 注册 + skill executor 分发
- [ ] Skill handler 在 sandbox 内执行的机制
- [ ] 前端 Skill 市场 + 上传功能

### Phase 3：生态

- [ ] 用户自定义 Skill 上传/分享
- [ ] Skill 版本管理、评分、审核
- [ ] Skill 间依赖声明

**核心优势**：大部分 Skill 只是一段 Markdown prompt，用户写起来零门槛，Agent 用起来零成本。只有需要真正新能力（如调用外部 API）的 Skill 才需要写 handler 代码。

---

## 七、Agent 自进化机制

### 核心思路

让 Agent 具备**反思 → 提炼 → 固化**的能力，把一次性的经验变成可复用的 Skill。

```
用户使用 Agent 完成任务
        │
        ▼
任务结束后，触发「反思」阶段
        │
        ▼
Agent 分析本次执行过程，提炼可复用模式
        │
        ▼
自动生成 Prompt-only Skill（草稿）
        │
        ▼
用户确认 / 自动生效（根据置信度）
```

这和人类程序员的行为一致：做完一件事后，把踩过的坑和最佳实践写成文档，下次遇到类似场景直接参考。

### 什么时候触发自进化？

不是每次任务都值得提炼。触发条件：

| 信号 | 说明 |
|---|---|
| 构建失败后修复成功 | Agent 踩了坑又解决了，这是经验 |
| 用户多次迭代同类需求 | 说明有模式可以固化 |
| ask_user 后用户的选择 | 用户偏好可以记住 |
| 同一用户重复出现的指令模式 | "每次都要响应式"、"每次都要暗色主题" |

### 实现方案：Post-Run Reflection

在 [orchestrator.ts](src/lib/agent/orchestrator.ts) 的任务完成后，新增一个轻量级的反思阶段：

```typescript
// orchestrator.ts — 任务成功完成后
if (result.success) {
  await maybeReflect({
    userId,
    projectId,
    runId,
    messages: result.finalMessages,  // 完整对话历史
    steps: result.steps,
  });
}
```

### 反思逻辑（src/lib/skill/evolve.ts）

```typescript
async function maybeReflect(ctx: ReflectContext) {
  // 1. 判断是否值得反思（简单启发式）
  if (!shouldReflect(ctx)) return;

  // 2. 用 LLM 做一次轻量分析
  const insight = await extractInsight(ctx.messages);
  
  // 3. 如果提炼出有价值的模式，生成 Skill 草稿
  if (insight.actionable) {
    await createDraftSkill(ctx.userId, insight);
  }
}
```

#### 判断是否值得反思

```typescript
function shouldReflect(ctx: ReflectContext): boolean {
  // 有构建失败后修复的经历
  const hadBuildFix = ctx.messages.some(m => 
    m.role === "tool" && m.content?.includes("exit_code: 1")
  ) && ctx.messages.some(m =>
    m.role === "tool" && m.content?.includes("exit_code: 0")
  );
  
  // 步骤数较多（说明任务复杂，可能有可提炼的流程）
  const complexTask = ctx.steps > 10;
  
  // 用户有过迭代修改
  const hadIteration = ctx.messages.filter(m => m.role === "user").length > 1;
  
  return hadBuildFix || complexTask || hadIteration;
}
```

#### 用 LLM 提炼经验

```typescript
async function extractInsight(messages: Message[]): Promise<Insight> {
  const response = await llm.chat({
    model: "deepseek-chat",  // 用便宜模型做反思
    messages: [
      { role: "system", content: REFLECT_PROMPT },
      { role: "user", content: JSON.stringify(summarizeRun(messages)) }
    ],
    response_format: { type: "json_object" }
  });
  
  return JSON.parse(response.content);
}
```

#### 反思 Prompt

```typescript
const REFLECT_PROMPT = `你是一个经验提炼专家。分析以下 Agent 执行记录，判断是否有可复用的经验。

输出 JSON：
{
  "actionable": boolean,        // 是否有值得固化的经验
  "type": "pattern" | "pitfall" | "preference",
  "title": "简短标题",
  "description": "一句话描述这个经验",
  "prompt": "如果要把这个经验变成给 Agent 的指导，应该怎么写（Markdown）",
  "trigger": "什么场景下应该激活这个经验（用于 skill description）",
  "confidence": 0.0-1.0         // 置信度
}

提炼原则：
- 只提炼可泛化的经验，不要记录一次性的具体实现
- pitfall：Agent 犯了错又修复了，下次可以直接避免
- pattern：一个好的工作流程，下次可以直接复用
- preference：用户表达了明确偏好，下次应该默认遵循
- 如果这次执行没有什么特别的，actionable 设为 false`;
```

### 生成的 Skill 长什么样？

#### 例子 1 — 从构建失败中学到的 pitfall

```markdown
---
name: auto-learned-tailwind-v4-import
description: 当项目使用 Tailwind CSS 时，避免在组件中直接 @import tailwind 指令
type: learned
confidence: 0.85
learned_from: run_abc123
---

## Tailwind CSS 导入规则

不要在组件文件中写 `@import "tailwindcss"`，这会导致构建失败。

正确做法：
- Tailwind 指令只在 `src/index.css` 中声明一次
- 组件中直接使用 class name，无需额外 import
- 如果需要自定义 theme 值，在 tailwind.config.js 中配置
```

#### 例子 2 — 从用户偏好中学到的 preference

```markdown
---
name: auto-learned-user-prefers-dark
description: 该用户偏好暗色主题设计，默认使用深色背景
type: learned
confidence: 0.72
learned_from: run_def456
---

## 设计偏好：暗色主题

该用户偏好暗色系设计。除非明确要求浅色主题，默认：
- 背景使用 slate-900 / gray-900
- 文字使用 gray-100 / white
- 强调色使用高饱和度色彩（如 blue-400, emerald-400）
- 卡片使用 gray-800 + subtle border
```

### 自进化 Skill 的生命周期

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Draft   │────▶│  Active  │────▶│ Verified │────▶│ Archived │
│  草稿    │     │  生效中   │     │  已验证   │     │  已过时   │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
     │                                                    ▲
     │  confidence > 0.8 → 自动生效                        │
     │  confidence < 0.8 → 需用户确认                      │
     │                                                    │
     └── 连续 3 次未被使用或被用户否决 ──────────────────────┘
```

### 数据模型扩展

```prisma
model Skill {
  // ... 之前的字段
  
  type        String    @default("manual")  // "manual" | "learned"
  confidence  Float?                        // 自进化 skill 的置信度
  learnedFrom String?                       // 来源 runId
  usageCount  Int       @default(0)         // 被实际使用的次数
  lastUsedAt  DateTime?
  status      String    @default("active")  // "draft" | "active" | "verified" | "archived"
}
```

### 防止退化：反馈闭环

自进化不能只有"学"，还要有"忘"和"修正"：

```typescript
// 每次 Skill 被注入后，追踪效果
async function trackSkillUsage(skillId: string, runResult: AgentLoopResult) {
  if (runResult.success) {
    // 任务成功，skill 可能有帮助
    await prisma.skill.update({
      where: { id: skillId },
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date() }
    });
  }
}

// 用户主动否决
async function userRejectsSkill(skillId: string) {
  await prisma.skill.update({
    where: { id: skillId },
    data: { status: "archived" }
  });
}

// 定期清理：长期未使用的 learned skill 自动降级
async function decayUnusedSkills(userId: string) {
  await prisma.skill.updateMany({
    where: {
      authorId: userId,
      type: "learned",
      lastUsedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, // 30天未用
      status: "active"
    },
    data: { status: "archived" }
  });
}
```

### 用户交互设计

前端需要一个「Agent 记忆」面板：

```
┌─────────────────────────────────────────────┐
│  🧠 Agent 学到的经验                         │
├─────────────────────────────────────────────┤
│                                             │
│  ● Tailwind v4 导入规则        置信度 85%   │
│    来源：项目"企业官网" 6月1日              │
│    [启用] [编辑] [删除]                     │
│                                             │
│  ○ 用户偏好暗色主题（草稿）    置信度 72%   │
│    来源：项目"个人博客" 5月28日             │
│    [确认启用] [忽略]                        │
│                                             │
│  ● 表单组件先写 validation     置信度 91%   │
│    来源：3次成功经验                        │
│    [启用] [编辑] [删除]                     │
│                                             │
└─────────────────────────────────────────────┘
```

### 整合到之前的 Skill 体系

自进化生成的 Skill 和手动安装的 Skill 共用同一套规范和注入机制，区别只在于来源：

```typescript
async function resolveSkills(userId: string, projectId: string) {
  const platformSkills = await getPlatformSkills();
  const installedSkills = await getUserInstalledSkills(userId);
  const learnedSkills = await getLearnedSkills(userId, { status: "active" });
  const overrides = await getProjectOverrides(projectId);
  
  // 统一合并，统一注入
  return applyOverrides([...platformSkills, ...installedSkills, ...learnedSkills], overrides);
}
```

对 Agent Loop 来说，不管 Skill 是人写的还是 Agent 自己学的，处理方式完全一样——都是一段注入到 system prompt 的 Markdown 文本。

### 成本控制

反思阶段会额外消耗 LLM 调用，需要控制：

- 用便宜模型做反思（DeepSeek Chat 而非 Claude）
- 只传摘要不传完整对话（summarizeRun 压缩到 2000 token 以内）
- 每个用户每天最多触发 5 次反思
- confidence < 0.5 的结果直接丢弃，不存储

---

## 八、总结

这个 Skill 系统设计的核心优势：

1. **低门槛**：大部分 Skill 只是 Markdown prompt，用户零门槛创建
2. **可扩展**：支持 Tool-bearing Skill，满足复杂场景
3. **自进化**：Agent 从经验中学习，越用越聪明
4. **安全隔离**：用户代码在 sandbox 执行，不影响主进程
5. **最小改造**：对现有代码改动最小，只做扩展不破坏

从 Phase 1 开始实施，逐步迭代到完整生态。