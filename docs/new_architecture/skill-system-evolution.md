# Skill 系统进化方案

> 让 Skill 从静态列表变为动态智能网络。

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
2. 单用户维度学习 — 平台无法从群体行为中受益
3. 线性执行 — skill 之间无法组合、无条件分支
4. 无效果追踪 — 不知道哪些 skill 真正贡献了价值
5. MCP 空壳 — 外部能力扩展通道未打通

### 升级后目标架构

```
┌────────────────────────────────────────────────────────────────────┐
│                        Skill Intelligence Layer                     │
│                                                                    │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌─────────────┐  │
│  │ Reactive │  │   Skill      │  │ Federated │  │ Attribution │  │
│  │ Activator│  │   Graph      │  │ Evolution │  │ Tracker     │  │
│  └────┬─────┘  └──────┬───────┘  └─────┬─────┘  └──────┬──────┘  │
│       │               │                │               │          │
│  ─────┼───────────────┼────────────────┼───────────────┼──────    │
│       │               │                │               │          │
│  ┌────▼───────────────▼────────────────▼───────────────▼──────┐  │
│  │              Skill Registry (Hybrid Disclosure)             │  │
│  │  ┌─────────┐    ┌──────────────┐    ┌──────────────────┐  │  │
│  │  │ Resident│    │  Deferred    │    │  MCP Provider    │  │  │
│  │  │ Skills  │    │  Skills      │    │  Skills          │  │  │
│  │  └─────────┘    └──────────────┘    └──────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                    ┌────────────▼────────────────┐
                    │      Agent Loop (改造)       │
                    │  动态 prompt + 动态 tools    │
                    └─────────────────────────────┘
```

---

## 二、混合披露协议（Hybrid Disclosure Protocol）

### 2.1 设计原理

核心问题：Skill 数量增长后，不可能全部以 tool schema 形式平铺给 LLM。需要分级管理：

- **常驻层**：核心能力，始终可用（如 write_file, run_shell）
- **摘要层**：Agent 知道存在但不占 tool slot，需要时按需激活
- **暗层**：Agent 不知道，由系统根据事件自动注入

### 2.2 三层注册架构

```typescript
enum DisclosureLevel {
  /** 常驻：完整 schema 始终注入 LLM tools 列表 */
  RESIDENT = "resident",
  /** 摘要：仅 name + description 注入 system prompt 的 skill catalogue 区 */
  DEFERRED = "deferred",
  /** 暗层：不对 LLM 披露，由 Reactive Activator 在特定事件触发时注入 */
  HIDDEN = "hidden",
}

interface SkillRegistration {
  skill: SkillDefinition;
  level: DisclosureLevel;
  activationRules?: ActivationRule[];  // hidden/deferred 的激活条件
  priority: number;                     // 同层内的排序权重
}
```

### 2.3 披露流程

```
Agent Loop 启动
    │
    ├─ 1. 加载 RESIDENT skills → 直接注入 tools[]
    │     (平台内置 tools + 用户标记为常驻的高频 skill)
    │
    ├─ 2. 加载 DEFERRED skills → 注入 system prompt 的 catalogue 区
    │     格式: "你还可以使用以下能力，需要时调用 activate_skill(name) 激活"
    │     │
    │     └─ Agent 判断需要某个 deferred skill
    │         → 调用 meta-tool: activate_skill(name)
    │         → 系统动态注入该 skill 的完整 schema 到后续 turn
    │
    └─ 3. HIDDEN skills → 不披露给 Agent
          由 Reactive Activator 监听事件
          条件满足时自动注入到下一 turn 的 context
```

### 2.4 activate_skill Meta-Tool

```typescript
// 新增一个 meta-tool，让 Agent 可以主动拉取 deferred skill
const ACTIVATE_SKILL_TOOL = {
  type: "function",
  function: {
    name: "activate_skill",
    description: "激活一个延迟加载的 Skill。调用后该 Skill 的完整能力将在下一步可用。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill 名称（来自能力目录）" },
        reason: { type: "string", description: "为什么需要这个 Skill" },
      },
      required: ["name"],
    },
  },
};
```

### 2.5 Catalogue 注入格式（System Prompt 片段）

```markdown
## 可用能力目录

以下能力当前未激活。如果判断需要使用，调用 activate_skill(name) 激活。

| 名称 | 描述 | 类型 |
|------|------|------|
| seo-optimizer | 网站 SEO 分析与优化建议 | prompt |
| deploy-vercel | 部署到 Vercel 平台 | tool |
| a11y-checker | WCAG 无障碍合规检查 | tool |
| perf-audit | 页面性能分析与优化 | prompt |
```

### 2.6 动态注入机制（Turn-Level Injection）

```typescript
interface TurnContext {
  turnNumber: number;
  activatedSkills: Set<string>;      // 本次 run 已激活的 skill
  injectedPrompts: string[];          // 已注入的 prompt 片段
  dynamicTools: OpenAI.ChatCompletionTool[];  // 动态追加的 tools
}

class DynamicInjector {
  private turnCtx: TurnContext;

  /**
   * 在每次 LLM 调用前，组装最终的 tools 和 messages
   */
  buildLLMPayload(
    baseTools: OpenAI.ChatCompletionTool[],
    messages: OpenAI.ChatCompletionMessageParam[]
  ): { tools: OpenAI.ChatCompletionTool[]; messages: OpenAI.ChatCompletionMessageParam[] } {
    const tools = [...baseTools, ...this.turnCtx.dynamicTools];

    // 如果本 turn 有新注入的 prompt，追加为 system message
    if (this.turnCtx.injectedPrompts.length > 0) {
      const injection: OpenAI.ChatCompletionMessageParam = {
        role: "system",
        content: `[能力激活]\n\n${this.turnCtx.injectedPrompts.join("\n\n---\n\n")}`,
      };
      messages = [...messages, injection];
      this.turnCtx.injectedPrompts = []; // 消费后清空
    }

    return { tools, messages };
  }

  /**
   * 激活一个 deferred/hidden skill
   */
  activate(skill: SkillDefinition): void {
    if (this.turnCtx.activatedSkills.has(skill.name)) return;
    this.turnCtx.activatedSkills.add(skill.name);

    // 注入 prompt 型内容
    if (skill.prompt) {
      this.turnCtx.injectedPrompts.push(skill.prompt);
    }
    // 注入 tool 型能力
    if (skill.tools) {
      for (const t of skill.tools) {
        this.turnCtx.dynamicTools.push({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        });
      }
    }
  }
}
```

---

## 三、反应式激活引擎（Reactive Activator）

### 3.1 设计原理

与其让 LLM 从长列表中猜测该用哪个 skill，不如让系统根据**运行时信号**主动推送。

核心概念：**事件 → 规则匹配 → Skill 注入**，类似 CEP（复杂事件处理）。

### 3.2 事件源

