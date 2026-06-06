# Skill 系统进化方案

> 让 Skill 从静态全量注入变为 LLM 自主按需加载。
>
> 设计哲学：**不替 Agent 做决定，只给它足够的信息和一个搜索入口。**

## 一、现状分析与升级目标

### 当前架构

```
Skill 加载流程:
  agent-runtime 启动 → API 按 scope 过滤 → Redis 缓存 → 全量注入 LLM tools

Skill 执行流程:
  LLM tool_call → SkillManager.executeSkill → builtin/composite 分发
```

**瓶颈**：
1. 全量注入，无上下文感知 — token 浪费，激活精度低
2. 无效果追踪 — 不知道哪些 skill 真正贡献了价值
3. Skill 数量增长后 LLM 选择准确率下降（业界实测：超 30 个 tool 后显著退化）

### 设计原则

借鉴 Claude Code 的 Deferred Tool Loading 模式（业界验证最优雅的工程方案之一）：

- **LLM 自主决策**：不用规则引擎猜测 Agent 需要什么，Agent 自己判断
- **两层结构**：轻量目录（name + description）常驻 → 完整 schema 按需加载
- **零胶水代码**：不写事件总线、不写关键词匹配规则、不写条件分支逻辑
- **可扩展**：新增 skill 只需写好 description，无需配套规则

### 升级后目标架构

```
┌──────────────────────────────────────────────────────────────┐
│                   Skill Intelligence Layer                     │
│                                                              │
│  ┌────────────────┐  ┌──────────────────┐  ┌─────────────┐  │
│  │  Skill Index   │  │  Dual-Mode       │  │ Attribution │  │
│  │  & Search      │  │  Evolution       │  │ Tracker     │  │
│  └───────┬────────┘  └────────┬─────────┘  └──────┬──────┘  │
│          │                    │                    │          │
│  ────────┼────────────────────┼────────────────────┼───────   │
│          │                    │                    │          │
│  ┌───────▼────────────────────▼────────────────────▼───────┐ │
│  │           Skill Registry (Hybrid Disclosure)             │ │
│  │  ┌──────────┐    ┌───────────┐    ┌──────────────────┐  │ │
│  │  │ Resident │    │ Deferred  │    │  MCP Provider    │  │ │
│  │  │ Skills   │    │ Skills    │    │  Skills          │  │ │
│  │  └──────────┘    └───────────┘    └──────────────────┘  │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────┬────────────────────────────────────┘
                           │
              ┌────────────▼────────────────┐
              │      Agent Loop (改造)       │
              │  search_skills + 动态 tools  │
              └─────────────────────────────┘
```

---

## 二、混合披露协议（Hybrid Disclosure Protocol）

### 2.1 设计原理

核心问题：Skill 数量增长后，不可能全部以 tool schema 形式平铺给 LLM。

Claude Code 的解法：把工具发现**本身**变成一个工具调用。Agent 看到轻量目录就知道"我还有这些能力"，觉得需要时主动搜索加载。

两层分级：
- **常驻层（Resident）**：核心能力，完整 schema 始终注入（如 write_file, run_shell）
- **摘要层（Deferred）**：Agent 知道存在但不占 tool slot，需要时通过 `search_skills` 激活

### 2.2 分层注册

```typescript
enum DisclosureLevel {
  /** 完整 schema 始终注入 LLM tools 列表 */
  RESIDENT = "resident",
  /** 仅 name + description 注入 system prompt 的 skill catalogue 区 */
  DEFERRED = "deferred",
}

interface SkillRegistration {
  skill: SkillDefinition;
  level: DisclosureLevel;
  priority: number;  // 同层内的排序权重
}
```

### 2.3 披露流程

```
Agent Loop 启动
    │
    ├─ 1. 加载 RESIDENT skills → 直接注入 tools[]
    │     (平台内置 tools + search_skills 元工具)
    │
    └─ 2. 加载 DEFERRED skills → 注入 system prompt 的 catalogue 区
          格式: "以下能力当前未激活。需要时调用 search_skills 搜索并激活。"
          │
          └─ Agent 判断需要某个 deferred skill
              → 调用 search_skills(query)
              → 系统返回匹配 skills 的完整信息
              → 同时将其 tool schema 动态注入后续 turn
```

