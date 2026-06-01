/**
 * useProjectStream — 订阅项目 SSE 事件流的 React Hook
 *
 * 连接 /api/projects/:id/stream 端点，实时接收 Agent Loop 事件。
 */

"use client";

import { useEffect, useCallback, useReducer } from "react";

// ─── 状态类型 ────────────────────────────────────────────────────────────────────

export type ProjectPhase =
  | "idle"
  | "code_generating"
  | "running"
  | "failed"
  | "waiting_for_clarification"
  | "waiting_for_answer";

export interface AgentStep {
  id: number;
  type: "thinking" | "file" | "command" | "read" | "preview" | "error" | "ask_user";
  label: string;
  detail?: string;
  status: "active" | "done" | "error" | "stopped";
  startedAt: number;
  finishedAt?: number;
}

export interface AskUserOption {
  label: string;
  description: string;
}

export interface ClarificationData {
  clarity: "medium" | "low";
  rewritten_query: string;
  missing_info: { aspect: string; question: string; options: string[] }[];
}

export interface AskUserData {
  question: string;
  options: AskUserOption[];
  context: string;
  answerToken: string;
}

export interface StreamState {
  phase: ProjectPhase;
  message: string;
  steps: AgentStep[];
  previewUrl: string | null;
  error: string | null;
  connected: boolean;
  clarification: ClarificationData | null;
  askUser: AskUserData | null;
}

// ─── Reducer ─────────────────────────────────────────────────────────────────────

let stepId = 0;

type StreamAction =
  | { type: "CONNECTED" }
  | { type: "DISCONNECTED" }
  | { type: "STATUS_CHANGE"; status: string; message: string }
  | { type: "AGENT_THINKING"; content: string }
  | { type: "TOOL_CALL"; tool: string; args: Record<string, unknown> }
  | { type: "TOOL_RESULT"; tool: string; success: boolean; summary: string }
  | { type: "FILE_START"; path: string }
  | { type: "FILE_DONE"; path: string }
  | { type: "BUILD_LOG"; line: string }
  | { type: "PREVIEW_READY"; previewUrl: string }
  | { type: "ERROR"; message: string }
  | { type: "CLARIFICATION_NEEDED"; data: ClarificationData }
  | { type: "CLARIFICATION_RESOLVED" }
  | { type: "ASK_USER"; data: AskUserData }
  | { type: "ASK_USER_ANSWERED" }
  | { type: "RESET" };

const initialState: StreamState = {
  phase: "idle",
  message: "",
  steps: [],
  previewUrl: null,
  error: null,
  connected: false,
  clarification: null,
  askUser: null,
};

function finishLastActive(steps: AgentStep[], type?: AgentStep["type"]): AgentStep[] {
  const now = Date.now();
  return steps.map((s) => {
    if (s.status !== "active") return s;
    if (type && s.type !== type) return s;
    return { ...s, status: "done" as const, finishedAt: now };
  });
}

function stopLastActive(steps: AgentStep[]): AgentStep[] {
  const now = Date.now();
  return steps.map((s) => {
    if (s.status !== "active") return s;
    return { ...s, status: "stopped" as const, finishedAt: now };
  });
}

function toolLabel(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "write_file":
      return `写入 ${(args.path as string) || "file"}`;
    case "read_file":
      return `读取 ${(args.path as string) || "file"}`;
    case "list_files":
      return "列出文件";
    case "run_shell":
      return `$ ${((args.command as string) || "").slice(0, 50)}`;
    case "get_preview_url":
      return "获取预览地址";
    case "ask_user":
      return "等待用户确认";
    default:
      return tool;
  }
}

