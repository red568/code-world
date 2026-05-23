/**
 * useProjectStream — 订阅项目 SSE 事件流的 React Hook
 *
 * 基于"轮次"模型：每个用户消息 + Agent 响应 = 一个 Round。
 * Agent 响应内部的步骤（spec、plan、codegen、build）作为子节点。
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

export type StepStatus = "active" | "done" | "error";

export interface AgentStep {
  id: number;
  type: "spec" | "plan" | "codegen" | "review" | "build" | "fix" | "done" | "error";
  label: string;
  detail?: string;
  status: StepStatus;
  files?: StreamFile[];
  buildLogs?: string[];
  reviewIssues?: ReviewIssue[];
}

export interface Round {
  id: number;
  userMessage: string;
  steps: AgentStep[];
  phase: ProjectPhase;
  previewUrl?: string | null;
  error?: string | null;
}

export interface StreamState {
  rounds: Round[];
  connected: boolean;
  phase: ProjectPhase;
  previewUrl: string | null;
}

// ─── Reducer ─────────────────────────────────────────────────────────────────────

let stepId = 0;
let roundId = 0;

type StreamAction =
  | { type: "CONNECTED" }
  | { type: "DISCONNECTED" }
  | { type: "ADD_USER_MESSAGE"; content: string }
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
  | { type: "RESET" }
  | { type: "LOAD_HISTORY"; rounds: Round[] };

const initialState: StreamState = {
  rounds: [],
  connected: false,
  phase: "idle",
  previewUrl: null,
};

function getCurrentRound(state: StreamState): Round | null {
  return state.rounds.length > 0 ? state.rounds[state.rounds.length - 1] : null;
}

function updateCurrentRound(state: StreamState, updater: (round: Round) => Round): StreamState {
  if (state.rounds.length === 0) {
    const placeholder: Round = {
      id: ++roundId,
      userMessage: "",
      steps: [],
      phase: "idle",
    };
    return { ...state, rounds: [updater(placeholder)] };
  }
  const rounds = [...state.rounds];
  rounds[rounds.length - 1] = updater(rounds[rounds.length - 1]);
  return { ...state, rounds };
}

function addStep(round: Round, type: AgentStep["type"], label: string, detail?: string): Round {
  return {
    ...round,
    steps: [...round.steps, { id: ++stepId, type, label, detail, status: "active" }],
  };
}

function finishStepByType(round: Round, type: AgentStep["type"]): Round {
  return {
    ...round,
    steps: round.steps.map((s) =>
      s.status === "active" && s.type === type ? { ...s, status: "done" as const } : s
    ),
  };
}

function finishAllSteps(round: Round): Round {
  return {
    ...round,
    steps: round.steps.map((s) => ({ ...s, status: s.status === "active" ? ("done" as const) : s.status })),
  };
}

function getActiveStep(round: Round, type: AgentStep["type"]): AgentStep | undefined {
  return round.steps.find((s) => s.type === type && s.status === "active");
}

function updateActiveStep(round: Round, type: AgentStep["type"], updater: (s: AgentStep) => AgentStep): Round {
  return {
    ...round,
    steps: round.steps.map((s) =>
      s.status === "active" && s.type === type ? updater(s) : s
    ),
  };
}

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "CONNECTED":
      return { ...state, connected: true };
    case "DISCONNECTED":
      return { ...state, connected: false };

    case "ADD_USER_MESSAGE": {
      const newRound: Round = {
        id: ++roundId,
        userMessage: action.content,
        steps: [],
        phase: "idle",
      };
      return { ...state, rounds: [...state.rounds, newRound] };
    }

    case "STATUS_CHANGE": {
      const phase = action.status as ProjectPhase;
      let newState = { ...state, phase };

      newState = updateCurrentRound(newState, (round) => {
        let r = { ...round, phase };
        if (action.status === "spec_generating") {
          r = addStep(r, "spec", "分析需求");
        } else if (action.status === "code_generating") {
          r = finishStepByType(r, "spec");
          if (!getActiveStep(r, "codegen")) {
            r = addStep(r, "codegen", "生成代码");
          }
        } else if (action.status === "reviewing") {
          r = finishStepByType(r, "codegen");
          r = addStep(r, "review", "审查代码");
        } else if (action.status === "building") {
          r = finishStepByType(r, "review");
          r = addStep(r, "build", "构建项目");
        } else if (action.status === "fixing") {
          r = finishStepByType(r, "build");
          r = addStep(r, "fix", "自动修复", action.message);
        } else if (action.status === "running") {
          r = finishAllSteps(r);
          r = addStep(r, "done", "预览就绪");
          r = finishAllSteps(r);
        } else if (action.status === "failed") {
          r = finishAllSteps(r);
          r = { ...r, error: action.message };
        }
        return r;
      });
      return newState;
    }

    case "SPEC_CHUNK":
      return updateCurrentRound(state, (round) =>
        updateActiveStep(round, "spec", (s) => ({
          ...s,
          detail: (s.detail || "") + action.chunk,
        }))
      );

    case "SPEC_DONE":
      return updateCurrentRound(state, (round) => finishStepByType(round, "spec"));

    case "PLAN_READY":
      return updateCurrentRound(state, (round) => {
        let r = finishStepByType(round, "spec");
        r = addStep(r, "plan", `规划完成（${action.fileCount} 个文件）`);
        r = finishStepByType(r, "plan");
        if (!getActiveStep(r, "codegen")) {
          r = addStep(r, "codegen", "生成代码", `${action.fileCount} 个文件`);
        }
        return r;
      });

    case "FILE_START":
      return updateCurrentRound(state, (round) =>
        updateActiveStep(round, "codegen", (s) => ({
          ...s,
          files: [...(s.files || []), { path: action.path, status: "generating" as const }],
        }))
      );

    case "FILE_DONE":
      return updateCurrentRound(state, (round) =>
        updateActiveStep(round, "codegen", (s) => ({
          ...s,
          files: (s.files || []).map((f) =>
            f.path === action.path ? { ...f, status: "done" as const } : f
          ),
        }))
      );

    case "CODEGEN_DONE":
      return updateCurrentRound(state, (round) => finishStepByType(round, "codegen"));

    case "CODEGEN_PROGRESS":
      return state;

    case "REVIEW_ISSUE":
      return updateCurrentRound(state, (round) =>
        updateActiveStep(round, "review", (s) => ({
          ...s,
          reviewIssues: [...(s.reviewIssues || []), action.issue],
        }))
      );

    case "REVIEW_DONE":
      return updateCurrentRound(state, (round) => finishStepByType(round, "review"));

    case "BUILD_LOG":
      return updateCurrentRound(state, (round) => {
        const buildStep = getActiveStep(round, "build") || getActiveStep(round, "fix");
        if (!buildStep) return round;
        return updateActiveStep(round, buildStep.type, (s) => ({
          ...s,
          buildLogs: [...(s.buildLogs || []), action.line],
        }));
      });

    case "FIX_START":
      return updateCurrentRound(state, (round) => {
        let r = finishStepByType(round, "build");
        r = finishStepByType(r, "fix");
        r = addStep(r, "fix", `自动修复（第 ${action.attempt} 轮）`, action.diagnosis);
        return r;
      });

    case "FIX_DONE":
      return updateCurrentRound(state, (round) => {
        let r = finishStepByType(round, "fix");
        if (action.success) return r;
        r = addStep(r, "build", "重新构建");
        return r;
      });

    case "PREVIEW_READY":
      return updateCurrentRound(
        { ...state, phase: "running", previewUrl: action.previewUrl },
        (round) => ({ ...round, phase: "running", previewUrl: action.previewUrl })
      );

    case "ERROR":
      return updateCurrentRound(
        { ...state, phase: "failed" },
        (round) => {
          let r = finishAllSteps(round);
          r = addStep(r, "error", action.message);
          r = finishAllSteps(r);
          return { ...r, phase: "failed", error: action.message };
        }
      );

    case "LOAD_HISTORY": {
      if (state.rounds.length === 1 && state.rounds[0].userMessage === "" && action.rounds.length > 0) {
        const merged = [...action.rounds];
        const last = merged[merged.length - 1];
        merged[merged.length - 1] = {
          ...last,
          steps: [...last.steps, ...state.rounds[0].steps],
          phase: state.rounds[0].phase !== "idle" ? state.rounds[0].phase : last.phase,
        };
        return { ...state, rounds: merged };
      }
      return { ...state, rounds: action.rounds };
    }

    case "RESET":
      stepId = 0;
      roundId = 0;
      return { ...initialState };

    default:
      return state;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────────

export function useProjectStream(projectId: string | null) {
  const [state, dispatch] = useReducer(streamReducer, initialState);

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);
  const addUserMessage = useCallback(
    (content: string) => dispatch({ type: "ADD_USER_MESSAGE", content }),
    []
  );
  const loadHistory = useCallback(
    (rounds: Round[]) => dispatch({ type: "LOAD_HISTORY", rounds }),
    []
  );

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

  return { state, reset, addUserMessage, loadHistory };
}
