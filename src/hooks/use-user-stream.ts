/**
 * 用户级实时流 Hook
 *
 * 单 SSE 连接接收用户所有项目的事件，按 projectId 分发状态。
 */

"use client";

import { useEffect, useState } from "react";

export interface ProjectState {
  status?: string;
  currentStep?: number;
  currentTool?: string;
  previewUrl?: string;
  lastUpdate?: number;
  finishedAt?: string;
  error?: string;
  pauseReason?: string;
  canResume?: boolean;
}

interface AgentEvent {
  projectId: string;
  userId: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
  step?: number;
}

interface HitlQuestion {
  runId: string;
  projectId: string;
  question: string;
  options: { label: string; description: string }[];
  askCount: number;
}

export function useUserStream(userId?: string) {
  const [projectStates, setProjectStates] = useState<Record<string, ProjectState>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState<HitlQuestion | null>(null);

  useEffect(() => {
    // 1. 加载初始状态
    async function loadInitialStates() {
      try {
        const response = await fetch("/api/projects/states");
        if (response.ok) {
          const states = await response.json();
          setProjectStates(states);
        }
      } catch (error) {
        console.error("[Stream] Failed to load initial states:", error);
      }
    }

    loadInitialStates();

    // 2. 建立 SSE 连接
    const params = userId ? `?userId=${userId}` : "";
    const eventSource = new EventSource(`/api/stream/user${params}`);

    eventSource.onopen = () => {
      setIsConnected(true);
      console.log("[Stream] User stream connected");
    };

    eventSource.addEventListener("message", (e) => {
      const event: AgentEvent = JSON.parse(e.data);
      const { projectId, type, data } = event;

      setProjectStates((prev) => {
        const projectState = prev[projectId] || {};

        switch (type) {
          case "status_change":
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                status: data.status as string,
                lastUpdate: Date.now(),
              },
            };

          case "tool_call":
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                currentTool: data.tool as string,
                lastUpdate: Date.now(),
              },
            };

          case "tool_result":
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                currentTool: undefined,
                lastUpdate: Date.now(),
              },
            };

          case "preview_ready":
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                previewUrl: data.previewUrl as string,
                lastUpdate: Date.now(),
              },
            };

          case "HITL_QUESTION":
            setActiveQuestion({
              runId: event.runId,
              projectId,
              question: data.question as string,
              options: data.options as HitlQuestion["options"],
              askCount: data.askCount as number,
            });
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                status: "paused",
                lastUpdate: Date.now(),
              },
            };

          case "RUN_PAUSED":
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                status: "paused",
                pauseReason: data.reason as string,
                canResume: data.canResume as boolean,
                lastUpdate: Date.now(),
              },
            };

          case "error":
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                status: "failed",
                error: data.message as string,
                lastUpdate: Date.now(),
              },
            };

          default:
            return {
              ...prev,
              [projectId]: {
                ...projectState,
                lastUpdate: Date.now(),
              },
            };
        }
      });
    });

    eventSource.onerror = () => {
      setIsConnected(false);
      console.error("[Stream] User stream error");
    };

    return () => eventSource.close();
  }, [userId]);

  return { projectStates, isConnected, activeQuestion, setActiveQuestion };
}
