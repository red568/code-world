/**
 * 模式选择器
 *
 * 分析用户 prompt，决定使用 Plan 模式还是 ReAct 模式。
 * 多维度分析：任务类型、依赖关系、明确性、预估步骤数。
 */

import type OpenAI from "openai";
import { chatCompletionJSON } from "./llm-client.js";
import type { RuntimeConfig } from "./types.js";

export type AgentMode = "plan" | "react";

interface ModeAnalysis {
  mode: AgentMode;
  reason: string;
  estimatedSteps: number;
}

const MODE_ANALYSIS_PROMPT = `你是一个任务分析器。分析用户的需求，决定应该使用哪种执行模式。

**Plan 模式**：适合多功能组合型任务（需要 5+ 步骤，有强依赖链）
**ReAct 模式**：适合单一操作、探索型任务、需求模糊的任务

分析维度：
1. 任务类型：单一操作 → ReAct，多功能组合 → Plan，探索型 → ReAct
2. 依赖关系：无依赖 → ReAct，强依赖链 → Plan
3. 明确性：需求明确且复杂 → Plan，需求模糊 → ReAct
4. 预估步骤数：≤5 → ReAct，>5 → Plan

返回 JSON 格式：
{
  "mode": "plan" | "react",
  "reason": "一句话解释",
  "estimatedSteps": <number>
}`;

export async function selectMode(
  client: OpenAI,
  model: string,
  userPrompt: string,
  config: RuntimeConfig
): Promise<ModeAnalysis> {
  // 短消息直接 ReAct
  if (userPrompt.length < 50) {
    return { mode: "react", reason: "短消息，直接执行", estimatedSteps: 3 };
  }

  try {
    const response = await chatCompletionJSON(client, model, [
      { role: "system", content: MODE_ANALYSIS_PROMPT },
      { role: "user", content: userPrompt },
    ], { maxTokens: 200, temperature: 0.1 });

    const analysis = JSON.parse(response) as ModeAnalysis;

    // 验证结果合理性
    if (analysis.mode !== "plan" && analysis.mode !== "react") {
      return { mode: "react", reason: "fallback", estimatedSteps: 5 };
    }

    return analysis;
  } catch {
    // 分析失败，默认 ReAct
    return { mode: "react", reason: "analysis failed, fallback to react", estimatedSteps: 5 };
  }
}

export function getPlanModeSystemAddition(): string {
  return `

## Plan 模式

你正在 Plan 模式下工作。请先调用 create_plan 创建执行计划，等待用户确认后再开始执行。
执行过程中：
- 每开始一个步骤，调用 update_plan_step 标记为 running
- 每完成一个步骤，调用 update_plan_step 标记为 completed
- 如果发现遗漏，调用 add_plan_step 添加步骤
- 如果需要大幅调整，调用 replan_from_step 重新规划

可用的计划管理工具：create_plan, update_plan_step, add_plan_step, replan_from_step, get_plan_status`;
}