### 2.4 Catalogue 注入格式（System Prompt 片段）

```markdown
## 可用能力目录

以下能力当前未激活。需要时调用 search_skills 搜索并激活。

- seo-optimizer: 网站 SEO 分析与优化建议
- deploy-vercel: 部署到 Vercel 平台
- a11y-checker: WCAG 无障碍合规检查
- tailwind-patterns: Tailwind CSS 最佳实践与常见模式
- perf-audit: 页面性能分析与优化
- responsive-layout: 响应式布局方案生成
```

### 2.5 disclosureLevel 默认规则

| Skill 来源 | 默认 disclosureLevel |
|------------|---------------------|
| 平台内置工具（write_file 等） | resident |
| search_skills 元工具 | resident |
| 用户/项目自定义 skill | deferred |
| learned skill（进化系统产出，confidence ≥ 0.8） | deferred |
| learned skill（confidence < 0.8） | deferred（status=draft，目录中标记为草稿） |

---

## 三、search_skills 元工具

### 3.1 设计原理

这是整个方案的核心支点。借鉴 Claude Code 的 ToolSearch：
- Agent 用**自然语言**描述需求，或直接传 skill 名称
- 系统返回匹配的 skill 完整定义
- 匹配到的 skill 自动注入到**后续 turn** 的 tools 列表

Agent 已经在 system prompt 里看到了目录（name + description），它调 search_skills 时传的 query 通常就很精准。不需要复杂的语义搜索——V1 用简单匹配就够用。

### 3.2 Tool Schema

```typescript
const SEARCH_SKILLS_TOOL = {
  type: "function",
  function: {
    name: "search_skills",
    description:
      "搜索并激活可用能力。支持精确名称或关键词搜索。" +
      "激活后的能力将在下一步可用。" +
      "查看上方「可用能力目录」了解有哪些能力可搜索。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索词：skill 名称（如 'seo-optimizer'）或自然语言描述（如 '性能优化'）",
        },
        max_results: {
          type: "number",
          description: "最多返回几个结果，默认 3",
        },
      },
      required: ["query"],
    },
  },
};
```

### 3.3 搜索策略（渐进式）

```typescript
class SkillSearchEngine {
  private skills: SkillDefinition[];

  search(query: string, maxResults = 3): SkillDefinition[] {
    // 1. 精确名称匹配（最高优先）
    const exact = this.skills.find(s => s.name === query);
    if (exact) return [exact];

    // 2. 名称前缀/包含匹配
    const nameMatches = this.skills.filter(s =>
      s.name.includes(query.toLowerCase()) ||
      query.toLowerCase().includes(s.name)
    );
    if (nameMatches.length > 0) return nameMatches.slice(0, maxResults);

    // 3. description 关键词匹配（中文 + 英文）
    const queryTerms = this.tokenize(query);
    const scored = this.skills
      .map(skill => ({
        skill,
        score: this.relevanceScore(skill, queryTerms),
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, maxResults).map(item => item.skill);
  }

  private relevanceScore(skill: SkillDefinition, queryTerms: string[]): number {
    const text = `${skill.name} ${skill.displayName} ${skill.description} ${skill.category}`.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) score += 1;
    }
    return score;
  }

  private tokenize(query: string): string[] {
    // 简单分词：按空格/标点拆分，转小写
    return query.toLowerCase().split(/[\s,，。、]+/).filter(Boolean);
  }
}
```

**后续迭代路径**（不影响接口，内部替换即可）：
- V2：加 embedding 索引（sentence-transformer），支持语义搜索（"让页面快一点" → perf-audit）
- V3：用轻量 LLM 做意图路由（最高精度，成本略增）

### 3.4 执行逻辑