```typescript
/** 系统可观测的事件类型 */
enum ActivationEvent {
  // ─── 构建事件 ───────────────────────
  BUILD_FAILED = "build_failed",
  BUILD_SUCCEEDED = "build_succeeded",
  TYPE_ERROR = "type_error",

  // ─── 用户意图事件 ──────────────────
  USER_MESSAGE_RECEIVED = "user_message_received",
  USER_MENTIONS_KEYWORD = "user_mentions_keyword",
  USER_ITERATION_COUNT = "user_iteration_count",

  // ─── Agent 行为事件 ────────────────
  TOOL_CALL_FAILED = "tool_call_failed",
  STEP_COUNT_EXCEEDED = "step_count_exceeded",
  SAME_FILE_EDITED_MULTIPLE_TIMES = "same_file_edited_multiple_times",

  // ─── 代码内容事件 ──────────────────
  CODE_PATTERN_DETECTED = "code_pattern_detected",
  DEPENDENCY_ADDED = "dependency_added",
  FILE_TYPE_CREATED = "file_type_created",
}
```

### 3.3 激活规则定义

```typescript
interface ActivationRule {
  id: string;
  event: ActivationEvent;
  condition: ActivationCondition;
  action: ActivationAction;
  cooldown?: number;  // 同一 run 内的冷却时间（秒），防止反复触发
  priority: number;   // 同时匹配多条规则时的优先级
}

type ActivationCondition =
  | { type: "keyword_match"; keywords: string[]; field: "user_message" | "error_output" }
  | { type: "count_threshold"; metric: string; threshold: number }
  | { type: "pattern_match"; regex: string; field: string }
  | { type: "always" }  // 事件触发即激活
  | { type: "compound"; operator: "and" | "or"; conditions: ActivationCondition[] };

type ActivationAction =
  | { type: "inject_skill"; skillName: string }
  | { type: "inject_prompt"; content: string }
  | { type: "inject_skill_group"; category: string }
  | { type: "notify_agent"; message: string };  // 不注入 skill，只给 Agent 一个提示
```

### 3.4 内置规则示例

```typescript
const BUILTIN_RULES: ActivationRule[] = [
  {
    id: "build-fail-auto-fix",
    event: ActivationEvent.BUILD_FAILED,
    condition: { type: "always" },
    action: { type: "inject_skill", skillName: "build-error-diagnosis" },
    cooldown: 60,
    priority: 100,
  },
  {
    id: "tailwind-pattern",
    event: ActivationEvent.CODE_PATTERN_DETECTED,
    condition: {
      type: "pattern_match",
      regex: "tailwind|@apply|className=",
      field: "file_content",
    },
    action: { type: "inject_skill", skillName: "tailwind-patterns" },
    cooldown: 300,
    priority: 50,
  },
  {
    id: "user-mentions-seo",
    event: ActivationEvent.USER_MENTIONS_KEYWORD,
    condition: {
      type: "keyword_match",
      keywords: ["SEO", "搜索引擎", "meta", "og:"],
      field: "user_message",
    },
    action: { type: "inject_skill", skillName: "seo-optimizer" },
    cooldown: 0,
    priority: 80,
  },
  {
    id: "excessive-iteration",
    event: ActivationEvent.SAME_FILE_EDITED_MULTIPLE_TIMES,
    condition: { type: "count_threshold", metric: "same_file_edits", threshold: 3 },
    action: {
      type: "notify_agent",
      message: "你已经修改同一文件 3 次了。考虑退一步重新审视方案，或用 ask_user 确认方向。",
    },
    cooldown: 120,
    priority: 90,
  },
];
```

### 3.5 事件总线架构

```typescript
class ReactiveActivator {
  private rules: ActivationRule[] = [];
  private cooldowns = new Map<string, number>();  // ruleId → lastFiredAt
  private injector: DynamicInjector;

  constructor(injector: DynamicInjector, rules: ActivationRule[]) {
    this.injector = injector;
    this.rules = rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Agent Loop 内各处调用此方法发射事件
   */
  async emit(event: ActivationEvent, payload: Record<string, unknown>): Promise<void> {
    for (const rule of this.rules) {
      if (rule.event !== event) continue;
      if (this.isOnCooldown(rule)) continue;
      if (!this.evaluateCondition(rule.condition, payload)) continue;

      this.executeAction(rule.action);
      this.setCooldown(rule);
    }
  }

  private evaluateCondition(cond: ActivationCondition, payload: Record<string, unknown>): boolean {
    switch (cond.type) {
      case "always":
        return true;
      case "keyword_match":
        const text = String(payload[cond.field] || "").toLowerCase();
        return cond.keywords.some(k => text.includes(k.toLowerCase()));
      case "count_threshold":
        return (payload[cond.metric] as number) >= cond.threshold;
      case "pattern_match":
        return new RegExp(cond.regex, "i").test(String(payload[cond.field] || ""));
      case "compound":
        const fn = cond.operator === "and" ? "every" : "some";
        return cond.conditions[fn](c => this.evaluateCondition(c, payload));
    }
  }

  private executeAction(action: ActivationAction): void {
    switch (action.type) {
      case "inject_skill":
        const skill = this.injector.getSkillByName(action.skillName);
        if (skill) this.injector.activate(skill);
        break;
      case "inject_prompt":
        this.injector.injectPrompt(action.content);
        break;
      case "inject_skill_group":
        this.injector.activateCategory(action.category);
        break;
      case "notify_agent":
        this.injector.injectPrompt(`[系统提示] ${action.message}`);
        break;
    }
  }

  private isOnCooldown(rule: ActivationRule): boolean {
    if (!rule.cooldown) return false;
    const last = this.cooldowns.get(rule.id);
    if (!last) return false;
    return (Date.now() - last) / 1000 < rule.cooldown;
  }

  private setCooldown(rule: ActivationRule): void {
    this.cooldowns.set(rule.id, Date.now());
  }
}
```

### 3.6 事件埋点位置（对现有 loop.ts 的改造）

```typescript
// loop.ts 中的关键埋点

// 1. 用户消息到达时
activator.emit(ActivationEvent.USER_MESSAGE_RECEIVED, { user_message: userMessage });

// 2. Tool 执行后
if (!result.success && fnName === "run_shell") {
  if (result.output.includes("build")) {
    activator.emit(ActivationEvent.BUILD_FAILED, { error_output: result.output });
  }
  activator.emit(ActivationEvent.TOOL_CALL_FAILED, { tool: fnName, error: result.output });
}

// 3. 文件写入时追踪编辑次数
if (fnName === "write_file") {
  const path = args.path;
  fileEditCounts[path] = (fileEditCounts[path] || 0) + 1;
  if (fileEditCounts[path] >= 3) {
    activator.emit(ActivationEvent.SAME_FILE_EDITED_MULTIPLE_TIMES, {
      file: path,
      same_file_edits: fileEditCounts[path],
    });
  }
  // 内容模式检测
  activator.emit(ActivationEvent.CODE_PATTERN_DETECTED, { file_content: args.content });
}

// 4. 步数过多
if (step > config.maxSteps * 0.7) {
  activator.emit(ActivationEvent.STEP_COUNT_EXCEEDED, { step, maxSteps: config.maxSteps });
}
```

---

## 四、Skill 图（Skill Graph）

### 4.1 设计原理

Skill 不是孤立的列表项，而是有关系的能力节点。关系类型：

```
requires   — 激活 A 时必须同时激活 B（依赖）
enhances   — A 激活后 B 的效果更好（增强，但非必须）
conflicts  — A 和 B 不能同时激活（互斥）
composes   — A 是由 B+C+D 组合而成的高阶 skill（组合）
supersedes — A 的新版本完全替代 B（升级）
```

### 4.2 图结构定义

