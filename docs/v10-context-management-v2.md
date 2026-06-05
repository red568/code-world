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
策略: 把旧的 read_file/list_files 结果替换为 "[已执行 tool]"
保留: 最近 5 轮完整
```

问题：
1. 信息永久丢失 — Agent 无法回忆之前读过的文件内容或做过的决策
2. 无差别裁剪 — 不考虑"哪些历史对当前任务最有价值"
3. 被动触发 — 等满了再压，而非主动规划 token 预算

---

## 架构总览

```
                    ┌─────────────────────────────┐
                    │     Context Assembler       │
                    │   （每次 LLM 调用前执行）     │
                    │                             │
                    │  输入: 当前 user message     │
                    │        + 全部 Episodes       │
                    │        + TaskContext         │
                    │                             │
                    │  输出: 组装好的 messages[]    │
                    │        (在 token 预算内)     │
                    └──────────────┬──────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
    ┌─────────▼────────┐  ┌───────▼───────┐  ┌────────▼────────┐
    │  Episode Store   │  │  Task Context │  │   Repo Map      │
    │  (全量落盘)      │  │  (聚合状态)   │  │   (代码骨架)    │
    │                  │  │               │  │                 │
    │  Redis + 文件    │  │  Redis        │  │  按需生成+缓存  │
    └──────────────────┘  └───────────────┘  └─────────────────┘
              ↑                    ↑                    ↑
              │                    │                    │
    ┌─────────┴────────┐  ┌───────┴───────┐  ┌────────┴────────┐
    │ Episode Recorder │  │ Task Tracker  │  │  tree-sitter    │
    │ (每步后记录)     │  │ (每步后更新)  │  │  Python sidecar │
    └──────────────────┘  └───────────────┘  └─────────────────┘
```

---

## 实施层次（从简单到复杂，每层可独立上线）

---

## Layer 1：结构化落盘 + 简单组装（替换 compressor）

**目标**：不丢信息，用最简单的策略组装 context

**改动范围**：agent-runtime 内部，不影响其他模块

### 1.1 Episode 数据结构

```typescript
// e2b-template/agent-runtime/src/types/episode.ts

interface Episode {
  stepNumber: number;
  timestamp: number;

  // 工具调用信息
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolSuccess: boolean;

  // 输出（分两层存储）
  resultSummary: string;   // ≤200 字符的摘要（装载用）
  resultFull: string;      // 完整输出（落盘用，按需装载）

  // Agent 的思考（assistant message content）
  thinking: string;

  // 代码变更（如果是 write_file）
  codeChange?: {
    file: string;
    linesWritten: number;
  };

  // 关联文件（从 toolArgs 中提取）
  relatedFiles: string[];

  // token 开销统计
  tokensUsed: number;
}
```

### 1.2 Episode Recorder

在 loop.ts 每步工具执行完成后，同步记录 Episode：

```typescript
// e2b-template/agent-runtime/src/episode-recorder.ts

class EpisodeRecorder {
  private episodes: Episode[] = [];
  private redis: RedisInterface;
  private cacheKey: string;

  constructor(redis: RedisInterface, projectId: string, runId: string) {
    this.redis = redis;
    this.cacheKey = `episodes:${projectId}:${runId}`;
  }

  record(step: number, toolName: string, toolArgs: Record<string, unknown>,
         result: ToolResult, thinking: string): void {
    const episode: Episode = {
      stepNumber: step,
      timestamp: Date.now(),
      toolName,
      toolArgs,
      toolSuccess: result.success,
      resultSummary: this.summarize(toolName, result),
      resultFull: result.output,
      thinking: thinking.slice(0, 500),
      codeChange: this.extractCodeChange(toolName, toolArgs),
      relatedFiles: this.extractFiles(toolName, toolArgs),
      tokensUsed: Math.ceil(result.output.length / 4),
    };

    this.episodes.push(episode);
  }

