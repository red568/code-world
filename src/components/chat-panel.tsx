"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Send, Loader2, Sparkles, Square } from "lucide-react";
import { TimelineRound } from "@/components/timeline";
import { ClarificationCard, AskUserCard } from "@/components/clarification-card";
import type { StreamState, AgentStep } from "@/hooks/use-project-stream";
import type {
  TimelineRound as TRound,
  TimelineStep,
} from "@/components/timeline/types";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  projectId: string;
  messages: Message[];
  streamState: StreamState;
  isGenerating: boolean;
  analyzing?: boolean;
  onSend: (message: string, clarificationResponse?: Record<string, unknown>) => void;
  onStop: () => void;
  onAskUserAnswered?: () => void;
  currentRunId?: string;
}

function agentStepToTimelineStep(step: AgentStep): TimelineStep {
  const statusMap: Record<AgentStep["status"], TimelineStep["status"]> = {
    active: "active",
    done: "done",
    error: "error",
    stopped: "stopped",
  };
  return {
    id: String(step.id),
    type: step.type,
    label: step.label,
    status: statusMap[step.status],
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    detail: step.detail,
  };
}

function buildCurrentRoundSteps(streamState: StreamState, isGenerating: boolean, analyzing?: boolean): TimelineStep[] {
  const { steps, phase } = streamState;

  if (steps.length === 0 && isGenerating) {
    return [{
      id: "waiting",
      type: "thinking",
      label: analyzing ? "正在分析需求..." : "等待 Agent 响应...",
      status: "active",
      startedAt: Date.now(),
    }];
  }

  const timelineSteps = steps.map(agentStepToTimelineStep);

  if (phase === "failed" && !steps.some((s) => s.type === "error")) {
    timelineSteps.push({
      id: "final-error",
      type: "error",
      label: streamState.error || "生成失败",
      status: "error",
    });
  }

  return timelineSteps;
}

function buildHistoryRoundSteps(): TimelineStep[] {
  return [
    { id: "done", type: "preview", label: "已完成", status: "done" },
  ];
}

function buildRounds(messages: Message[], streamState: StreamState, isGenerating: boolean, analyzing?: boolean): TRound[] {
  const rounds: TRound[] = [];
  const userMessages = messages.filter((m) => m.role === "user");

  userMessages.forEach((msg, idx) => {
    const isCurrentRound = idx === userMessages.length - 1;
    rounds.push({
      id: idx,
      userMessage: msg.content,
      steps: isCurrentRound
        ? buildCurrentRoundSteps(streamState, isGenerating, analyzing)
        : buildHistoryRoundSteps(),
    });
  });

  return rounds;
}

export function ChatPanel({
  projectId,
  messages,
  streamState,
  isGenerating,
  analyzing,
  onSend,
  onStop,
  onAskUserAnswered,
  currentRunId,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [stopping, setStopping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rounds = useMemo(
    () => buildRounds(messages, streamState, isGenerating, analyzing),
    [messages, streamState, isGenerating, analyzing]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rounds, streamState.steps.length]);

  useEffect(() => {
    if (!isGenerating) setStopping(false);
  }, [isGenerating]);

  const handleStop = async () => {
    setStopping(true);
    onStop();
    try {
      await fetch(`/api/projects/${projectId}/stop`, { method: "POST" });
    } catch {
      // 静默处理
    } finally {
      setStopping(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isInputDisabled) return;
    onSend(input.trim());
    setInput("");
  };

  const isInputDisabled = isGenerating || streamState.phase === "waiting_for_clarification" || streamState.phase === "waiting_for_answer";

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {rounds.length === 0 && !streamState.clarification && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <Sparkles className="w-8 h-8 mb-3 text-gray-200" />
            <p className="text-sm">描述你想要的网站，AI 将为你生成</p>
          </div>
        )}

        {rounds.map((round) => (
          <TimelineRound key={round.id} round={round} />
        ))}

        {/* 前置澄清卡片 */}
        {streamState.clarification && (
          <ClarificationCard
            data={streamState.clarification}
            onSubmit={(selections) => {
              const lastUserMsg = messages.filter((m) => m.role === "user").pop();
              if (lastUserMsg) {
                onSend(lastUserMsg.content, {
                  selections,
                  rewritten_query: streamState.clarification?.rewritten_query,
                });
              }
            }}
            onSkip={() => {
              const lastUserMsg = messages.filter((m) => m.role === "user").pop();
              if (lastUserMsg) {
                onSend(lastUserMsg.content, { skip: true });
              }
            }}
          />
        )}

        {/* 过程中 ask_user 卡片 */}
        {streamState.askUser && (
          <AskUserCard
            data={streamState.askUser}
            projectId={projectId}
            runId={currentRunId}
            onAnswered={() => onAskUserAnswered?.()}
          />
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-100">
        <div className="relative bg-gray-50 rounded-xl border border-gray-200 focus-within:border-blue-300 focus-within:bg-white transition-colors">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isInputDisabled ? "生成中，请稍候..." : "描述你想要的网站..."}
            disabled={isInputDisabled}
            className="w-full pl-4 pr-12 py-3 text-sm text-gray-800 placeholder-gray-400 bg-transparent focus:outline-none disabled:text-gray-400"
          />
          {isGenerating ? (
            <button
              type="button"
              onClick={handleStop}
              disabled={stopping}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-red-500 hover:bg-red-600 disabled:bg-red-300 text-white rounded-lg flex items-center justify-center transition-colors"
              title="停止生成"
            >
              {stopping ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Square className="w-3 h-3 fill-current" />
              )}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 text-white rounded-lg flex items-center justify-center transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
