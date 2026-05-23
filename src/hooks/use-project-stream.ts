/**
 * useProjectStream — 订阅项目 SSE 事件流的 React Hook
 *
 * 连接 /api/projects/:id/stream 端点，实时接收生成和构建事件。
 */

"use client";

import { useEffect, useCallback, useReducer } from "react";

// ─── 状态类型 ────────────────────────────────────────────────────────────────────

export type ProjectPhase =
  | "idle"
  | "spec_generating"
  | "code_generating"
  | "reviewing"
  | "building"
  | "fixing"
  | "running"
  | "failed";

export interface StreamFile {
  path: string;
  status: "generating" | "done";
}

export interface ReviewIssue {
  severity: string;
  file: string;
  problem: string;
}

// Agent 行为轨迹条目
export interface ActivityEntry {
  id: number;
  type: "thinking" | "file" | "command" | "review" | "error" | "success";
  label: string;
  detail?: string;
  status: "active" | "done";
}

export interface StreamState {
  phase: ProjectPhase;
  message: string;
  specText: string;
  files: StreamFile[];
  buildLogs: string[];
  reviewIssues: ReviewIssue[];
  fixAttempt: number;
  previewUrl: string | null;
  error: string | null;
  connected: boolean;
  codegenChars: number;
  activities: ActivityEntry[];
}

// ─── Reducer ─────────────────────────────────────────────────────────────────────

let activityId = 0;

type StreamAction =
  | { type: "CONNECTED" }
  | { type: "DISCONNECTED" }
  | { type: "STATUS_CHANGE"; status: string; message: string }
  | { type: "SPEC_CHUNK"; chunk: string }
  | { type: "SPEC_DONE" }
  | { type: "PLAN_READY"; fileCount: number; files: { path: string; role: string }[] }
  | { type: "CODEGEN_PROGRESS"; chars: number }
  | { type: "FILE_START"; path: string }
  | { type: "FILE_DONE"; path: string }
  | { type: "CODEGEN_DONE"; fileCount: number }
  | { type: "REVIEW_ISSUE"; issue: ReviewIssue }
  | { type: "REVIEW_DONE"; passed: boolean }
  | { type: "BUILD_LOG"; line: string }
  | { type: "FIX_START"; attempt: number; diagnosis: string }
  | { type: "FIX_DONE"; attempt: number; success: boolean }
  | { type: "PREVIEW_READY"; previewUrl: string }
  | { type: "ERROR"; message: string }
  | { type: "RESET" };

const initialState: StreamState = {
  phase: "idle",
  message: "",
  specText: "",
  files: [],
  buildLogs: [],
  reviewIssues: [],
  fixAttempt: 0,
  previewUrl: null,
  error: null,
  connected: false,
  codegenChars: 0,
  activities: [],
};

function addActivity(
  activities: ActivityEntry[],
  type: ActivityEntry["type"],
  label: string,
  detail?: string
): ActivityEntry[] {
  // Mark previous active entry of same type as done
  const updated = activities.map((a) =>
    a.status === "active" && a.type === type ? { ...a, status: "done" as const } : a
  );
  return [...updated, { id: ++activityId, type, label, detail, status: "active" }];
}

function finishActiveByType(activities: ActivityEntry[], type: ActivityEntry["type"]): ActivityEntry[] {
  return activities.map((a) =>
    a.status === "active" && a.type === type ? { ...a, status: "done" as const } : a
  );
}

