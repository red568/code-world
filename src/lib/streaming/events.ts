/**
 * SSE 事件类型定义
 *
 * Worker 推送这些事件到 Redis pub/sub，
 * SSE 端点订阅并转发给浏览器。
 */

import { type ProjectStatus } from "@/generated/prisma/client";

export type SSEEvent =
  | { type: "status_change"; data: { status: ProjectStatus; message: string } }
  | { type: "spec_chunk"; data: { chunk: string } }
  | { type: "spec_done"; data: { specJson: Record<string, unknown> } }
  | { type: "plan_ready"; data: { fileCount: number; files: { path: string; role: string }[] } }
  | { type: "codegen_progress"; data: { chars: number } }
  | { type: "codegen_file_start"; data: { path: string } }
  | { type: "codegen_chunk"; data: { path: string; chunk: string } }
  | { type: "codegen_file_done"; data: { path: string } }
  | { type: "codegen_done"; data: { fileCount: number } }
  | { type: "review_issue"; data: { severity: string; file: string; problem: string } }
  | { type: "review_done"; data: { passed: boolean; issueCount: number } }
  | { type: "build_log"; data: { stream: "stdout" | "stderr"; line: string } }
  | { type: "fix_start"; data: { attempt: number; diagnosis: string } }
  | { type: "fix_done"; data: { attempt: number; success: boolean } }
  | { type: "preview_ready"; data: { previewUrl: string } }
  | { type: "error"; data: { message: string; code: string } }
  // Agent Loop 新增事件
  | { type: "agent_thinking"; data: { content: string } }
  | { type: "tool_call"; data: { tool: string; args: Record<string, unknown> } }
  | { type: "tool_result"; data: { tool: string; success: boolean; summary: string } }
  // Human-in-the-Loop 事件
  | { type: "clarification_needed"; data: {
      clarity: "medium" | "low";
      rewritten_query: string;
      missing_info: { aspect: string; question: string; options: string[] }[];
    }}
  | { type: "clarification_resolved"; data: { enhanced_prompt: string } }
  | { type: "ask_user"; data: {
      question: string;
      options: { label: string; description: string }[];
      context: string;
      answerToken: string;
    }};

/**
 * 获取项目事件的 Redis pub/sub 频道名
 */
export function getProjectChannel(projectId: string): string {
  return `project:${projectId}:events`;
}