```typescript
async function executeSearchSkills(
  args: { query: string; max_results?: number },
  ctx: ToolContext & { skillManager: SkillManager }
): Promise<ToolResult> {
  const results = ctx.skillManager.searchSkills(args.query, args.max_results || 3);

  if (results.length === 0) {
    return {
      success: true,
      output: `未找到匹配「${args.query}」的能力。请检查能力目录中的名称。`,
    };
  }

  // 激活找到的 skills（注入到后续 turn）
  for (const skill of results) {
    ctx.skillManager.activateSkill(skill.name);
  }

  // 返回 skill 信息供 Agent 了解
  const summary = results.map(s =>
    `- ${s.name}: ${s.description}` +
    (s.schema && Object.keys(s.schema).length > 0
      ? `\n  参数: ${JSON.stringify(s.schema)}`
      : `\n  类型: prompt-only（无需额外参数，指导内容已注入）`)
  ).join("\n");

  return {
    success: true,
    output: `已激活 ${results.length} 个能力，下一步可用：\n${summary}`,
  };
}
```

---

## 四、Turn-Level 动态注入机制

### 4.1 核心约束

**激活的 skill 不是立即可用，而是从下一次 LLM 调用开始可用。**

原因：OpenAI API 的 tool schema 在请求发出时确定。tool_result 返回后新增 schema 对当前 turn 无意义。这与 Claude Code 的行为一致。

### 4.2 DynamicToolManager

```typescript
class DynamicToolManager {
  private activatedSkills = new Set<string>();
  private dynamicTools: OpenAI.ChatCompletionTool[] = [];
  private pendingPrompts: string[] = [];
  private allSkills: Map<string, SkillDefinition>;

  constructor(allSkills: Map<string, SkillDefinition>) {
    this.allSkills = allSkills;
  }

  /** Agent 调用 search_skills 后触发 */
  activateSkill(name: string): void {
    if (this.activatedSkills.has(name)) return;
    const skill = this.allSkills.get(name);
    if (!skill) return;

    this.activatedSkills.add(name);

    // tool 型 skill：注入 schema
    if (skill.schema && Object.keys(skill.schema).length > 0) {
      this.dynamicTools.push({
        type: "function",
        function: {
          name: skill.name,
          description: skill.description,
          parameters: skill.schema as Record<string, unknown>,
        },
      });
    }

    // prompt 型 skill：注入指导内容
    if (skill.prompt) {
      this.pendingPrompts.push(skill.prompt);
    }
  }

  /** 每次 LLM 调用前，组装最终 tools 和 messages */
  buildPayload(
    baseTools: OpenAI.ChatCompletionTool[],
    messages: OpenAI.ChatCompletionMessageParam[]
  ): { tools: OpenAI.ChatCompletionTool[]; messages: OpenAI.ChatCompletionMessageParam[] } {
    const tools = [...baseTools, ...this.dynamicTools];

    // 消费 pending prompts（注入一次即可，后续 turn 靠上下文记忆）
    if (this.pendingPrompts.length > 0) {
      const injection: OpenAI.ChatCompletionMessageParam = {
        role: "system",
        content: `[能力激活]\n\n${this.pendingPrompts.join("\n\n---\n\n")}`,
      };
      messages = [...messages, injection];
      this.pendingPrompts = [];
    }

    return { tools, messages };
  }

  /** 生成 catalogue 文本，注入初始 system prompt */
  buildCatalogue(deferredSkills: SkillDefinition[]): string {
    if (deferredSkills.length === 0) return "";

    const lines = deferredSkills.map(s => `- ${s.name}: ${s.description}`);
    return [
      "\n## 可用能力目录\n",
      "以下能力当前未激活。需要时调用 search_skills 搜索并激活。\n",
      ...lines,
    ].join("\n");
  }

  isActivated(name: string): boolean {
    return this.activatedSkills.has(name);
  }
}
```

### 4.3 对 loop.ts 的改造