function finishAll(activities: ActivityEntry[]): ActivityEntry[] {
  return activities.map((a) => ({ ...a, status: "done" as const }));
}

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "CONNECTED":
      return { ...state, connected: true };
    case "DISCONNECTED":
      return { ...state, connected: false };
    case "STATUS_CHANGE": {
      let acts = state.activities;
      if (action.status === "spec_generating") {
        acts = addActivity(acts, "thinking", "分析需求");
      } else if (action.status === "code_generating") {
        acts = finishActiveByType(acts, "thinking");
        acts = addActivity(acts, "thinking", "规划代码结构");
      } else if (action.status === "reviewing") {
        acts = finishActiveByType(acts, "thinking");
        acts = addActivity(acts, "review", "审查代码");
      } else if (action.status === "building") {
        acts = finishActiveByType(acts, "review");
        acts = addActivity(acts, "command", "构建项目", "npm run build");
      } else if (action.status === "fixing") {
        acts = finishActiveByType(acts, "command");
        acts = addActivity(acts, "thinking", `自动修复（第 ${state.fixAttempt + 1} 轮）`);
      } else if (action.status === "running") {
        acts = finishAll(acts);
        acts = addActivity(acts, "success", "预览就绪");
        acts = finishAll(acts);
      } else if (action.status === "failed") {
        acts = finishAll(acts);
        acts = addActivity(acts, "error", action.message);
        acts = finishAll(acts);
      }
      return { ...state, phase: action.status as ProjectPhase, message: action.message, activities: acts };
    }
    case "SPEC_CHUNK":
      return { ...state, phase: "spec_generating", specText: state.specText + action.chunk };
    case "SPEC_DONE":
      return { ...state, activities: finishActiveByType(state.activities, "thinking") };
    case "PLAN_READY": {
      let acts = finishActiveByType(state.activities, "thinking");
      acts = addActivity(acts, "thinking", `生成代码（${action.fileCount} 个文件）`);
      return { ...state, activities: acts };
    }
    case "CODEGEN_PROGRESS":
      return { ...state, codegenChars: action.chars };
    case "FILE_START": {
      const acts = addActivity(state.activities, "file", action.path);
      return {
        ...state,
        phase: "code_generating",
        files: [...state.files, { path: action.path, status: "generating" }],
        activities: acts,
      };
    }
    case "FILE_DONE": {
      const acts = state.activities.map((a) =>
        a.status === "active" && a.type === "file" && a.label === action.path
          ? { ...a, status: "done" as const }
          : a
      );
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.path ? { ...f, status: "done" as const } : f
        ),
        activities: acts,
      };
    }
    case "CODEGEN_DONE": {
      const acts = finishActiveByType(state.activities, "thinking");
      return { ...state, codegenChars: 0, activities: acts };
    }
    case "REVIEW_ISSUE":
      return {
        ...state,
        phase: "reviewing",
        reviewIssues: [...state.reviewIssues, action.issue],
      };
    case "REVIEW_DONE":
      return { ...state, activities: finishActiveByType(state.activities, "review") };
    case "BUILD_LOG":
      return {
        ...state,
        phase: state.phase === "fixing" ? "fixing" : "building",
        buildLogs: [...state.buildLogs, action.line],
      };
    case "FIX_START": {
      const acts = addActivity(state.activities, "thinking", `自动修复`, action.diagnosis);
      return { ...state, phase: "fixing", fixAttempt: action.attempt, message: action.diagnosis, activities: acts };
    }
    case "FIX_DONE":
      return { ...state, activities: finishActiveByType(state.activities, "thinking") };
    case "PREVIEW_READY":
      return { ...state, phase: "running", previewUrl: action.previewUrl };
    case "ERROR": {
      const acts = finishAll(state.activities);
      return { ...state, phase: "failed", error: action.message, activities: [...acts, { id: ++activityId, type: "error", label: action.message, status: "done" }] };
    }
    case "RESET":
      activityId = 0;
      return { ...initialState };
    default:
      return state;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────────

export function useProjectStream(projectId: string | null) {
  const [state, dispatch] = useReducer(streamReducer, initialState);

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  useEffect(() => {
    if (!projectId) return;

    dispatch({ type: "RESET" });

    const eventSource = new EventSource(`/api/projects/${projectId}/stream`);

    eventSource.addEventListener("connected", () => {
      dispatch({ type: "CONNECTED" });
    });

    eventSource.addEventListener("status_change", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "STATUS_CHANGE", status: data.status, message: data.message });
    });

    eventSource.addEventListener("spec_chunk", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "SPEC_CHUNK", chunk: data.chunk });
    });

    eventSource.addEventListener("spec_done", () => {
      dispatch({ type: "SPEC_DONE" });
    });

    eventSource.addEventListener("plan_ready", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "PLAN_READY", fileCount: data.fileCount, files: data.files });
    });

    eventSource.addEventListener("codegen_progress", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "CODEGEN_PROGRESS", chars: data.chars });
    });

    eventSource.addEventListener("codegen_file_start", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "FILE_START", path: data.path });
    });

    eventSource.addEventListener("codegen_file_done", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "FILE_DONE", path: data.path });
    });

    eventSource.addEventListener("codegen_done", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "CODEGEN_DONE", fileCount: data.fileCount });
    });

    eventSource.addEventListener("review_issue", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "REVIEW_ISSUE", issue: data });
    });

    eventSource.addEventListener("review_done", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "REVIEW_DONE", passed: data.passed });
    });

    eventSource.addEventListener("build_log", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "BUILD_LOG", line: data.line });
    });

    eventSource.addEventListener("fix_start", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "FIX_START", attempt: data.attempt, diagnosis: data.diagnosis });
    });

    eventSource.addEventListener("fix_done", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "FIX_DONE", attempt: data.attempt, success: data.success });
    });

    eventSource.addEventListener("preview_ready", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "PREVIEW_READY", previewUrl: data.previewUrl });
    });

    eventSource.addEventListener("error", (e) => {
      if (e instanceof MessageEvent) {
        const data = JSON.parse(e.data);
        dispatch({ type: "ERROR", message: data.message });
      } else {
        dispatch({ type: "DISCONNECTED" });
      }
    });

    return () => {
      eventSource.close();
    };
  }, [projectId]);

  return { state, reset };
}
