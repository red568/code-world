/**
 * Internal API: 上下文压缩
 *
 * 接收沙盒发来的全量历史 messages，存储后调 LLM 压缩，返回 summary。
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import OpenAI from "openai";

export async function POST(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    projectId: string;
    runId: string;
    messages: unknown[];
    previousSummary?: string;
    startStep: number;
    endStep: number;
    preserveHints?: {
      recentErrors?: boolean;
      keyDecisions?: boolean;
      fileModifications?: boolean;
    };
  };

  const { projectId, runId, messages, previousSummary, startStep, endStep, preserveHints } = body;

  if (!projectId || !runId || !messages) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // 1. 存全量历史（永不丢失）
  const tokenCount = estimateTokens(messages);
  await prisma.conversationHistory.create({
    data: {
      projectId,
      runId,
      messages: messages as any,
      startStep,
      endStep,
      tokenCount,
    },
  });

  // 2. 调 LLM 生成 summary
  const summary = await compressWithLLM(messages, previousSummary, preserveHints);

  // 3. 存压缩产物
  const prevCount = await prisma.compressionSummary.count({
    where: { projectId, runId },
  });

  const summaryTokens = Math.ceil(summary.length / 4);
  await prisma.compressionSummary.create({
    data: {
      projectId,
      runId,
      summary,
      summaryTokens,
      coversStepStart: 1,
      coversStepEnd: endStep,
      version: prevCount + 1,
      modelUsed: process.env.COMPRESSION_MODEL || process.env.LLM_MODEL || "deepseek-chat",
    },
  });

  return NextResponse.json({ summary, summaryTokens });
}

function estimateTokens(messages: unknown[]): number {
  const json = JSON.stringify(messages);
  return Math.ceil(json.length / 4);
}

async function compressWithLLM(
  messages: unknown[],
  previousSummary?: string,
  preserveHints?: { recentErrors?: boolean; keyDecisions?: boolean; fileModifications?: boolean }
): Promise<string> {
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  });

  const model = process.env.COMPRESSION_MODEL || process.env.LLM_MODEL || "deepseek-chat";

  const preserveInstructions: string[] = [];
  if (preserveHints?.recentErrors) {
    preserveInstructions.push("- 保留所有错误信息及其修复过程");
  }
  if (preserveHints?.keyDecisions) {
    preserveInstructions.push("- 保留关键设计/技术决策及其原因");
  }
  if (preserveHints?.fileModifications) {
    preserveInstructions.push("- 保留所有文件创建和修改的记录（路径 + 做了什么）");
  }

  const systemPrompt = `你是一个对话历史压缩专家。你的任务是将 Agent 的对话历史压缩为一份结构化摘要。

要求：
1. 摘要必须包含足够信息让 Agent 在只看摘要的情况下继续工作
2. 保留以下维度的信息：
   - 用户的原始需求和后续澄清
   - 已完成的工作（哪些文件被创建/修改，大致内容）
   - 关键技术决策（为什么选择某种方案）
   - 当前进度（做到哪一步了）
   - 遇到的错误和解决方式
   - 未完成的工作（如果有）
${preserveInstructions.length > 0 ? "\n特别要求：\n" + preserveInstructions.join("\n") : ""}

输出格式：
## 用户需求
（一句话总结）

## 已完成工作
- 文件: path — 做了什么
- ...

## 技术决策
- 决策: 原因
- ...

## 当前状态
（做到哪一步，下一步应该做什么）

## 错误与修复
（如果有）

## 未完成事项
（如果有）`;

  const conversationText = formatMessagesForCompression(messages);
  let userContent = `请压缩以下对话历史：\n\n${conversationText}`;

  if (previousSummary) {
    userContent = `之前的摘要（覆盖更早的历史）：\n${previousSummary}\n\n---\n\n请将以下新对话历史整合到摘要中：\n\n${conversationText}`;
  }

  // 截断以防 input 过大
  if (userContent.length > 200000) {
    userContent = userContent.slice(0, 200000) + "\n\n[... 内容过长已截断 ...]";
  }

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: 6000,
    temperature: 0.2,
  });

  return response.choices[0]?.message?.content || "压缩失败：无输出";
}

function formatMessagesForCompression(messages: unknown[]): string {
  const lines: string[] = [];

  for (const msg of messages as any[]) {
    if (!msg || !msg.role) continue;

    if (msg.role === "system") continue;

    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      lines.push(`[User] ${content.slice(0, 2000)}`);
    } else if (msg.role === "assistant") {
      if (msg.content) {
        lines.push(`[Assistant] ${String(msg.content).slice(0, 500)}`);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === "function") {
            const args = tc.function.arguments?.slice(0, 300) || "";
            lines.push(`[ToolCall] ${tc.function.name}(${args})`);
          }
        }
      }
    } else if (msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content : "";
      lines.push(`[ToolResult] ${content.slice(0, 500)}`);
    }
  }

  return lines.join("\n");
}