```typescript
// ─── 初始化阶段 ─────────────────────────────────────────────────
const skills = await skillManager.loadSkills();
const residentSkills = skills.filter(s => s.disclosureLevel === "resident");
const deferredSkills = skills.filter(s => s.disclosureLevel === "deferred");

const toolManager = new DynamicToolManager(skillManager.getAllSkillsMap());
const catalogue = toolManager.buildCatalogue(deferredSkills);

// system prompt 追加 catalogue
const fullSystemPrompt = systemPrompt + catalogue;

// 基础 tools = 内置工具 + resident skills + search_skills
const baseTools = [
  ...AGENT_TOOLS,
  ...skillManager.toOpenAITools(residentSkills),
  SEARCH_SKILLS_TOOL,
];

// ─── 每轮 LLM 调用前 ────────────────────────────────────────────
const { tools, messages: finalMessages } = toolManager.buildPayload(baseTools, messages);

response = await chatCompletionWithTools(client, model, finalMessages, tools, opts);

// ─── tool_call 执行后 ────────────────────────────────────────────
if (fnName === "search_skills") {
  result = await executeSearchSkills(args, { ...toolCtx, skillManager });
} else if (toolManager.isActivated(fnName)) {
  result = await skillManager.executeSkill(fnName, args, toolCtx);
} else {
  result = await executeTool(fnName, args, toolCtx);
}
```

---

## 五、双模式自进化（Dual-Mode Evolution）

### 5.1 设计原理

自进化 = Agent 从执行经验中提炼可复用的 Skill。双模式：

- **手动模式**：用户执行 `/evolve` 或 `/reflect` 后，分析历史并生成 Skill
- **自动模式**：每次 run 成功后，系统自动判断是否值得提炼（默认开启，可关闭）

产出的 learned skill 自然进入 Hybrid Disclosure 体系：
- confidence ≥ 0.8 → `disclosureLevel: "deferred"`，出现在目录中，Agent 可搜索到
- confidence < 0.8 → `disclosureLevel: "deferred"` + `status: "draft"`，目录中标记为草稿

不再需要为 learned skill 编写激活规则——Agent 看到目录里的描述，觉得有用就会自己 search 并激活。

### 5.2 提炼管线（Evolution Pipeline）

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Signal  │────▶│  Filter  │────▶│ Extract  │────▶│ Validate │────▶│  Store   │
│  信号检测 │     │  噪声过滤 │     │  经验提炼 │     │  质量验证 │     │  持久化   │
└──────────┘     └──────────┘     └──────────┘     └──────────┘     └──────────┘
     │                                                                    │
     │  auto: run 完成后触发                                               │
     │  manual: 用户 /evolve 触发                                          ▼
     │                                                              ┌──────────┐
     └─ 信号源:                                                      │ Feedback │
        - 构建失败→修复                                               │ 反馈闭环  │
        - 多轮迭代模式                                                └──────────┘
        - 用户偏好表达
        - 复杂任务完成（steps > N）
```

### 5.3 信号检测（Signal Detection）

```typescript
interface EvolutionSignal {
  type: "pitfall" | "pattern" | "preference" | "workflow";
  strength: number;        // 0-1，信号强度
  source: SignalSource;
  rawData: unknown;
}

interface SignalSource {
  runId: string;
  userId: string;
  projectId: string;
  timestamp: number;
}

class SignalDetector {
  detect(runRecord: RunRecord): EvolutionSignal[] {
    const signals: EvolutionSignal[] = [];

    // 1. Pitfall：构建失败后成功修复
    if (this.hasBuildFixPattern(runRecord)) {
      signals.push({
        type: "pitfall",
        strength: 0.8,
        source: this.buildSource(runRecord),
        rawData: this.extractFixContext(runRecord),
      });
    }

    // 2. Workflow：任务复杂度高且成功完成
    if (runRecord.steps > 10 && runRecord.success) {
      signals.push({
        type: "workflow",
        strength: Math.min(runRecord.steps / 20, 1.0),
        source: this.buildSource(runRecord),
        rawData: this.extractWorkflowSteps(runRecord),
      });
    }

    // 3. Preference：用户通过 ask_user 表达的选择
    const userChoices = this.extractUserChoices(runRecord);
    if (userChoices.length > 0) {
      signals.push({
        type: "preference",
        strength: 0.6,
        source: this.buildSource(runRecord),
        rawData: userChoices,
      });
    }

    // 4. Pattern：重复出现的代码模式
    const codePatterns = this.detectCodePatterns(runRecord);
    if (codePatterns.length > 0) {
      signals.push({
        type: "pattern",
        strength: 0.5,
        source: this.buildSource(runRecord),
        rawData: codePatterns,
      });
    }

    return signals;
  }
}