```typescript
interface SkillNode {
  name: string;
  skill: SkillDefinition;
  edges: SkillEdge[];
}

interface SkillEdge {
  type: "requires" | "enhances" | "conflicts" | "composes" | "supersedes";
  target: string;  // 目标 skill name
  metadata?: {
    reason?: string;       // 为什么有这个关系
    bidirectional?: boolean; // conflicts 通常是双向的
  };
}

// 在 Skill manifest 中声明关系
interface SkillManifestV2 extends SkillDefinition {
  relations?: {
    requires?: string[];
    enhances?: string[];
    conflicts?: string[];
    composes?: string[];
    supersedes?: string[];
  };
}
```

### 4.3 图解析器

```typescript
class SkillGraph {
  private nodes = new Map<string, SkillNode>();

  build(skills: SkillManifestV2[]): void {
    // 1. 注册所有节点
    for (const skill of skills) {
      this.nodes.set(skill.name, { name: skill.name, skill, edges: [] });
    }
    // 2. 建立边
    for (const skill of skills) {
      if (!skill.relations) continue;
      const node = this.nodes.get(skill.name)!;
      for (const [type, targets] of Object.entries(skill.relations)) {
        for (const target of targets as string[]) {
          node.edges.push({ type: type as SkillEdge["type"], target });
        }
      }
    }
  }

  /**
   * 解析激活一个 skill 时需要连带激活的完整集合
   */
  resolve(skillName: string, alreadyActive: Set<string>): ResolveResult {
    const toActivate = new Set<string>();
    const conflicts = new Set<string>();
    const queue = [skillName];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (toActivate.has(current)) continue;

      const node = this.nodes.get(current);
      if (!node) continue;

      toActivate.add(current);

      for (const edge of node.edges) {
        switch (edge.type) {
          case "requires":
            if (!alreadyActive.has(edge.target)) {
              queue.push(edge.target);  // 递归拉入依赖
            }
            break;
          case "conflicts":
            conflicts.add(edge.target);
            break;
          case "enhances":
            // 增强型：如果目标已经 loaded 则跳过，否则建议激活
            if (!alreadyActive.has(edge.target)) {
              toActivate.add(edge.target);
            }
            break;
        }
      }
    }

    // 冲突检测
    const activeConflicts = [...conflicts].filter(c => alreadyActive.has(c));

    return { toActivate: [...toActivate], conflicts: activeConflicts };
  }

  /**
   * 检测循环依赖
   */
  detectCycles(): string[][] {
    // Tarjan's algorithm 或 DFS-based cycle detection
    // 在 skill 注册时调用，有环则拒绝注册
    // ... 实现省略
    return [];
  }
}

interface ResolveResult {
  toActivate: string[];
  conflicts: string[];  // 与已激活 skill 存在冲突的列表
}
```

### 4.4 冲突处理策略

```typescript
enum ConflictStrategy {
  /** 新 skill 优先，取消旧 skill */
  NEWER_WINS = "newer_wins",
  /** 保持现状，拒绝新 skill */
  EXISTING_WINS = "existing_wins",
  /** 让 Agent 自己选 */
  ASK_AGENT = "ask_agent",
  /** 让用户选 */
  ASK_USER = "ask_user",
}

// 在项目/用户配置中设置冲突策略
interface SkillConfig {
  conflictStrategy: ConflictStrategy;
}
```

### 4.5 组合 Skill 示例

```yaml
name: full-landing-page
description: 完整落地页构建流程（响应式 + 动效 + SEO + 性能优化）
type: composite_graph
relations:
  composes:
    - responsive-layout
    - animation-polish
    - seo-optimizer
    - perf-audit
  conflicts:
    - minimal-design  # 完整落地页与极简设计理念冲突

execution:
  mode: parallel_where_possible
  steps:
    - phase: structure
      skills: [responsive-layout]
    - phase: content
      skills: [seo-optimizer]  # 结构完成后再优化 SEO
    - phase: polish
      skills: [animation-polish, perf-audit]  # 这两个可以并行
```

---

## 五、双模式自进化（Dual-Mode Evolution）

### 5.1 设计原理

自进化 = Agent 从执行经验中提炼可复用的 Skill。双模式：

- **手动模式**：用户执行命令（如 `/evolve` 或 `/reflect`）后 Agent 分析历史并生成 Skill
- **自动模式**：每次 run 成功后，系统自动判断是否值得提炼（默认开启，可关闭）

两种模式共用同一套提炼管线，只是触发条件不同。

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
  rawData: unknown;        // 原始数据，传递给 Extract 阶段
}

interface SignalSource {
  runId: string;
  userId: string;
  projectId: string;
  timestamp: number;
}