  // 规则式摘要，零 LLM 调用
  private summarize(toolName: string, result: ToolResult): string {
    if (!result.success) {
      return `[FAILED] ${result.output.slice(0, 150)}`;
    }
    switch (toolName) {
      case "read_file":
        const lines = result.output.split("\n").length;
        return `[读取成功] ${lines} 行`;
      case "write_file":
        return result.output; // "Written src/xxx.tsx"
      case "run_shell":
        return result.output.includes("exit_code: 0")
          ? "[执行成功]"
          : `[失败] ${result.output.slice(-100)}`;
      case "list_files":
        const count = result.output.split("\n").length;
        return `[${count} 个文件]`;
      default:
        return result.output.slice(0, 200);
    }
  }

  private extractCodeChange(toolName: string, args: Record<string, unknown>) {
    if (toolName !== "write_file") return undefined;
    return {
      file: args.path as string,
      linesWritten: ((args.content as string) || "").split("\n").length,
    };
  }

  private extractFiles(toolName: string, args: Record<string, unknown>): string[] {
    if (args.path) return [args.path as string];
    if (args.command && typeof args.command === "string") {
      // 从 shell 命令中提取文件路径
      const fileMatch = args.command.match(/[\w\/]+\.(tsx?|css|json)/g);
      return fileMatch || [];
    }
    return [];
  }

  // 持久化到 Redis（每步调用，增量追加）
  async persist(): Promise<void> {
    await this.redis.setex(
      this.cacheKey,
      900,
      JSON.stringify(this.episodes)
    );
  }

  getAll(): Episode[] {
    return this.episodes;
  }

  // 从 Redis 恢复（resume 时）
  async restore(): Promise<void> {
    const cached = await this.redis.get(this.cacheKey);
    if (cached) {
      this.episodes = JSON.parse(cached);
    }
  }
}
```

### 1.3 Context Assembler（Layer 1 简单版）

替换 `InLoopCompressor`。核心逻辑：**固定 slot 分配 + 最近优先 + 文件关联召回**

```typescript
// e2b-template/agent-runtime/src/context-assembler.ts

interface AssemblerConfig {
  maxTokens: number;          // 总 token 预算（默认 60000）
  systemReserve: number;      // system prompt 预留（默认 3000）
  outputReserve: number;      // 输出预留（默认 4000）
  recentRoundsFullKeep: number; // 最近 N 轮保留完整原文（默认 3）
  retrievalBudgetRatio: number; // 剩余预算中用于检索的比例（默认 0.4）
}

class ContextAssembler {
  private config: AssemblerConfig;

  constructor(config?: Partial<AssemblerConfig>) {
    this.config = {
      maxTokens: 60000,
      systemReserve: 3000,
      outputReserve: 4000,
      recentRoundsFullKeep: 3,
      retrievalBudgetRatio: 0.4,
      ...config,
    };
  }

  /**
   * 组装上下文
   *
   * @param systemPrompt - system message
   * @param currentUserMessage - 当前轮用户消息
   * @param recentMessages - 最近 N 轮的原始 messages（从 loop 的 messages 数组尾部截取）
   * @param episodes - 全部历史 Episodes
   * @param taskSummary - 当前任务的一句话总结
   * @returns 组装好的 messages 数组，可直接传给 LLM
   */
  assemble(
    systemPrompt: string,
    currentUserMessage: string,
    recentMessages: OpenAI.ChatCompletionMessageParam[],
    episodes: Episode[],
    taskSummary: string
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    // Slot A: System Prompt（固定）
    result.push({ role: "system", content: systemPrompt });

    // Slot B: 任务摘要注入（固定，~200 token）
    if (taskSummary) {
      result.push({
        role: "system",
        content: `[任务上下文] ${taskSummary}`,
      });
    }

    // 计算剩余预算
    const usedTokens = this.config.systemReserve + this.config.outputReserve
      + this.estimateTokens(currentUserMessage) + 200; // taskSummary
    let remainingBudget = this.config.maxTokens - usedTokens;

    // Slot C: 最近 N 轮原文（尽可能多保留）
    const recentTokens = this.estimateMessagesTokens(recentMessages);
    const recentBudget = Math.min(recentTokens, remainingBudget * 0.6);
    const trimmedRecent = this.trimToFit(recentMessages, recentBudget);
    remainingBudget -= this.estimateMessagesTokens(trimmedRecent);

    // Slot D: 检索召回的历史（填充剩余空间）
    const retrievalBudget = remainingBudget * this.config.retrievalBudgetRatio;
    const relevantHistory = this.retrieveRelevant(
      episodes,
      currentUserMessage,
      trimmedRecent,
      retrievalBudget
    );

    // 组装顺序：历史 → 最近 → 当前（LLM 更关注开头和结尾）
    if (relevantHistory.length > 0) {
      result.push({
        role: "system",
        content: `[相关历史]\n${relevantHistory.join("\n")}`,
      });
    }

    result.push(...trimmedRecent);

    // 当前用户消息放最后
    if (!trimmedRecent.some(m => m.role === "user" && m.content === currentUserMessage)) {
      result.push({ role: "user", content: currentUserMessage });
    }

    return result;
  }