function toolStepType(tool: string): AgentStep["type"] {
  switch (tool) {
    case "write_file":
      return "file";
    case "read_file":
    case "list_files":
      return "read";
    case "run_shell":
      return "command";
    case "get_preview_url":
      return "preview";
    case "ask_user":
      return "ask_user";
    default:
      return "command";
  }
}

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "CONNECTED":
      return { ...state, connected: true };
    case "DISCONNECTED":
      return { ...state, connected: false };

    case "STATUS_CHANGE": {
      const rawStatus = action.status;
      const isStopped = rawStatus === "stopped";
      const phase = (isStopped ? "idle" : rawStatus) as ProjectPhase;
      if (phase === "idle") {
        const steps = isStopped ? stopLastActive(state.steps) : finishLastActive(state.steps);
        return { ...state, phase, message: action.message, steps };
      }
      if (phase === "code_generating") {
        return {
          ...state,
          phase,
          message: action.message,
          steps: [],
          error: null,
          previewUrl: null,
        };
      }
      if (phase === "running") {
        const steps = finishLastActive(state.steps);
        return { ...state, phase, message: action.message, steps };
      }
      if (phase === "failed") {
        const steps = finishLastActive(state.steps);
        return { ...state, phase, message: action.message, steps };
      }
      return { ...state, phase, message: action.message };
    }

    case "AGENT_THINKING": {
      const steps = finishLastActive(state.steps, "thinking");
      const newStep: AgentStep = {
        id: ++stepId,
        type: "thinking",
        label: action.content.slice(0, 100),
        status: "active",
        startedAt: Date.now(),
      };
      return { ...state, steps: [...steps, newStep] };
    }

    case "TOOL_CALL": {
      const steps = finishLastActive(state.steps, "thinking");
      const newStep: AgentStep = {
        id: ++stepId,
        type: toolStepType(action.tool),
        label: toolLabel(action.tool, action.args),
        status: "active",
        startedAt: Date.now(),
      };
      return { ...state, steps: [...steps, newStep] };
    }

    case "TOOL_RESULT": {
      const targetType = toolStepType(action.tool);
      const now = Date.now();
      const steps = state.steps.map((s) => {
        if (s.status !== "active" || s.type !== targetType) return s;
        return {
          ...s,
          status: (action.success ? "done" : "error") as AgentStep["status"],
          finishedAt: now,
          detail: action.success ? undefined : action.summary.slice(0, 80),
        };
      });
      return { ...state, steps };
    }

    case "FILE_START": {
      const steps = finishLastActive(state.steps, "thinking");
      const newStep: AgentStep = {
        id: ++stepId,
        type: "file",
        label: `写入 ${action.path}`,
        status: "active",
        startedAt: Date.now(),
      };
      return { ...state, steps: [...steps, newStep] };
    }

    case "FILE_DONE": {
      const now = Date.now();
      const steps = state.steps.map((s) => {
        if (s.status === "active" && s.type === "file" && s.label.includes(action.path)) {
          return { ...s, status: "done" as const, finishedAt: now };
        }
        return s;
      });
      return { ...state, steps };
    }

    case "BUILD_LOG":
      return state;

    case "PREVIEW_READY": {
      const steps = finishLastActive(state.steps);
      const newStep: AgentStep = {
        id: ++stepId,
        type: "preview",
        label: "预览就绪",
        status: "done",
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      return { ...state, phase: "running", previewUrl: action.previewUrl, steps: [...steps, newStep] };
    }

    case "ERROR": {
      const steps = finishLastActive(state.steps);
      const newStep: AgentStep = {
        id: ++stepId,
        type: "error",
        label: action.message.slice(0, 80),
        status: "error",
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      return { ...state, phase: "failed", error: action.message, steps: [...steps, newStep] };
    }

    case "RESET":
      stepId = 0;
      return { ...initialState };

    case "CLARIFICATION_NEEDED":
      return { ...state, phase: "waiting_for_clarification", clarification: action.data };

    case "CLARIFICATION_RESOLVED":
      return { ...state, phase: "code_generating", clarification: null };

    case "ASK_USER": {
      const steps = finishLastActive(state.steps, "thinking");
      const newStep: AgentStep = {
        id: ++stepId,
        type: "ask_user",
        label: action.data.question.slice(0, 60),
        status: "active",
        startedAt: Date.now(),
      };
      return { ...state, phase: "waiting_for_answer", askUser: action.data, steps: [...steps, newStep] };
    }

    case "ASK_USER_ANSWERED": {
      const now = Date.now();
      const steps = state.steps.map((s) => {
        if (s.status === "active" && s.type === "ask_user") {
          return { ...s, status: "done" as const, finishedAt: now };
        }
        return s;
      });
      return { ...state, phase: "code_generating", askUser: null, steps };
    }

    default:
      return state;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────────

export function useProjectStream(projectId: string | null) {
  const [state, dispatch] = useReducer(streamReducer, initialState);

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);
  const forceIdle = useCallback(
    () => dispatch({ type: "STATUS_CHANGE", status: "stopped", message: "已停止" }),
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

    eventSource.addEventListener("agent_thinking", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "AGENT_THINKING", content: data.content });
    });

    eventSource.addEventListener("tool_call", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "TOOL_CALL", tool: data.tool, args: data.args || {} });
    });

    eventSource.addEventListener("tool_result", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "TOOL_RESULT", tool: data.tool, success: data.success, summary: data.summary || "" });
    });

    eventSource.addEventListener("codegen_file_start", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "FILE_START", path: data.path });
    });

    eventSource.addEventListener("codegen_file_done", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "FILE_DONE", path: data.path });
    });

    eventSource.addEventListener("build_log", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "BUILD_LOG", line: data.line });
    });

    eventSource.addEventListener("preview_ready", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "PREVIEW_READY", previewUrl: data.previewUrl });
    });

    eventSource.addEventListener("clarification_needed", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "CLARIFICATION_NEEDED", data });
    });

    eventSource.addEventListener("clarification_resolved", () => {
      dispatch({ type: "CLARIFICATION_RESOLVED" });
    });

    eventSource.addEventListener("ask_user", (e) => {
      const data = JSON.parse(e.data);
      dispatch({ type: "ASK_USER", data });
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

  return { state, reset, forceIdle };
}