class SignalDetector {
  /**
   * 分析一次 run 的执行记录，提取进化信号
   */
  detect(runRecord: RunRecord): EvolutionSignal[] {
    const signals: EvolutionSignal[] = [];

    // 1. Pitfall 信号：构建失败后成功修复
    if (this.hasBuildFixPattern(runRecord)) {
      signals.push({
        type: "pitfall",
        strength: 0.8,
        source: this.buildSource(runRecord),
        rawData: this.extractFixContext(runRecord),
      });
    }

    // 2. Pattern 信号：任务复杂度高且成功
    if (runRecord.steps > 10 && runRecord.success) {
      signals.push({
        type: "workflow",
        strength: Math.min(runRecord.steps / 20, 1.0),
        source: this.buildSource(runRecord),
        rawData: this.extractWorkflowSteps(runRecord),
      });
    }

    // 3. Preference 信号：用户通过 ask_user 表达的选择
    const userChoices = this.extractUserChoices(runRecord);
    if (userChoices.length > 0) {
      signals.push({
        type: "preference",
        strength: 0.6,
        source: this.buildSource(runRecord),
        rawData: userChoices,
      });
    }

    // 4. Pattern 信号：重复出现的代码模式
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

  private hasBuildFixPattern(record: RunRecord): boolean {
    const messages = record.messages;
    let hadFailure = false;
    let hadSuccess = false;

    for (const msg of messages) {
      if (msg.role !== "tool") continue;
      const content = msg.content as string;
      if (content.includes("exit_code: 1") && content.includes("build")) hadFailure = true;
      if (hadFailure && content.includes("exit_code: 0") && content.includes("build")) hadSuccess = true;
    }

    return hadFailure && hadSuccess;
  }

  private extractFixContext(record: RunRecord): BuildFixContext {
    // 提取失败信息 + 修复操作 + 最终成功的上下文
    // 用于后续 LLM 提炼具体经验
    return {
      errorMessages: this.findErrorMessages(record),
      fixActions: this.findFixActions(record),
      filesModified: this.findModifiedFiles(record),
    };
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

interface BuildFixContext {
  errorMessages: string[];
  fixActions: string[];
  filesModified: string[];
}
```

### 5.4 噪声过滤（Filter）

```typescript
class EvolutionFilter {
  private config: EvolutionConfig;

  /**
   * 过滤掉不值得提炼的信号
   */
  filter(signals: EvolutionSignal[], userId: string): EvolutionSignal[] {
    return signals.filter(signal => {
      // 1. 强度门槛
      if (signal.strength < this.config.minSignalStrength) return false;

      // 2. 频率限制：每用户每天最多 N 次进化
      if (this.exceedsDailyLimit(userId)) return false;

      // 3. 去重：检查是否已有相似的 learned skill
      if (this.hasSimilarExistingSkill(signal, userId)) return false;

      return true;
    });
  }

  private exceedsDailyLimit(userId: string): boolean {
    // Redis counter: evolve_count:{userId}:{date}
    // 默认每天 5 次
    return false; // 实际实现查 Redis
  }

  private hasSimilarExistingSkill(signal: EvolutionSignal, userId: string): boolean {
    // 简单文本相似度匹配，避免重复学习同一个经验
    return false; // 实际实现查数据库
  }
}

interface EvolutionConfig {
  enabled: boolean;
  autoMode: boolean;         // 是否开启自动模式
  minSignalStrength: number; // 信号强度门槛，默认 0.5
  dailyLimit: number;        // 每用户每天上限，默认 5
  minConfidence: number;     // 最低置信度门槛，低于此值丢弃结果
  autoActivateThreshold: number; // 高于此置信度自动生效，否则需用户确认
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

  /**
   * 用 LLM 从信号中提炼结构化经验
   */
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

  private buildExtractionPrompt(signal: EvolutionSignal): string {
    switch (signal.type) {
      case "pitfall":
        return `分析以下构建失败→修复的过程，提炼可避免的坑：\n${JSON.stringify(signal.rawData, null, 2)}`;
      case "workflow":
        return `分析以下复杂任务的执行流程，提炼可复用的工作模式：\n${JSON.stringify(signal.rawData, null, 2)}`;
      case "preference":
        return `分析用户的选择，提炼偏好：\n${JSON.stringify(signal.rawData, null, 2)}`;
      case "pattern":
        return `分析重复出现的代码模式，提炼最佳实践：\n${JSON.stringify(signal.rawData, null, 2)}`;
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
  "description": "一句话描述（用于 skill 的 description 字段，Agent 据此判断是否激活）",
  "prompt": "完整的 Markdown 指导文本（注入到 Agent system prompt 的内容）",
  "triggerKeywords": ["关键词列表，用于反应式激活匹配"],
  "confidence": 0.0-1.0,
  "reasoning": "为什么这个经验值得保留（内部字段，不展示给用户）"
}

提炼原则：
- 只提炼可泛化的经验，排除一次性的项目特定实现
- prompt 内容要具体可操作，不要泛泛的建议
- confidence 基于：泛化程度(高=好)、重复出现次数、修复成功率
- 一个经验只产出一个 skill，不要混合多个主题`;

interface ExtractedInsight {
  actionable: boolean;
  type: "pitfall" | "pattern" | "preference" | "workflow";
  name: string;
  title: string;
  description: string;
  prompt: string;
  triggerKeywords: string[];
  confidence: number;
  reasoning: string;
}
```

### 5.6 质量验证（Validate）

```typescript
class EvolutionValidator {
  /**
   * 验证提炼结果的质量
   */
  validate(insight: ExtractedInsight): ValidationResult {
    const issues: string[] = [];

    // 1. 格式验证
    if (!insight.name || !/^[a-z][a-z0-9-]*$/.test(insight.name)) {
      issues.push("name 必须是 kebab-case");
    }
    if (!insight.prompt || insight.prompt.length < 50) {
      issues.push("prompt 内容过短，缺乏可操作性");
    }
    if (!insight.prompt || insight.prompt.length > 2000) {
      issues.push("prompt 过长，应精简到核心要点");
    }
    if (insight.confidence < 0 || insight.confidence > 1) {
      issues.push("confidence 必须在 0-1 之间");
    }

    // 2. 内容验证
    if (insight.prompt.includes("TODO") || insight.prompt.includes("待定")) {
      issues.push("prompt 中包含未完成内容");
    }

    // 3. 安全验证
    if (this.containsUnsafeContent(insight.prompt)) {
      issues.push("prompt 包含潜在不安全内容");
    }

    return {
      valid: issues.length === 0,
      issues,
      adjustedConfidence: issues.length > 0
        ? insight.confidence * 0.5
        : insight.confidence,
    };
  }

  private containsUnsafeContent(prompt: string): boolean {
    const unsafePatterns = [
      /rm\s+-rf/,
      /process\.env\.\w+/,  // 不应该引导 Agent 读取环境变量
      /eval\(/,
      /exec\(/,
    ];
    return unsafePatterns.some(p => p.test(prompt));
  }
}

interface ValidationResult {
  valid: boolean;
  issues: string[];
  adjustedConfidence: number;
}
```

### 5.7 持久化与生命周期（Store）

```typescript
class EvolutionStore {
  /**
   * 将验证通过的 insight 存为 Skill
   */
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
        type: "builtin",  // prompt-only 类型
        scope: "user",
        userId: signal.source.userId,
        schema: {},  // prompt-only，无参数
        implementation: null,
        // ─── 进化相关字段 ───
        evolutionType: insight.type,
        confidence: insight.confidence,
        learnedFromRunId: signal.source.runId,
        status: autoActivate ? "active" : "draft",
        prompt: insight.prompt,
        triggerKeywords: insight.triggerKeywords,
        disclosureLevel: autoActivate ? "hidden" : "deferred",
        // hidden = 通过反应式激活自动注入
        // deferred = 用户确认后才生效
      },
    });

    // 注册激活规则（如果 auto-activate）
    if (autoActivate && insight.triggerKeywords.length > 0) {
      await this.registerActivationRule(skill, insight);
    }

    return skill;
  }

  private async registerActivationRule(skill: StoredSkill, insight: ExtractedInsight): Promise<void> {
    const rule: ActivationRule = {
      id: `learned-${skill.id}`,
      event: ActivationEvent.USER_MENTIONS_KEYWORD,
      condition: {
        type: "keyword_match",
        keywords: insight.triggerKeywords,
        field: "user_message",
      },
      action: { type: "inject_skill", skillName: skill.name },
      cooldown: 0,
      priority: 30, // learned skill 优先级低于 platform skill
    };

    await prisma.activationRule.create({ data: rule });
  }
}
```

### 5.8 Skill 生命周期状态机

```
                    ┌───────────────────────────────────────────────────────┐
                    │                                                       │
                    ▼                                                       │
┌──────────┐  confidence ≥ 0.8  ┌──────────┐  3次正向使用  ┌──────────┐   │
│  Draft   │───────────────────▶│  Active  │──────────────▶│ Verified │   │
│  草稿    │                    │  生效中   │               │  已验证   │   │
└──────────┘                    └──────────┘               └──────────┘   │
     │                               │                          │          │
     │ 用户确认                       │ 用户否决                  │          │
     └──────────────────────────────▶│ 或连续3次无用             │          │
                                     ▼                          │          │
                                ┌──────────┐                    │          │
                                │ Archived │◀───────────────────┘          │
                                │  已归档   │  30天未使用                    │
                                └──────────┘                               │
                                     │                                     │
                                     │ 用户手动恢复                          │
                                     └─────────────────────────────────────┘

状态转换规则:
- draft → active:   confidence ≥ 0.8 自动激活，或用户手动确认
- active → verified: 被注入 3 次且所在 run 成功率 ≥ 66%
- active → archived: 用户主动否决，或连续 3 次注入但 run 失败
- verified → archived: 30 天未被激活使用
- archived → active: 用户手动恢复
```

### 5.9 手动触发命令设计

```typescript
// 用户可通过 API 或前端触发的命令

interface EvolveCommand {
  /** /evolve — 分析最近 N 次 run，提炼经验 */
  type: "evolve";
  params: {
    scope: "last_run" | "recent_5" | "all_project";
    force?: boolean;  // 忽略 filter 阶段，强制提炼
  };
}

interface ReflectCommand {
  /** /reflect — 让 Agent 自述学到了什么（展示用，不写入） */
  type: "reflect";
  params: {
    runId?: string;  // 指定分析哪次 run
  };
}

interface ForgetCommand {
  /** /forget <skill-name> — 删除/归档一个 learned skill */
  type: "forget";
  params: {
    skillName: string;
  };
}

// API 端点
// POST /api/skills/evolve   → 触发进化管线
// POST /api/skills/reflect  → 返回分析结果（不持久化）
// DELETE /api/skills/learned/:name → 归档 learned skill
```

### 5.10 联邦进化（跨用户知识聚合）

```typescript
/**
 * 联邦进化不共享原始对话，只聚合抽象后的 skill。
 * 当多个用户独立产生相似的 learned skill 时，系统自动 promote。
 */
class FederatedEvolution {
  /**
   * 定期运行（Cron job），检测是否有可 promote 的 skill
   */
  async scanForPromotion(): Promise<void> {
    // 1. 找到所有 active/verified 的 learned skills
    const learnedSkills = await prisma.skill.findMany({
      where: {
        category: "learned",
        status: { in: ["active", "verified"] },
      },
    });

    // 2. 按语义相似度聚类（简单实现：description 的关键词重叠）
    const clusters = this.clusterByDescription(learnedSkills);

    // 3. 达到阈值的 cluster → 生成 platform-level skill
    for (const cluster of clusters) {
      if (cluster.length >= 3) {  // 3 个用户独立学到了类似经验
        await this.promoteToGlobal(cluster);
      }
    }
  }

  private async promoteToGlobal(cluster: Skill[]): Promise<void> {
    // 用 LLM 合并多个相似 skill 为一个更通用的版本
    const merged = await this.mergeSkills(cluster);

    await prisma.skill.create({
      data: {
        ...merged,
        scope: "global",
        category: "community",
        status: "active",
        confidence: this.averageConfidence(cluster),
        // 追踪来源（不暴露具体用户）
        federatedFrom: cluster.map(s => s.id),
        federatedCount: cluster.length,
      },
    });
  }

  private clusterByDescription(skills: Skill[]): Skill[][] {
    // 简化实现：基于关键词 Jaccard 相似度
    // 生产环境可用 embedding + 余弦相似度
    const clusters: Skill[][] = [];
    const assigned = new Set<string>();

    for (const skill of skills) {
      if (assigned.has(skill.id)) continue;

      const cluster = [skill];
      assigned.add(skill.id);

      for (const other of skills) {
        if (assigned.has(other.id)) continue;
        if (this.similarity(skill.description, other.description) > 0.6) {
          cluster.push(other);
          assigned.add(other.id);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }
}
```

---

## 六、归因追踪系统（Skill Attribution）

### 6.1 设计原理

没有归因，自进化就是盲人摸象。需要回答：
- 哪些 skill 被注入后**真正影响了** Agent 行为？
- 哪些 skill 只是占了 token 但没起作用？
- 一个 skill 对任务成功率的**贡献度**是多少？

### 6.2 归因数据模型

```typescript
interface SkillAttribution {
  id: string;
  runId: string;
  skillName: string;
  
  // ─── 注入信息 ───
  injectedAt: number;         // 第几步注入的
  injectionSource: "resident" | "deferred_by_agent" | "reactive" | "graph_dep";
  
  // ─── 使用信息 ───
  toolsCalled: number;        // 该 skill 的 tool 被调用了几次
  promptFollowed: boolean;    // Agent 是否遵循了 skill prompt 的指导（LLM 判定）
  
  // ─── 效果信息 ───
  runSuccess: boolean;        // 所在 run 是否成功
  stepsAfterInjection: number; // 注入后还执行了多少步
  contributionScore: number;  // 0-1 综合贡献度
}

// Prisma model
// model SkillAttribution {
//   id                  String   @id @default(cuid())
//   runId               String
//   skillName           String
//   injectedAtStep      Int
//   injectionSource     String
//   toolsCalled         Int      @default(0)
//   promptFollowed      Boolean  @default(false)
//   runSuccess          Boolean
//   stepsAfterInjection Int
//   contributionScore   Float    @default(0)
//   createdAt           DateTime @default(now())
//
//   @@index([skillName])
//   @@index([runId])
// }
```

### 6.3 追踪器实现

```typescript
class AttributionTracker {
  private attributions = new Map<string, SkillAttribution>();
  private currentStep = 0;

  /**
   * 记录 skill 被注入
   */
  recordInjection(skillName: string, source: SkillAttribution["injectionSource"]): void {
    this.attributions.set(skillName, {
      id: generateId(),
      runId: this.runId,
      skillName,
      injectedAt: this.currentStep,
      injectionSource: source,
      toolsCalled: 0,
      promptFollowed: false,
      runSuccess: false,
      stepsAfterInjection: 0,
      contributionScore: 0,
    });
  }

  /**
   * 每个 step 结束时更新
   */
  onStepComplete(step: number, toolCallName?: string): void {
    this.currentStep = step;
    for (const attr of this.attributions.values()) {
      attr.stepsAfterInjection = step - attr.injectedAt;
      
      // 如果调用了该 skill 的 tool
      if (toolCallName && this.isSkillTool(attr.skillName, toolCallName)) {
        attr.toolsCalled++;
      }
    }
  }

  /**
   * Run 结束时计算最终分数
   */
  async finalize(runSuccess: boolean, finalMessages: Message[]): Promise<SkillAttribution[]> {
    for (const attr of this.attributions.values()) {
      attr.runSuccess = runSuccess;

      // 计算综合贡献度
      attr.contributionScore = this.calculateScore(attr, finalMessages);
    }

    const results = Array.from(this.attributions.values());

    // 持久化
    await this.persist(results);

    // 更新 skill 的聚合统计
    await this.updateSkillStats(results);

    return results;
  }

  private calculateScore(attr: SkillAttribution, messages: Message[]): number {
    let score = 0;

    // 基础分：run 成功 +0.3
    if (attr.runSuccess) score += 0.3;

    // tool 被调用 +0.3（封顶）
    score += Math.min(attr.toolsCalled * 0.1, 0.3);

    // prompt 被遵循 +0.3（通过 LLM 快速判定或启发式规则）
    if (attr.promptFollowed) score += 0.3;

    // 惩罚：注入后 run 立刻失败 -0.2
    if (!attr.runSuccess && attr.stepsAfterInjection <= 2) score -= 0.2;

    // 注入来源加权：reactive 激活的 skill 本身就是"精准推送"，基础分略高
    if (attr.injectionSource === "reactive") score += 0.1;

    return Math.max(0, Math.min(1, score));
  }

  private async updateSkillStats(attributions: SkillAttribution[]): Promise<void> {
    for (const attr of attributions) {
      await prisma.skill.update({
        where: { name: attr.skillName },
        data: {
          usageCount: { increment: 1 },
          lastUsedAt: new Date(),
          // 滚动平均贡献度
          avgContribution: {
            set: await this.rollingAverage(attr.skillName, attr.contributionScore),
          },
        },
      });
    }
  }

  private async rollingAverage(skillName: string, newScore: number): Promise<number> {
    const recent = await prisma.skillAttribution.findMany({
      where: { skillName },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { contributionScore: true },
    });
    const scores = [...recent.map(r => r.contributionScore), newScore];
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
}
```

### 6.4 归因驱动的自动降权/升权

```typescript
class SkillReputationManager {
  /**
   * 定期运行，根据归因数据调整 skill 的披露级别和状态
   */
  async adjustReputation(): Promise<void> {
    const skills = await prisma.skill.findMany({
      where: { status: "active", category: "learned" },
    });

    for (const skill of skills) {
      const avgScore = skill.avgContribution;
      const usageCount = skill.usageCount;

      // 1. 高贡献 + 高使用 → 升级到 resident
      if (avgScore > 0.7 && usageCount > 5) {
        await prisma.skill.update({
          where: { id: skill.id },
          data: { disclosureLevel: "resident", status: "verified" },
        });
      }

      // 2. 低贡献 + 多次使用 → 降级到 hidden 或 archived
      if (avgScore < 0.2 && usageCount > 3) {
        await prisma.skill.update({
          where: { id: skill.id },
          data: { status: "archived" },
        });
      }

      // 3. 从未被实际使用（注入了但 tool 从不调用，prompt 从不遵循）
      if (usageCount > 5 && avgScore < 0.1) {
        await prisma.skill.update({
          where: { id: skill.id },
          data: { status: "archived", archivedReason: "consistently_unused" },
        });
      }
    }
  }
}
```

---

## 七、MCP 作为 Skill Provider

### 7.1 设计原理

MCP (Model Context Protocol) 为外部系统提供了一个标准化接口来向 Agent 暴露能力。
将 MCP 接入 Skill 系统意味着：**任何 MCP Server 都可以变成一个 Skill Provider**。

```
External MCP Servers                    Skill System
┌───────────────────┐                  ┌──────────────────┐
│ Company API MCP   │──── discover ───▶│                  │
├───────────────────┤                  │  MCP Skill       │
│ Design System MCP │──── discover ───▶│  Adapter         │
├───────────────────┤                  │                  │
│ CI/CD MCP         │──── discover ───▶│  capabilities    │
└───────────────────┘                  │  → SkillDef[]    │
                                       └────────┬─────────┘
                                                │
                                                ▼
                                       ┌──────────────────┐
                                       │  Skill Registry  │
                                       │  (统一管理)       │
                                       └──────────────────┘
```

### 7.2 MCP Skill Adapter

```typescript
interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse" | "http";
  endpoint: string;           // stdio: command path, sse/http: URL
  auth?: {
    type: "bearer" | "api_key" | "none";
    token?: string;
  };
  autoDiscover: boolean;      // 是否自动发现所有 capabilities 并注册为 skill
  whitelist?: string[];       // 只注册指定的 capability
}

class MCPSkillAdapter {
  private servers = new Map<string, MCPConnection>();

  /**
   * 连接 MCP Server 并发现可用能力
   */
  async connect(config: MCPServerConfig): Promise<SkillDefinition[]> {
    const connection = await this.createConnection(config);
    this.servers.set(config.name, connection);

    // 发现 capabilities
    const capabilities = await connection.listTools();

    // 转换为 SkillDefinition
    const skills: SkillDefinition[] = capabilities
      .filter(cap => !config.whitelist || config.whitelist.includes(cap.name))
      .map(cap => ({
        name: `mcp-${config.name}-${cap.name}`,
        displayName: cap.name,
        description: cap.description,
        category: `mcp:${config.name}`,
        type: "mcp" as const,
        schema: cap.inputSchema,
        mcpConfig: {
          server: config.name,
          method: cap.name,
        },
      }));

    return skills;
  }

  /**
   * 执行 MCP tool call
   */
  async execute(
    skillName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const [_, serverName, methodName] = skillName.split("-", 3);
    // 实际解析逻辑更复杂，这里简化

    const connection = this.servers.get(serverName);
    if (!connection) {
      return { success: false, output: `MCP server '${serverName}' not connected` };
    }

    try {
      const result = await connection.callTool(methodName, args);
      return {
        success: true,
        output: typeof result === "string" ? result : JSON.stringify(result),
      };
    } catch (error) {
      return {
        success: false,
        output: `MCP call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 断开连接并清理
   */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.servers.get(serverName);
    if (connection) {
      await connection.close();
      this.servers.delete(serverName);
    }
  }
}
```

### 7.3 用户配置 MCP Server

```typescript
// 用户可在 Settings 中配置自己的 MCP Servers
// 存储在 UserSettings 表中

interface UserMCPConfig {
  servers: MCPServerConfig[];
  globalEnabled: boolean;     // 总开关
}

// API: PUT /api/settings/mcp
// Body: UserMCPConfig
```

### 7.4 安全沙箱内的 MCP 执行

MCP 调用在 E2B sandbox 内发起，防止恶意 MCP server 影响主进程：

```typescript
// agent-runtime 内的 MCP 执行流
async function executeMCPInSandbox(
  config: MCPServerConfig,
  method: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // MCP 连接在 sandbox 内建立
  // 网络请求从 sandbox 发出
  // 超时限制：30 秒
  // 输出大小限制：100KB

  const timeout = 30_000;
  const maxOutputSize = 100 * 1024;

  try {
    const result = await Promise.race([
      mcpAdapter.execute(`mcp-${config.name}-${method}`, args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("MCP call timeout")), timeout)
      ),
    ]);

    if (result.output.length > maxOutputSize) {
      result.output = result.output.slice(0, maxOutputSize) + "\n[输出已截断]";
    }

    return result;
  } catch (error) {
    return {
      success: false,
      output: `MCP 执行失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
```

---

## 八、数据模型升级（Prisma Schema）

### 8.1 Skill 表扩展

在现有 `Skill` 模型基础上新增字段，保持向后兼容：

```prisma
// ─── Skill 系统 v9 ──────────────────────────────────────────────────────────────

enum SkillType {
  builtin
  composite
  mcp
  prompt_only    // 新增：纯 prompt 注入型
}

enum SkillScope {
  global
  user
  project
}

enum SkillStatus {
  draft
  active
  verified
  archived
}

enum DisclosureLevel {
  resident     // 常驻 tools 列表
  deferred     // 仅在 catalogue 中列出，Agent 按需激活
  hidden       // 不对 Agent 披露，反应式激活引擎自动注入
}

model Skill {
  id             String          @id @default(cuid())
  name           String
  displayName    String
  description    String
  category       String
  schema         Json            // tool parameters schema
  type           SkillType
  implementation Json?           // composite steps / handler config
  mcpConfig      Json?           // MCP server + method
  scope          SkillScope
  userId         String?
  projectId      String?
  version        Int             @default(1)
  enabled        Boolean         @default(true)
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  // ─── v9 新增字段 ──────────────────────────────────────────
  status           SkillStatus     @default(active)
  disclosureLevel  DisclosureLevel @default(deferred)
  prompt           String?         // Markdown prompt 内容（prompt_only 和 hybrid 类型）
  triggerKeywords  String[]        // 反应式激活的关键词列表

  // 进化相关
  evolutionType    String?         // "pitfall" | "pattern" | "preference" | "workflow" | null(手动创建)
  confidence       Float?          // 自进化 skill 的置信度 0-1
  learnedFromRunId String?         // 来源 runId
  federatedFrom    String[]        // 联邦进化来源 skill IDs
  federatedCount   Int             @default(0)

  // 使用统计
  usageCount       Int             @default(0)
  lastUsedAt       DateTime?
  avgContribution  Float           @default(0)   // 滚动平均贡献度

  // 图关系
  relations        Json?           // { requires: [], enhances: [], conflicts: [], ... }

  // ─── 关系 ─────────────────────────────────────────────────
  user          User?           @relation(fields: [userId], references: [id])
  project       Project?        @relation(fields: [projectId], references: [id], onDelete: Cascade)
  attributions  SkillAttribution[]

  @@unique([name, scope, userId, projectId])
  @@index([userId, scope, status])
  @@index([projectId, scope, status])
  @@index([category, status])
  @@index([disclosureLevel, scope])
}
```

### 8.2 新增表

```prisma
// ─── 归因追踪 ────────────────────────────────────────────────────────────────

model SkillAttribution {
  id                  String   @id @default(cuid())
  runId               String
  skillName           String
  injectedAtStep      Int
  injectionSource     String   // "resident" | "deferred_by_agent" | "reactive" | "graph_dep"
  toolsCalled         Int      @default(0)
  promptFollowed      Boolean  @default(false)
  runSuccess          Boolean
  stepsAfterInjection Int      @default(0)
  contributionScore   Float    @default(0)
  createdAt           DateTime @default(now())

  skill   Skill   @relation(fields: [skillName], references: [name])
  run     ProjectRun @relation(fields: [runId], references: [id])

  @@index([skillName, createdAt])
  @@index([runId])
}

// ─── 激活规则 ────────────────────────────────────────────────────────────────

model ActivationRule {
  id           String   @id @default(cuid())
  event        String   // ActivationEvent enum value
  condition    Json     // ActivationCondition 结构
  action       Json     // ActivationAction 结构
  cooldown     Int      @default(0)
  priority     Int      @default(50)
  enabled      Boolean  @default(true)
  
  // 来源：平台内置 or 用户自定义 or 进化生成
  source       String   @default("platform") // "platform" | "user" | "evolved"
  skillName    String?  // 关联的 skill（如果 action 是 inject_skill）
  userId       String?  // 用户自定义规则归属

  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([event, enabled])
  @@index([userId])
}

// ─── 进化记录 ────────────────────────────────────────────────────────────────

model EvolutionRecord {
  id            String   @id @default(cuid())
  userId        String
  runId         String
  signalType    String   // "pitfall" | "pattern" | "preference" | "workflow"
  signalStrength Float
  extractedInsight Json?  // ExtractedInsight JSON
  resultSkillId String?  // 成功提炼后生成的 skill id
  status        String   // "detected" | "filtered" | "extracted" | "validated" | "stored" | "discarded"
  discardReason String?
  createdAt     DateTime @default(now())

  @@index([userId, createdAt])
  @@index([status])
}

// ─── MCP Server 配置 ──────────────────────────────────────────────────────────

model UserMCPServer {
  id         String   @id @default(cuid())
  userId     String
  name       String
  transport  String   // "stdio" | "sse" | "http"
  endpoint   String
  authType   String   @default("none")
  authToken  String?  // 加密存储
  autoDiscover Boolean @default(true)
  whitelist  String[]
  enabled    Boolean  @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  user       User     @relation(fields: [userId], references: [id])

  @@unique([userId, name])
}
```

### 8.3 迁移策略

```sql
-- Migration: add_skill_v9_fields
-- 1. 新增字段（全部 nullable 或有默认值，不影响现有数据）
ALTER TABLE "Skill" ADD COLUMN "status" TEXT DEFAULT 'active';
ALTER TABLE "Skill" ADD COLUMN "disclosureLevel" TEXT DEFAULT 'deferred';
ALTER TABLE "Skill" ADD COLUMN "prompt" TEXT;
ALTER TABLE "Skill" ADD COLUMN "triggerKeywords" TEXT[] DEFAULT '{}';
ALTER TABLE "Skill" ADD COLUMN "evolutionType" TEXT;
ALTER TABLE "Skill" ADD COLUMN "confidence" FLOAT;
ALTER TABLE "Skill" ADD COLUMN "learnedFromRunId" TEXT;
ALTER TABLE "Skill" ADD COLUMN "federatedFrom" TEXT[] DEFAULT '{}';
ALTER TABLE "Skill" ADD COLUMN "federatedCount" INT DEFAULT 0;
ALTER TABLE "Skill" ADD COLUMN "lastUsedAt" TIMESTAMP;
ALTER TABLE "Skill" ADD COLUMN "avgContribution" FLOAT DEFAULT 0;
ALTER TABLE "Skill" ADD COLUMN "relations" JSONB;

-- 2. 现有 skill 的 disclosureLevel 默认处理
UPDATE "Skill" SET "disclosureLevel" = 'resident' WHERE "type" = 'builtin';
UPDATE "Skill" SET "disclosureLevel" = 'deferred' WHERE "type" IN ('composite', 'mcp');

-- 3. 新建索引
CREATE INDEX "Skill_disclosureLevel_scope_idx" ON "Skill"("disclosureLevel", "scope");
CREATE INDEX "Skill_category_status_idx" ON "Skill"("category", "status");
```

---

## 九、对现有代码的改造清单

### 9.1 改造概览

```
改动范围                           改动类型        影响度
─────────────────────────────────────────────────────────────
prisma/schema.prisma              新增表+字段     中（纯增量）
e2b-template/agent-runtime/
  ├── src/types.ts                扩展接口       低
  ├── src/skill-manager.ts        重写           高
  ├── src/loop.ts                 插入钩子       中
  ├── src/reactive-activator.ts   新文件         -
  ├── src/dynamic-injector.ts     新文件         -
  ├── src/attribution-tracker.ts  新文件         -
  ├── src/evolution/              新目录         -
  │   ├── pipeline.ts
  │   ├── signal-detector.ts
  │   ├── filter.ts
  │   ├── extractor.ts
  │   ├── validator.ts
  │   └── store.ts
  ├── src/skill-graph.ts          新文件         -
  └── src/mcp-adapter.ts          新文件         -
src/app/api/internal/skills/
  ├── route.ts                    扩展           中
  └── evolve/route.ts             新文件         -
src/app/api/skills/               新目录（用户API）-
src/worker.ts                     追加 post-run  低
```

### 9.2 agent-runtime/src/skill-manager.ts 重写

当前的 SkillManager 承担了加载 + 转换 + 执行三个职责，重构为：

```typescript
// 新架构：拆分为四个模块

// 1. SkillRegistry — 加载 + 缓存 + 分级管理
class SkillRegistry {
  async loadAll(): Promise<void>;
  getResident(): SkillDefinition[];
  getDeferred(): SkillCatalogueEntry[];  // 只有 name + description
  getHidden(): SkillDefinition[];
  getByName(name: string): SkillDefinition | undefined;
  getByCategory(category: string): SkillDefinition[];
}

// 2. DynamicInjector — 管理运行时的动态注入
class DynamicInjector {
  activate(skill: SkillDefinition): void;
  injectPrompt(content: string): void;
  buildLLMPayload(...): { tools, messages };
}

// 3. ReactiveActivator — 事件驱动激活
class ReactiveActivator {
  async emit(event: ActivationEvent, payload: Record<string, unknown>): Promise<void>;
}

// 4. SkillExecutor — 统一执行入口
class SkillExecutor {
  async execute(skillName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  // 内部根据 type 分发：builtin → tools.ts, composite → step runner, mcp → adapter
}
```

### 9.3 loop.ts 改造点

```typescript
// 改造前：
const tools = AGENT_TOOLS;
const systemPrompt = SYSTEM_PROMPT;
response = await chatCompletionWithTools(client, model, messages, tools);
result = await executeTool(fnName, args, toolCtx);

// 改造后：
const registry = new SkillRegistry(redis, logger, config);
await registry.loadAll();

const injector = new DynamicInjector(registry);
const activator = new ReactiveActivator(injector, await loadActivationRules());
const tracker = new AttributionTracker(config.runId);
const executor = new SkillExecutor(registry, mcpAdapter);
const graph = new SkillGraph(registry.getAll());

// 构建初始 payload
const baseTools = [
  ...PLATFORM_TOOLS,
  ACTIVATE_SKILL_TOOL,  // meta-tool
  ...registry.getResident().flatMap(s => s.toOpenAITools()),
];
const catalogue = registry.getDeferred();
const systemPrompt = buildSystemPrompt(SYSTEM_PROMPT, catalogue);

// 每个 step 内：
// 1. 事件发射
activator.emit(ActivationEvent.USER_MESSAGE_RECEIVED, { user_message: userMessage });

// 2. 动态构建 payload
const { tools, messages } = injector.buildLLMPayload(baseTools, messages);

// 3. LLM 调用（不变）
response = await chatCompletionWithTools(client, model, messages, tools);

// 4. 处理 activate_skill meta-tool
if (fnName === "activate_skill") {
  const skill = registry.getByName(args.name);
  if (skill) {
    const resolved = graph.resolve(skill.name, injector.activeSkills);
    for (const name of resolved.toActivate) {
      injector.activate(registry.getByName(name)!);
      tracker.recordInjection(name, "deferred_by_agent");
    }
  }
}

// 5. 正常 tool 执行
result = await executor.execute(fnName, args, toolCtx);
tracker.onStepComplete(step, fnName);

// 6. 事件发射（执行后）
if (!result.success) activator.emit(ActivationEvent.TOOL_CALL_FAILED, { ... });

// Run 结束后：
await tracker.finalize(result.success, messages);
```

### 9.4 worker.ts 追加 post-run 逻辑

```typescript
// worker.ts — dispatch 成功回调后

// 现有逻辑不变...

// 新增：触发进化管线（仅在成功时）
if (result.success && evolutionConfig.autoMode) {
  // 异步执行，不阻塞 worker
  evolve(userId, projectId, runId).catch(err => {
    logger.warn("Evolution pipeline failed", { error: err.message });
  });
}
```

### 9.5 新增 API 端点

```typescript
// POST /api/internal/skills/evolve — 内部触发进化
// POST /api/skills/evolve — 用户手动触发 /evolve
// GET  /api/skills/learned — 获取用户的 learned skills
// PUT  /api/skills/:name/status — 修改 skill 状态（confirm/archive/restore）
// GET  /api/skills/attributions — 查看 skill 贡献度报表
// PUT  /api/settings/evolution — 修改进化配置
// PUT  /api/settings/mcp — 配置 MCP servers
```

---

## 十、实施路径

### Phase 1 — 混合披露 + 反应式激活（2-3 天）

**目标**：解决 token 浪费，实现精准激活

- [ ] 扩展 Prisma schema（新增字段 + ActivationRule 表）
- [ ] 重构 SkillManager → SkillRegistry + DynamicInjector
- [ ] 实现 ReactiveActivator + 内置规则
- [ ] 改造 loop.ts 注入钩子
- [ ] 实现 activate_skill meta-tool
- [ ] 更新 /api/internal/skills 支持 disclosureLevel 过滤

**验证**：Agent 不再全量加载所有 skill，构建失败时自动注入诊断 skill

### Phase 2 — 双模式自进化 + 归因追踪（3-4 天）

**目标**：让系统从经验中学习，有真实反馈

- [ ] 实现 AttributionTracker
- [ ] 实现 Evolution Pipeline（signal → filter → extract → validate → store）
- [ ] 新增 /api/skills/evolve 端点
- [ ] worker.ts 追加 post-run 进化逻辑
- [ ] 实现 SkillReputationManager（归因驱动升降权）
- [ ] 前端：learned skills 管理面板

**验证**：Agent 完成含构建修复的任务后，自动生成 learned skill；贡献度低的 skill 自动降权

### Phase 3 — Skill Graph（1-2 天）

**目标**：让 skill 之间有组合关系

- [ ] 实现 SkillGraph（resolve、conflict detection、cycle detection）
- [ ] Skill manifest 支持 relations 字段
- [ ] activate_skill 时自动拉入依赖
- [ ] 冲突检测与策略处理

**验证**：激活 full-landing-page 时自动拉入 responsive-layout + seo-optimizer

### Phase 4 — MCP 集成 + 联邦进化（2-3 天）

**目标**：打通外部能力通道，开启跨用户知识共享

- [ ] 实现 MCPSkillAdapter
- [ ] 用户 MCP 配置 UI + API
- [ ] SkillExecutor 对接 MCP 执行
- [ ] 实现 FederatedEvolution（定时聚合任务）
- [ ] 社区 skill 展示面板

**验证**：用户配置自定义 MCP server 后，Agent 可发现并调用其能力

---

## 十一、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 动态注入导致 LLM 上下文混乱 | Agent 行为不稳定 | 限制单次 run 最多激活 5 个 skill；注入内容有 token 预算 |
| 自进化噪音多 | 学到无用/错误经验 | 置信度门槛 + 归因反馈 + 30天 decay + 用户否决机制 |
| 反应式激活误触发 | 不相关 skill 被注入 | cooldown 机制 + 优先级排序 + 每 turn 最多触发 2 条规则 |
| MCP server 不可靠 | tool call 超时/失败 | 30s 超时 + 沙箱隔离 + 失败 fallback（graceful degradation） |
| Skill Graph 循环依赖 | 无限注入 | 注册时跑 cycle detection，有环拒绝注册 |
| 联邦进化隐私风险 | 用户数据泄露 | 只聚合 prompt 文本，不传递原始对话；聚类基于 description 而非内容 |
| Schema 迁移风险 | 线上 DB 不兼容 | 全部新增字段有默认值，纯增量迁移，不改现有字段类型 |

---

## 十二、与 v7 的兼容性

本方案是 v7 的**严格超集**：

| v7 设计 | v9 处理方式 |
|---------|-------------|
| SkillType: builtin/composite/mcp | 保留，新增 prompt_only |
| SkillScope: global/user/project | 保留不变 |
| SkillManager.loadSkills() | 重构为 SkillRegistry，API 接口兼容 |
| SkillManager.toOpenAITools() | 拆分为 resident tools + catalogue prompt |
| SkillManager.executeSkill() | 迁移到 SkillExecutor，switch 逻辑不变 |
| composite step 执行 | 保留在 SkillExecutor 内 |
| Redis 5 分钟缓存 | 保留，增加 invalidation on skill status change |
| Prisma Skill 表结构 | 纯增量字段，不改现有列 |

**零破坏性变更**：现有 skill 数据无需迁移，新增字段全部有默认值，`enabled: true` 的现有 skill 自动映射为 `status: active, disclosureLevel: deferred`。