interface RunRecord {
  runId: string;
  userId: string;
  projectId: string;
  success: boolean;
  steps: number;
  messages: Array<{ role: string; content: unknown }>;
  duration: number;
}
```

### 5.4 噪声过滤（Filter）

```typescript
class EvolutionFilter {
  private config: EvolutionConfig;

  filter(signals: EvolutionSignal[], userId: string): EvolutionSignal[] {
    return signals.filter(signal => {
      if (signal.strength < this.config.minSignalStrength) return false;
      if (this.exceedsDailyLimit(userId)) return false;
      if (this.hasSimilarExistingSkill(signal, userId)) return false;
      return true;
    });
  }
}

interface EvolutionConfig {
  enabled: boolean;
  autoMode: boolean;
  minSignalStrength: number; // 默认 0.5
  dailyLimit: number;        // 每用户每天上限，默认 5
  minConfidence: number;     // 最低置信度，低于此值丢弃
  autoActivateThreshold: number; // ≥ 此值自动加入目录，否则标记为 draft
}

const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: true,
  autoMode: true,
  minSignalStrength: 0.5,
  dailyLimit: 5,
  minConfidence: 0.5,
  autoActivateThreshold: 0.8,
};
```

### 5.5 经验提炼（Extract）

```typescript
class EvolutionExtractor {
  private llmClient: OpenAI;

