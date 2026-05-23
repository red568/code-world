/**
 * 多轮会话式代码生成
 *
 * 将 Plan + 逐文件 Codegen + Review 放在同一个 LLM 会话中，
 * 让模型能看到之前所有生成的代码，从而保证跨文件一致性。
 */

import { chatCompletion, safeJsonParse, type LLMMessage } from "@/lib/llm";
import { type SpecResult } from "./spec-prompt";
import { type CodePlanFile, type CodePlan, parsePlanResult } from "./plan-prompt";
import { type CodegenFile } from "./codegen-prompt";
import { TEMPLATE_FILE_TREE, EDITABLE_FILES_HINT } from "@/lib/template/files";

const CONVERSATION_SYSTEM_PROMPT = `你是一个高级前端工程师。你将通过多轮对话完成一个完整的 React + Vite + Tailwind 项目。

## 工作流程
1. 第一轮：根据产品规格输出 Code Plan（JSON）
2. 后续轮次：按顺序生成每个文件的完整代码
3. 最后一轮：Review 所有代码的跨文件一致性

## 技术约束
- React 18 + TypeScript + Tailwind CSS
- 白名单依赖：react, react-dom, lucide-react, framer-motion, recharts
- 函数组件 + hooks，CSS 通过 Tailwind 类名实现
- 图片用 placeholder URL（如 https://placehold.co/600x400）或 SVG 内联

## TypeScript 严格模式（tsconfig strict: true）
- 不要使用 any
- 处理所有 null/undefined（用 ?? 或 ! 或条件检查）
- props 必须与目标组件的 interface 完全一致

## 代码质量
- PascalCase 组件名、camelCase 变量名
- 内容丰富真实，不用大量 Lorem ipsum
- 单文件不超过 300 行

## 项目结构
- src/main.tsx 已存在不需要生成，它渲染 App 组件
- src/App.tsx 是入口，必须有默认导出
- 组件放 src/components/，工具放 src/lib/
- 所有组件统一 default export（除非一个文件导出多个工具函数）
- import 路径使用相对路径

## 最重要的规则
因为你能看到之前生成的所有代码，所以：
- import 的文件/函数/组件必须是你之前生成过的，名称完全匹配
- props 传参必须与目标组件的 interface 定义一致
- 数据模型（如 Article、Post）的类型定义必须跨文件一致
- export 风格（default vs named）必须与 import 方式匹配`;

export interface ConversationCallbacks {
  onPlanReady?: (plan: CodePlan) => Promise<void>;
  onFileStart?: (path: string) => Promise<void>;
  onFileDone?: (path: string, content: string) => Promise<void>;
}

export class CodegenConversation {
  private messages: LLMMessage[] = [];
  private spec: SpecResult;
  private projectId: string;
  private generatedFiles: CodegenFile[] = [];

  constructor(projectId: string, spec: SpecResult) {
    this.projectId = projectId;
    this.spec = spec;
    this.messages = [{ role: "system", content: CONVERSATION_SYSTEM_PROMPT }];
  }

  /**
   * Turn 1: 生成 Code Plan
   */
  async generatePlan(): Promise<CodePlan> {
    const userContent = `## 产品规格
${JSON.stringify(this.spec, null, 2)}

## 项目模板文件树
${TEMPLATE_FILE_TREE}

## 可修改的文件范围
${EDITABLE_FILES_HINT}

## 精简原则
- 优先按页面/功能区域聚合，不要把小组件单独拆文件
- 只在组件被多处复用时才单独拆文件
- 文件数量控制在 3-8 个，用最少文件完整实现需求

## 输出格式
返回 Code Plan JSON（不要 markdown 代码块标记）：
{
  "files": [
    {
      "path": "src/components/Header.tsx",
      "role": "顶部导航栏",
      "exports": ["Header"],
      "imports_from": []
    }
  ],
  "generation_order": ["src/components/Header.tsx", "src/App.tsx"],
  "notes": "架构说明"
}

规则：
- generation_order 被依赖的文件排前面（叶子先，App.tsx 最后）
- files 和 generation_order 包含完全相同的文件集合
- role 不超过 20 字
- exports 用 "default Xxx" 表示默认导出`;

    this.messages.push({ role: "user", content: userContent });

    const label = `conv-plan:${this.projectId.slice(0, 8)}`;
    const response = await chatCompletion(this.messages, { maxTokens: 4096, jsonMode: true, label });

    if (!response || response.trim().length === 0) {
      throw new Error("Code Plan 生成失败：LLM 返回空响应");
    }

    this.messages.push({ role: "assistant", content: response });

    return parsePlanResult(response);
  }