  /**
   * Layer 1 检索策略：文件关联 + 时间衰减
   */
  private retrieveRelevant(
    episodes: Episode[],
    currentMessage: string,
    recentMessages: OpenAI.ChatCompletionMessageParam[],
    budget: number
  ): string[] {
    // 排除最近已在原文中的 episodes
    const recentSteps = new Set<number>();
    // （简化：假设最近 N 轮对应最后 N 个 episodes）

    // 提取当前关注的文件
    const mentionedFiles = this.extractMentionedFiles(currentMessage, recentMessages);

    // 对每个历史 episode 打分
    const scored = episodes
      .filter(ep => !recentSteps.has(ep.stepNumber))
      .map(ep => {
        let score = 0;

        // 文件关联：当前涉及的文件在历史中出现过
        const fileOverlap = ep.relatedFiles.filter(f => mentionedFiles.has(f)).length;
        score += fileOverlap * 10;

        // 错误关联：如果当前消息提到错误，历史中的错误 episode 更相关
        if (currentMessage.includes("错误") || currentMessage.includes("error") || currentMessage.includes("fix")) {
          if (!ep.toolSuccess) score += 8;
        }

        // 代码变更关联：修改过相关文件的 episode
        if (ep.codeChange && mentionedFiles.has(ep.codeChange.file)) {
          score += 12;
        }

        // 时间衰减
        score *= Math.exp(-0.05 * (episodes.length - ep.stepNumber));

        return { episode: ep, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // 按预算填充
    const results: string[] = [];
    let usedTokens = 0;

    for (const { episode } of scored) {
      const line = this.formatEpisode(episode);
      const lineTokens = Math.ceil(line.length / 4);

      if (usedTokens + lineTokens > budget) break;

      results.push(line);
      usedTokens += lineTokens;
    }

    return results;
  }

  private formatEpisode(ep: Episode): string {
    const status = ep.toolSuccess ? "✓" : "✗";
    const files = ep.relatedFiles.join(", ");
    let line = `[Step ${ep.stepNumber}] ${status} ${ep.toolName}(${files}) → ${ep.resultSummary}`;
    if (ep.thinking) {
      line += ` | 思考: ${ep.thinking.slice(0, 100)}`;
    }
    return line;
  }

  private extractMentionedFiles(
    currentMessage: string,
    recentMessages: OpenAI.ChatCompletionMessageParam[]
  ): Set<string> {
    const files = new Set<string>();
    const allText = currentMessage + recentMessages
      .map(m => typeof m.content === "string" ? m.content : "")
      .join(" ");

    // 匹配文件路径模式
    const matches = allText.match(/[\w\-\/]+\.(tsx?|css|json|js)/g);
    if (matches) matches.forEach(f => files.add(f));

    return files;
  }

  private trimToFit(
    messages: OpenAI.ChatCompletionMessageParam[],
    budget: number
  ): OpenAI.ChatCompletionMessageParam[] {
    // 从最新开始往回，取能放下的
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    let used = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = this.estimateMessageTokens(messages[i]);
      if (used + tokens > budget) break;
      result.unshift(messages[i]);
      used += tokens;
    }

    return result;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private estimateMessageTokens(msg: OpenAI.ChatCompletionMessageParam): number {
    if (typeof msg.content === "string") return this.estimateTokens(msg.content);
    return 50; // tool_calls 等估算
  }

  private estimateMessagesTokens(msgs: OpenAI.ChatCompletionMessageParam[]): number {
    return msgs.reduce((sum, m) => sum + this.estimateMessageTokens(m), 0);
  }
}
```

### 1.4 loop.ts 改动

```typescript
// 改动点 1: 引入新模块
import { EpisodeRecorder } from "./episode-recorder.js";
import { ContextAssembler } from "./context-assembler.js";

// 改动点 2: 初始化（替换 InLoopCompressor）
const recorder = new EpisodeRecorder(redis, config.projectId, config.runId);
const assembler = new ContextAssembler();
if (config.resume) await recorder.restore();

// 改动点 3: 每步 LLM 调用前，用 assembler 组装 context
// 替换原来的 compressor.shouldCompress / compressor.compress
const assembledMessages = assembler.assemble(
  systemPrompt,
  userMessage,
  messages.slice(-recentWindow),  // 最近 N 条原始 messages
  recorder.getAll(),
  taskSummary
);

// 调 LLM 时用 assembledMessages 而非 messages
response = await chatCompletionWithTools(client, model, assembledMessages, ...);

// 改动点 4: 工具执行完成后记录 Episode
recorder.record(step, fnName, args, result, assistantMessage.content || "");
await recorder.persist();

// 改动点 5: messages 数组仍然完整保留（不再 mutate）
// 它现在是"全量历史"，不需要压缩
// assembler 负责从中选择装载什么
```

### 1.5 Layer 1 验证标准

- [ ] 同一个任务（如"做一个摄影网站"），新方案 vs 旧方案的完成步数和质量对比
- [ ] 长任务（>20 步）中，Agent 是否能回忆早期读过的文件内容
- [ ] Token 消耗是否稳定在预算内（不超过 60K）
- [ ] 每步额外延迟 < 10ms（纯规则提取 + Redis 写入）

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

在 Layer 1 的 assembler 基础上，新增 Slot D：

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

  // 在 assemble() 中新增 Slot D
  assemble(...) {
    // ... Slot A, B 同 Layer 1

    // Slot D: Repo Map（如果启用）
    if (this.config.autoInjectRepoMap && this.cachedRepoMap) {
      result.push({
        role: "system",
        content: `[项目代码骨架]\n${this.cachedRepoMap}`,
      });
      remainingBudget -= this.estimateTokens(this.cachedRepoMap);
    }

    // ... Slot C, E 同 Layer 1
  }

  // 更新缓存的 Repo Map（由 loop.ts 在首步或文件变更后调用）
  setRepoMap(map: string): void {
    this.cachedRepoMap = map;
  }
}
```

### 2.5 Layer 2 验证标准

- [ ] Agent 在"给项目加一个新页面"任务中，是否能不调 list_files + 多次 read_file 就直接定位到正确位置
- [ ] 对比有无 Repo Map 时的平均 read_file 调用次数（期望减少 50%+）
- [ ] Python 冷启动延迟测量（期望 < 1s，只在首次调用时触发）
- [ ] Repo Map 输出质量人工评估（是否包含了关键的函数签名和组件结构）

---

## Layer 3：多路召回 + 符号关联

**目标**：检索精度从"只靠文件名匹配"提升到"理解代码语义关系"

**依赖**：Layer 1 + Layer 2

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

### 3.4 Layer 3 验证标准

- [ ] 构造测试场景：Agent 在 step 5 读了 `PaymentService.ts`，step 15 用户说"修改 processPayment 函数"
  - 旧方案：Agent 需要重新 read_file
  - 新方案：assembler 自动召回 step 5 的相关信息
- [ ] 符号匹配准确率人工评估（抽样 20 个 case）
- [ ] 对比 Layer 1 vs Layer 3 在跨文件修改任务上的完成质量

---

## Layer 4：Task Context 自动维护 + 跨 Run 延续

**目标**：Agent 在多轮对话（用户多次 iterate）中保持对整个任务历程的感知

**依赖**：Layer 1-3

### 4.1 TaskContext 数据结构

```typescript
// e2b-template/agent-runtime/src/types/task-context.ts

interface TaskContext {
  projectId: string;
  runId: string;
  createdAt: number;
  updatedAt: number;

  // 任务理解
  userGoal: string;              // "做一个摄影师作品集网站"
  currentPhase: string;          // "implementing" | "debugging" | "polishing"
  currentStep: string;           // "正在修复首页的响应式布局"

  // 文件地图（已知文件 + 用途）
  knownFiles: Record<string, {
    lastSeenStep: number;
    role: string;                // "首页组件" | "路由配置" | "样式入口"
    symbols: string[];           // 包含的关键符号
  }>;

  // 关键决策记录
  decisions: Array<{
    step: number;
    decision: string;            // "使用 grid 布局而非 flex"
    reason: string;              // "图片数量不固定，grid 更适合瀑布流"
  }>;

  // 已解决的错误（防止重蹈覆辙）
  resolvedErrors: Array<{
    step: number;
    error: string;
    fix: string;
  }>;

  // 统计
  totalSteps: number;
  totalFiles: number;
  filesWritten: string[];
  filesRead: string[];
}
```

### 4.2 Task Tracker（自动更新 TaskContext）

```typescript
// e2b-template/agent-runtime/src/task-tracker.ts

class TaskTracker {
  private context: TaskContext;
  private redis: RedisInterface;
  private cacheKey: string;

  constructor(redis: RedisInterface, projectId: string, runId: string) {
    this.redis = redis;
    this.cacheKey = `task-context:${projectId}`;
    this.context = this.createEmpty(projectId, runId);
  }

  // 每步后调用，纯规则更新（零 LLM）
  update(episode: Episode): void {
    this.context.updatedAt = Date.now();
    this.context.totalSteps++;

    // 更新文件地图
    for (const file of episode.relatedFiles) {
      if (!this.context.knownFiles[file]) {
        this.context.knownFiles[file] = {
          lastSeenStep: episode.stepNumber,
          role: "",
          symbols: [],
        };
      } else {
        this.context.knownFiles[file].lastSeenStep = episode.stepNumber;
      }

      // 如果有符号信息，合并
      if (episode.relatedSymbols) {
        const existing = this.context.knownFiles[file].symbols;
        const merged = [...new Set([...existing, ...episode.relatedSymbols])];
        this.context.knownFiles[file].symbols = merged.slice(0, 20);
      }
    }

    // 记录写入的文件
    if (episode.codeChange) {
      if (!this.context.filesWritten.includes(episode.codeChange.file)) {
        this.context.filesWritten.push(episode.codeChange.file);
      }
    }

    // 记录读取的文件
    if (episode.toolName === "read_file" && episode.toolSuccess) {
      const file = episode.relatedFiles[0];
      if (file && !this.context.filesRead.includes(file)) {
        this.context.filesRead.push(file);
      }
    }

    // 记录已解决的错误
    if (!episode.toolSuccess && episode.toolName === "run_shell") {
      // 查找后续步骤中是否解决了（由后续 update 补充 fix）
      this.context.resolvedErrors.push({
        step: episode.stepNumber,
        error: episode.resultSummary,
        fix: "", // 后续步骤成功时回填
      });
    }

    this.context.totalFiles = Object.keys(this.context.knownFiles).length;
  }

  // 生成注入 context 的摘要（~200 token）
  getSummary(): string {
    const c = this.context;
    const lines: string[] = [];

    lines.push(`目标: ${c.userGoal}`);
    lines.push(`阶段: ${c.currentPhase} | 当前: ${c.currentStep}`);
    lines.push(`已完成: ${c.totalSteps} 步 | 涉及 ${c.totalFiles} 个文件`);

    if (c.filesWritten.length > 0) {
      lines.push(`已写入: ${c.filesWritten.slice(-5).join(", ")}`);
    }

    if (c.decisions.length > 0) {
      const recent = c.decisions.slice(-3);
      lines.push(`近期决策: ${recent.map(d => d.decision).join("; ")}`);
    }

    if (c.resolvedErrors.length > 0) {
      const recent = c.resolvedErrors.slice(-2);
      lines.push(`已解决: ${recent.map(e => e.error.slice(0, 50)).join("; ")}`);
    }

    return lines.join("\n");
  }

  async persist(): Promise<void> {
    await this.redis.setex(this.cacheKey, 3600, JSON.stringify(this.context));
  }

  async restore(): Promise<boolean> {
    const cached = await this.redis.get(this.cacheKey);
    if (cached) {
      this.context = JSON.parse(cached);
      return true;
    }
    return false;
  }

  setUserGoal(goal: string): void {
    this.context.userGoal = goal;
  }

  setPhase(phase: string): void {
    this.context.currentPhase = phase;
  }

  private createEmpty(projectId: string, runId: string): TaskContext {
    return {
      projectId,
      runId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userGoal: "",
      currentPhase: "planning",
      currentStep: "",
      knownFiles: {},
      decisions: [],
      resolvedErrors: [],
      totalSteps: 0,
      totalFiles: 0,
      filesWritten: [],
      filesRead: [],
    };
  }
}
```

### 4.3 跨 Run 恢复流程

改造 main.ts 中的 resume 逻辑：

```typescript
// main.ts 改造

// 旧方式：从 Redis 加载 raw messages
// const cached = await redis.get(`conversation:${config.projectId}`);

// 新方式：加载结构化数据
const recorder = new EpisodeRecorder(redis, config.projectId, config.runId);
const tracker = new TaskTracker(redis, config.projectId, config.runId);

if (config.mode === "iterate") {
  // 恢复 Episodes 和 TaskContext
  await recorder.restore();
  const hasContext = await tracker.restore();

  if (hasContext) {
    logger.info("Restored task context", {
      steps: tracker.getContext().totalSteps,
      files: tracker.getContext().totalFiles,
    });
  }
}

// assembler 在首次 LLM 调用时会自动利用这些数据组装 context
// 不再需要把整个 raw messages 数组传给 agentLoop
```

### 4.4 轻量反思（可选，每 5 步）

每 5 步用一次廉价 LLM 调用更新 TaskContext 中模型才能判断的字段：

```typescript
// 在 loop.ts 中，每 5 步触发一次
if (step % 5 === 0) {
  const reflection = await reflectOnProgress(client, model, {
    recentEpisodes: recorder.getAll().slice(-5),
    currentContext: tracker.getSummary(),
  });
  // reflection 返回: { currentStep, phase, decisions }
  tracker.setPhase(reflection.phase);
  tracker.setCurrentStep(reflection.currentStep);
  if (reflection.newDecision) {
    tracker.addDecision(step, reflection.newDecision, reflection.reason);
  }
}
```

反思的 prompt（~1K token input, ~200 token output，用 haiku 级模型）：

```
给定 Agent 最近 5 步的操作记录，请判断：
1. 当前处于什么阶段？(planning/implementing/debugging/polishing)
2. 当前正在做什么？(一句话)
3. 有没有做出重要的技术决策？如果有，是什么？为什么？

最近操作:
{episodes 的 formatEpisode}

当前上下文:
{tracker.getSummary()}
```

### 4.5 Layer 4 验证标准

- [ ] 多轮迭代场景：用户首次说"做一个博客"→ 完成 → 再说"加个暗色模式"
  - Agent 是否记得之前写了哪些文件、用了什么结构
  - 是否无需重新 list_files + read_file 就能直接修改
- [ ] TaskContext 摘要的信息密度评估（人工判断是否抓住了关键点）
- [ ] 反思调用的 token 成本统计（期望 < 总成本的 5%）

---

## Layer 5：预算感知的主动上下文管理

**目标**：从被动的"满了再处理"转为主动的"提前规划 token 分配"

**依赖**：Layer 1-4

### 5.1 Token Budget Manager

```typescript
// e2b-template/agent-runtime/src/budget-manager.ts

interface BudgetAllocation {
  system: number;        // system prompt + tools
  taskContext: number;   // TaskContext 摘要
  repoMap: number;       // 代码骨架
  recentHistory: number; // 最近 N 轮原文
  retrieval: number;     // 检索召回
  output: number;        // 预留给模型输出
}

class BudgetManager {
  private modelMaxTokens: number;
  private currentAllocation: BudgetAllocation;

  constructor(modelMaxTokens: number = 128000) {
    this.modelMaxTokens = modelMaxTokens;
    this.currentAllocation = this.defaultAllocation();
  }

  /**
   * 根据当前任务阶段动态调整分配
   */
  allocate(phase: string, stepCount: number, episodeCount: number): BudgetAllocation {
    const total = this.modelMaxTokens;
    const outputReserve = 4096;
    const systemReserve = 3500; // system prompt + tool definitions
    const available = total - outputReserve - systemReserve;

    switch (phase) {
      case "planning":
        // 规划阶段：更多给 repo map 和 task context
        return {
          system: systemReserve,
          taskContext: Math.min(500, available * 0.05),
          repoMap: Math.min(4000, available * 0.25),
          recentHistory: available * 0.40,
          retrieval: available * 0.30,
          output: outputReserve,
        };

      case "implementing":
        // 实现阶段：更多给最近历史（代码上下文）
        return {
          system: systemReserve,
          taskContext: Math.min(300, available * 0.03),
          repoMap: Math.min(1000, available * 0.08),
          recentHistory: available * 0.60,
          retrieval: available * 0.29,
          output: outputReserve,
        };

      case "debugging":
        // 调试阶段：更多给检索（需要找历史错误和相关代码）
        return {
          system: systemReserve,
          taskContext: Math.min(400, available * 0.04),
          repoMap: Math.min(1500, available * 0.10),
          recentHistory: available * 0.40,
          retrieval: available * 0.46,
          output: outputReserve,
        };

      default:
        return this.defaultAllocation();
    }
  }

  private defaultAllocation(): BudgetAllocation {
    const available = this.modelMaxTokens - 4096 - 3500;
    return {
      system: 3500,
      taskContext: 400,
      repoMap: 1500,
      recentHistory: available * 0.50,
      retrieval: available * 0.35,
      output: 4096,
    };
  }
}
```

### 5.2 "Context as a Tool" 模式

让 Agent 自己决定何时需要更多历史上下文：

```typescript
// 新增工具：recall_context
{
  type: "function" as const,
  function: {
    name: "recall_context",
    description: "从历史记录中召回相关信息。当你需要回忆之前做过什么、读过什么文件、或者遇到过什么问题时使用。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "你想回忆的内容描述，如'之前读 PaymentService 时看到了什么' 或 '上次构建失败的原因'",
        },
        type: {
          type: "string",
          enum: ["file_history", "error_history", "decision_history", "general"],
          description: "召回类型",
        },
      },
      required: ["query"],
    },
  },
}
```

执行实现：

```typescript
async function executeRecallContext(
  args: { query: string; type?: string },
  ctx: ToolContext,
  episodes: Episode[]
): Promise<ToolResult> {
  // 根据 query 和 type 在 episodes 中搜索
  const results: string[] = [];

  switch (args.type) {
    case "file_history":
      // 找出所有涉及特定文件的 episodes
      const filePattern = args.query.match(/[\w\/\-]+\.\w+/)?.[0];
      if (filePattern) {
        const relevant = episodes.filter(ep =>
          ep.relatedFiles.some(f => f.includes(filePattern))
        );
        for (const ep of relevant.slice(-10)) {
          results.push(formatEpisodeDetailed(ep));
        }
      }
      break;

    case "error_history":
      const errors = episodes.filter(ep => !ep.toolSuccess);
      for (const ep of errors.slice(-5)) {
        results.push(`[Step ${ep.stepNumber}] ${ep.toolName} FAILED: ${ep.resultSummary}`);
      }
      break;

    case "decision_history":
      // 从 TaskContext 中获取决策
      const decisions = taskTracker.getDecisions();
      for (const d of decisions) {
        results.push(`[Step ${d.step}] ${d.decision} (因为: ${d.reason})`);
      }
      break;

    default:
      // 通用搜索：关键词匹配
      const keywords = args.query.toLowerCase().split(/\s+/);
      const matches = episodes.filter(ep => {
        const text = `${ep.thinking} ${ep.resultSummary} ${ep.relatedFiles.join(" ")}`.toLowerCase();
        return keywords.some(k => text.includes(k));
      });
      for (const ep of matches.slice(-8)) {
        results.push(formatEpisodeDetailed(ep));
      }
  }

  if (results.length === 0) {
    return { success: true, output: "没有找到相关的历史记录。" };
  }

  return { success: true, output: results.join("\n\n") };
}
```

### 5.3 Layer 5 验证标准

- [ ] 预算分配是否真正适应任务阶段（通过 log 观察不同阶段的 allocation）
- [ ] recall_context 工具是否被 Agent 合理使用（不应过度使用，也不应需要时不用）
- [ ] 对比 Layer 4 vs Layer 5 在 30+ 步的长任务中的效果差异

---

## 文件变更清单（按 Layer 逐步实施）

### Layer 1

| 操作 | 文件 |
|------|------|
| 新建 | `agent-runtime/src/episode-recorder.ts` |
| 新建 | `agent-runtime/src/context-assembler.ts` |
| 新建 | `agent-runtime/src/types/episode.ts` |
| 修改 | `agent-runtime/src/loop.ts` — 替换 compressor 为 assembler + recorder |
| 修改 | `agent-runtime/src/main.ts` — 初始化 recorder，resume 时 restore |
| 保留 | `agent-runtime/src/context-compressor.ts` — 不删，用 flag 控制新旧切换 |

### Layer 2

| 操作 | 文件 |
|------|------|
| 新建 | `agent-runtime/tools/python/repomap_service.py` |
| 新建 | `agent-runtime/tools/python/requirements.txt` |
| 修改 | `agent-runtime/src/tools.ts` — 新增 get_repo_map + search_symbol |
| 修改 | `e2b-template/e2b.Dockerfile` — 加装 python3 + pip 依赖 |
| 修改 | `agent-runtime/src/context-assembler.ts` — Slot D repo map 注入 |

### Layer 3

| 操作 | 文件 |
|------|------|
| 修改 | `agent-runtime/src/episode-recorder.ts` — 增加符号提取 |
| 修改 | `agent-runtime/src/context-assembler.ts` — 多路召回 + 动态精度 |

### Layer 4

| 操作 | 文件 |
|------|------|
| 新建 | `agent-runtime/src/task-tracker.ts` |
| 新建 | `agent-runtime/src/types/task-context.ts` |
| 修改 | `agent-runtime/src/loop.ts` — 集成 tracker，可选反思 |
| 修改 | `agent-runtime/src/main.ts` — 跨 run 恢复 TaskContext |

### Layer 5

| 操作 | 文件 |
|------|------|
| 新建 | `agent-runtime/src/budget-manager.ts` |
| 修改 | `agent-runtime/src/tools.ts` — 新增 recall_context 工具 |
| 修改 | `agent-runtime/src/context-assembler.ts` — 接入 BudgetManager |

---

## 关键设计原则

1. **不改变 LLM 接口** — assembler 最终输出标准的 `messages[]`，对 llm-client.ts 完全透明
2. **不影响事件系统** — event-emitter.ts 零改动
3. **渐进式上线** — 用环境变量 `CONTEXT_V2=true` 控制，随时可回退到旧 compressor
4. **零额外 LLM 调用**（Layer 1-3） — 所有元数据提取和检索都是纯规则
5. **可观测** — 每步 log 输出 budget 分配、检索命中数、总 token 数

---

## 性能预期

| 指标 | 当前 (compressor) | Layer 1 | Layer 3 | Layer 5 |
|------|-------------------|---------|---------|---------|
| 信息保留率 | ~30% (旧信息被丢弃) | 100% | 100% | 100% |
| 每步额外延迟 | 0ms | <10ms | <15ms | <20ms |
| Token 利用效率 | 低（塞满但不精准） | 中 | 高 | 最优 |
| 跨 Run 记忆 | 无（只有 raw messages） | 有 Episodes | 有 Episodes + 符号 | 完整 TaskContext |
| 额外 LLM 成本 | 0 | 0 | 0 | ~5% (反思) |
| Agent 自主回忆 | 不可能 | 不可能 | 不可能 | 可以 (recall_context) |