  async extract(signal: EvolutionSignal): Promise<ExtractedInsight | null> {
    const prompt = this.buildExtractionPrompt(signal);

    const response = await this.llmClient.chat.completions.create({
      model: "deepseek-chat", // 用便宜模型做提炼
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    try {
      const insight = JSON.parse(content) as ExtractedInsight;
      return insight.actionable ? insight : null;
    } catch {
      return null;
    }
  }
}

const EXTRACTION_SYSTEM_PROMPT = `你是经验提炼专家。分析 Agent 的执行记录，提取可复用的经验。

输出 JSON 格式：
{
  "actionable": boolean,
  "type": "pitfall" | "pattern" | "preference" | "workflow",
  "name": "kebab-case 名称",
  "title": "简短中文标题",
  "description": "一句话描述（用于 skill catalogue，Agent 据此判断是否激活）",
  "prompt": "完整的 Markdown 指导文本（激活后注入 Agent context 的内容）",
  "confidence": 0.0-1.0,
  "reasoning": "为什么这个经验值得保留"
}

提炼原则：
- 只提炼可泛化的经验，排除一次性的项目特定实现
- description 要精准——这是 Agent 决定是否激活的唯一依据
- prompt 内容要具体可操作，不要泛泛的建议
- confidence 基于：泛化程度、重复出现次数、修复成功率`;

interface ExtractedInsight {
  actionable: boolean;
  type: "pitfall" | "pattern" | "preference" | "workflow";
  name: string;
  title: string;
  description: string;
  prompt: string;
  confidence: number;
  reasoning: string;
}
```

### 5.6 质量验证（Validate）

```typescript
class EvolutionValidator {
  validate(insight: ExtractedInsight): ValidationResult {
    const issues: string[] = [];

    if (!insight.name || !/^[a-z][a-z0-9-]*$/.test(insight.name)) {
      issues.push("name 必须是 kebab-case");
    }
    if (!insight.prompt || insight.prompt.length < 50) {
      issues.push("prompt 内容过短，缺乏可操作性");
    }
    if (!insight.prompt || insight.prompt.length > 2000) {
      issues.push("prompt 过长，应精简到核心要点");
    }
    if (this.containsUnsafeContent(insight.prompt)) {
      issues.push("prompt 包含潜在不安全内容");
    }

    return {
      valid: issues.length === 0,
      issues,
      adjustedConfidence: issues.length > 0 ? insight.confidence * 0.5 : insight.confidence,
    };
  }

  private containsUnsafeContent(prompt: string): boolean {
    const unsafePatterns = [/rm\s+-rf/, /process\.env\.\w+/, /eval\(/, /exec\(/];
    return unsafePatterns.some(p => p.test(prompt));
  }
}
```

### 5.7 持久化（Store）

```typescript
class EvolutionStore {
  async store(
    insight: ExtractedInsight,
    signal: EvolutionSignal,
    config: EvolutionConfig
  ): Promise<StoredSkill> {
    const autoActivate = insight.confidence >= config.autoActivateThreshold;

    const skill = await prisma.skill.create({
      data: {
        name: `learned-${insight.name}`,
        displayName: insight.title,
        description: insight.description,
        category: "learned",
        type: "builtin",
        scope: "user",
        userId: signal.source.userId,
        schema: {},
        implementation: null,
        prompt: insight.prompt,
        // ─── 融入 Hybrid Disclosure ───
        disclosureLevel: "deferred",  // 所有 learned skill 都是 deferred
        status: autoActivate ? "active" : "draft",
        // ─── 进化相关字段 ───
        evolutionType: insight.type,
        confidence: insight.confidence,
        learnedFromRunId: signal.source.runId,
      },
    });

    // 无需注册激活规则——Agent 通过 search_skills 自主发现和激活
    return skill;
  }
}
```

### 5.8 Skill 生命周期状态机

```
┌──────────┐  confidence ≥ 0.8  ┌──────────┐  3次正向使用  ┌──────────┐
│  Draft   │───────────────────▶│  Active  │──────────────▶│ Verified │
│  草稿    │                    │  生效中   │               │  已验证   │
└──────────┘                    └──────────┘               └──────────┘
     │                               │                          │
     │ 用户确认                       │ 连续3次无用               │
     └───────────────────────────────▶│                          │
                                     ▼                          │
                                ┌──────────┐                    │
                                │ Archived │◀───────────────────┘
                                │  已归档   │  30天未被搜索激活
                                └──────────┘
                                     │
                                     │ 用户手动恢复
                                     ▼
                                   Active

状态转换规则:
- draft → active:   confidence ≥ 0.8 自动，或用户手动确认
- active → verified: 被 search_skills 激活 3 次且所在 run 成功率 ≥ 66%
- active → archived: 连续 3 次激活但 run 失败，或用户否决
- verified → archived: 30 天未被 search_skills 激活
- archived → active: 用户手动恢复
```

目录展示规则：
- `status: "active"` 或 `"verified"` → 正常出现在 catalogue 中
- `status: "draft"` → 出现在 catalogue 中但标注 `[草稿]`
- `status: "archived"` → 不出现在 catalogue 中

### 5.9 手动触发命令

```typescript
interface EvolveCommand {
  /** /evolve — 分析最近 N 次 run，提炼经验 */
  type: "evolve";
  params: {
    scope: "last_run" | "recent_5" | "all_project";
    force?: boolean;
  };
}

interface ReflectCommand {
  /** /reflect — 让 Agent 自述学到了什么 */
  type: "reflect";
  params: { runId?: string };
}

interface ForgetCommand {
  /** /forget <skill-name> — 归档一个 learned skill */
  type: "forget";
  params: { skillName: string };
}

// API 端点
// POST /api/skills/evolve   → 触发进化管线
// POST /api/skills/reflect  → 返回分析结果（不持久化）
// DELETE /api/skills/learned/:name → 归档 learned skill
```

---

## 六、归因追踪系统（Skill Attribution）

### 6.1 设计原理

没有归因，自进化就是盲人摸象。需要回答：
- 哪些 skill 被激活后**真正影响了** Agent 行为？
- 哪些 skill 只是占了 token 但没起作用？
- 一个 skill 对任务成功率的**贡献度**是多少？

在新架构下，归因更简单——所有 deferred skill 的激活都经过 `search_skills`，有明确的激活记录。

### 6.2 归因数据模型

```typescript
interface SkillAttribution {
  id: string;
  runId: string;
  skillName: string;

  // ─── 激活信息 ───
  activatedAtStep: number;
  activationSource: "resident" | "search_by_agent";

  // ─── 使用信息 ───
  toolsCalled: number;  // 该 skill 的 tool 被调用了几次（tool 型）

  // ─── 效果信息 ───
  runSuccess: boolean;
  stepsAfterActivation: number;
  contributionScore: number;  // 0-1
}
```

### 6.3 追踪器

```typescript
class AttributionTracker {
  private attributions = new Map<string, SkillAttribution>();
  private currentStep = 0;

  recordActivation(skillName: string, source: SkillAttribution["activationSource"]): void {
    if (this.attributions.has(skillName)) return;
    this.attributions.set(skillName, {
      id: generateId(),
      runId: this.runId,
      skillName,
      activatedAtStep: this.currentStep,
      activationSource: source,
      toolsCalled: 0,
      runSuccess: false,
      stepsAfterActivation: 0,
      contributionScore: 0,
    });
  }

  onStepComplete(step: number, toolCallName?: string): void {
    this.currentStep = step;
    for (const attr of this.attributions.values()) {
      attr.stepsAfterActivation = step - attr.activatedAtStep;
      if (toolCallName && this.isSkillTool(attr.skillName, toolCallName)) {
        attr.toolsCalled++;
      }
    }
  }

  async finalize(runSuccess: boolean): Promise<SkillAttribution[]> {
    for (const attr of this.attributions.values()) {
      attr.runSuccess = runSuccess;
      attr.contributionScore = this.calculateScore(attr);
    }

    const results = Array.from(this.attributions.values());
    await this.persist(results);
    await this.updateSkillStats(results);
    return results;
  }

  private calculateScore(attr: SkillAttribution): number {
    let score = 0;

    // run 成功 +0.4
    if (attr.runSuccess) score += 0.4;

    // tool 被调用 +0.3（封顶）
    score += Math.min(attr.toolsCalled * 0.1, 0.3);

    // 主动搜索激活（Agent 认为需要）+0.2
    if (attr.activationSource === "search_by_agent") score += 0.2;

    // 惩罚：激活后 run 立刻失败
    if (!attr.runSuccess && attr.stepsAfterActivation <= 2) score -= 0.2;

    return Math.max(0, Math.min(1, score));
  }

  private async updateSkillStats(attributions: SkillAttribution[]): Promise<void> {
    for (const attr of attributions) {
      await prisma.skill.update({
        where: { name: attr.skillName },
        data: {
          usageCount: { increment: 1 },
          lastUsedAt: new Date(),
          avgContribution: {
            set: await this.rollingAverage(attr.skillName, attr.contributionScore),
          },
        },
      });
    }
  }
}
```

### 6.4 归因驱动的自动升降级

```typescript
class SkillReputationManager {
  async adjustReputation(): Promise<void> {
    const skills = await prisma.skill.findMany({
      where: { status: "active", category: "learned" },
    });

    for (const skill of skills) {
      const avgScore = skill.avgContribution;
      const usageCount = skill.usageCount;

      // 高贡献 + 高使用 → 升级为 verified
      if (avgScore > 0.7 && usageCount > 5) {
        await prisma.skill.update({
          where: { id: skill.id },
          data: { status: "verified" },
        });
      }

      // 低贡献 + 多次使用 → 归档
      if (avgScore < 0.2 && usageCount > 3) {
        await prisma.skill.update({
          where: { id: skill.id },
          data: { status: "archived" },
        });
      }

      // 从未被搜索激活（30 天内 usageCount = 0）→ 归档
      if (usageCount === 0 && this.daysSinceCreation(skill) > 30) {
        await prisma.skill.update({
          where: { id: skill.id },
          data: { status: "archived", archivedReason: "never_used" },
        });
      }
    }
  }
}
```