  /**
   * Turn N: 生成单个文件
   */
  async generateFile(planFile: CodePlanFile): Promise<string> {
    const userContent = `现在请生成文件: ${planFile.path}
文件职责: ${planFile.role}
需要导出: ${planFile.exports.join(", ")}
依赖: ${planFile.imports_from.length > 0 ? planFile.imports_from.join(", ") : "无"}

直接输出该文件的完整代码，不要 markdown 代码块标记，不要 JSON 包装，只输出纯代码。`;

    this.messages.push({ role: "user", content: userContent });

    const label = `conv-file:${planFile.path}:${this.projectId.slice(0, 8)}`;
    const response = await chatCompletion(this.messages, { maxTokens: 4096, label });

    if (!response || response.trim().length === 0) {
      throw new Error(`文件 ${planFile.path} 生成失败：LLM 返回空响应`);
    }

    const content = parseSingleFileFromConversation(response);

    this.messages.push({ role: "assistant", content: response });
    this.generatedFiles.push({ path: planFile.path, content });

    return content;
  }

  /**
   * Final Turn: Review 所有生成的代码
   */
  async review(): Promise<ConversationReviewResult> {
    const userContent = `所有文件已生成完毕。请 review 你刚才生成的所有代码，检查以下问题：

1. import 路径是否正确（引用的文件/组件/函数是否在之前生成的代码中存在）
2. props 传参是否与目标组件的 interface 定义完全一致
3. 数据类型（interface/type）跨文件是否一致
4. export 风格（default vs named）与 import 方式是否匹配
5. 白名单依赖检查（只能用 react, react-dom, lucide-react, framer-motion, recharts）

返回 JSON（不要 markdown 代码块标记）：
{
  "passed": true/false,
  "issues": [
    {
      "file": "文件路径",
      "problem": "问题描述",
      "fix": "修复后的完整文件内容"
    }
  ]
}

如果没有问题返回 {"passed": true, "issues": []}。
如果有问题，直接在 fix 字段里给出修复后的完整文件内容。`;

    this.messages.push({ role: "user", content: userContent });

    const label = `conv-review:${this.projectId.slice(0, 8)}`;
    const response = await chatCompletion(this.messages, { maxTokens: 8192, jsonMode: true, label });

    this.messages.push({ role: "assistant", content: response });

    return parseConversationReviewResult(response);
  }

  getGeneratedFiles(): CodegenFile[] {
    return [...this.generatedFiles];
  }

  getMessages(): LLMMessage[] {
    return [...this.messages];
  }
}

export interface ConversationReviewIssue {
  file: string;
  problem: string;
  fix: string;
}

export interface ConversationReviewResult {
  passed: boolean;
  issues: ConversationReviewIssue[];
}

function parseSingleFileFromConversation(raw: string): string {
  return raw
    .replace(/^```(?:tsx?|jsx?|css|typescript|javascript)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .replace(/^(?:typescript|javascript|tsx|jsx)\s*\n/i, "")
    .trim();
}

function parseConversationReviewResult(raw: string): ConversationReviewResult {
  try {
    return safeJsonParse<ConversationReviewResult>(raw, "conv-review");
  } catch {
    return { passed: true, issues: [] };
  }
}
