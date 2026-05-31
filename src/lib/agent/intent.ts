/**
 * 前置意图分析模块
 *
 * 在进入 Agent Loop 之前，分析用户输入的清晰度。
 * 模糊需求会生成选项让用户澄清，明确需求直接执行。
 */

import { chatCompletion } from "@/lib/llm/client";
import { safeJsonParse } from "@/lib/llm/json-parse";

// ─── 类型定义 ────────────────────────────────────────────────────────────────────

export interface ClarificationItem {
  aspect: string;
  question: string;
  options: string[];
}

export interface IntentAnalysis {
  clarity: "high" | "medium" | "low";
  intent: "build_new" | "modify_existing" | "explain" | "other";
  rewritten_query: string;
  missing_info: ClarificationItem[];
}

// ─── 快速跳过判断 ────────────────────────────────────────────────────────────────

export function shouldSkipIntentAnalysis(content: string, isFirstMessage: boolean): boolean {
  if (!isFirstMessage && content.length < 80) return true;
  if (/^(把|将|修改|删除|去掉|添加|加个|换成|改成)/.test(content)) return true;
  if (content.length < 30) return true;
  return false;
}

// ─── 意图分析 Prompt ─────────────────────────────────────────────────────────────

const INTENT_ANALYSIS_PROMPT = `你是一个需求分析助手。用户想要构建或修改一个网站。请分析用户的输入，判断需求是否足够清晰可以直接执行。

## 输出格式（严格 JSON，不要输出任何其他内容）

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
→ clarity: low, missing_info: [页面结构, 视觉风格, 行业/内容]

用户输入: "做一个简约风格的个人博客，要有文章列表和详情页"
→ clarity: high, missing_info: []

用户输入: "加个联系表单"
→ clarity: medium, missing_info: [表单字段/复杂度]`;

// ─── 主函数 ──────────────────────────────────────────────────────────────────────

export async function analyzeIntent(userInput: string): Promise<IntentAnalysis> {
  const raw = await chatCompletion(
    [
      { role: "system", content: INTENT_ANALYSIS_PROMPT },
      { role: "user", content: userInput },
    ],
    {
      temperature: 0.2,
      maxTokens: 1024,
      jsonMode: true,
      label: "intent-analysis",
    }
  );

  const parsed = safeJsonParse<IntentAnalysis>(raw, "intent-analysis");

  if (!parsed.clarity || !parsed.rewritten_query) {
    return {
      clarity: "high",
      intent: "other",
      rewritten_query: userInput,
      missing_info: [],
    };
  }

  if (parsed.rewritten_query.length > 500) {
    parsed.rewritten_query = parsed.rewritten_query.slice(0, 500);
  }

  if (parsed.missing_info && parsed.missing_info.length > 3) {
    parsed.missing_info = parsed.missing_info.slice(0, 3);
  }

  return parsed;
}

// ─── 增强 Prompt 拼装 ────────────────────────────────────────────────────────────

export function buildEnhancedPrompt(
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
