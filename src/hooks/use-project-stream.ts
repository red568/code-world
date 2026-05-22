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
}

// ─── Reducer ─────────────────────────────────────────────────────────────────────

type StreamAction =
  | { type: "CONNECTED" }
  | { type: "DISCONNECTED" }
  | { type: "STATUS_CHANGE"; status: string; message: string }
  | { type: "SPEC_CHUNK"; chunk: string }
  | { type: "SPEC_DONE" }
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
};

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "CONNECTED":
      return { ...state, connected: true };
    case "DISCONNECTED":
      return { ...state, connected: false };
    case "STATUS_CHANGE":
      return { ...state, phase: action.status as ProjectPhase, message: action.message };
    case "SPEC_CHUNK":
      return { ...state, phase: "spec_generating", specText: state.specText + action.chunk };
    case "SPEC_DONE":
      return { ...state };
    case "FILE_START":
      return {
        ...state,
        phase: "code_generating",
        files: [...state.files, { path: action.path, status: "generating" }],
      };
    case "FILE_DONE":
      return {
        ...state,
        files: state.files.map((f) =>
          f.path === action.path ? { ...f, status: "done" as const } : f
        ),
      };
    case "CODEGEN_DONE":
      return { ...state };
    case "REVIEW_ISSUE":
      return {
        ...state,
        phase: "reviewing",
        reviewIssues: [...state.reviewIssues, action.issue],
      };
    case "REVIEW_DONE":
      return { ...state };
    case "BUILD_LOG":
      return {
        ...state,
        phase: state.phase === "fixing" ? "fixing" : "building",
        buildLogs: [...state.buildLogs, action.line],
      };
    case "FIX_START":
      return { ...state, phase: "fixing", fixAttempt: action.attempt, message: action.diagnosis };
    case "FIX_DONE":
      return { ...state };
    case "PREVIEW_READY":
      return { ...state, phase: "running", previewUrl: action.previewUrl };
    case "ERROR":
      return { ...state, phase: "failed", error: action.message };
    case "RESET":
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
