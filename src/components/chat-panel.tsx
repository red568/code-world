"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Send, Loader2, Sparkles } from "lucide-react";
import { TimelineRound } from "@/components/timeline";
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
  messages: Message[];
  streamState: StreamState;
  isGenerating: boolean;
  onSend: (message: string) => void;
}

function agentStepToTimelineStep(step: AgentStep): TimelineStep {
  return {
    id: String(step.id),
    type: step.type,
    label: step.label,
    status: step.status === "error" ? "error" : step.status === "done" ? "done" : "active",
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    detail: step.detail,
  };
}

function buildCurrentRoundSteps(streamState: StreamState, isGenerating: boolean): TimelineStep[] {
  const { steps, phase } = streamState;

  if (steps.length === 0 && isGenerating) {
    return [{
      id: "waiting",
      type: "thinking",
      label: "等待 Agent 响应...",
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

function buildRounds(messages: Message[], streamState: StreamState, isGenerating: boolean): TRound[] {
  const rounds: TRound[] = [];
  const userMessages = messages.filter((m) => m.role === "user");

  userMessages.forEach((msg, idx) => {
    const isCurrentRound = idx === userMessages.length - 1;
    rounds.push({
      id: idx,
      userMessage: msg.content,
      steps: isCurrentRound
        ? buildCurrentRoundSteps(streamState, isGenerating)
        : buildHistoryRoundSteps(),
    });
  });

  return rounds;
}

export function ChatPanel({
  messages,
  streamState,
  isGenerating,
  onSend,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const rounds = useMemo(
    () => buildRounds(messages, streamState, isGenerating),
    [messages, streamState, isGenerating]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rounds, streamState.steps.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isGenerating) return;
    onSend(input.trim());
    setInput("");
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {rounds.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <Sparkles className="w-8 h-8 mb-3 text-gray-200" />
            <p className="text-sm">描述你想要的网站，AI 将为你生成</p>
          </div>
        )}

        {rounds.map((round) => (
          <TimelineRound key={round.id} round={round} />
        ))}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-100">
        <div className="relative bg-gray-50 rounded-xl border border-gray-200 focus-within:border-blue-300 focus-within:bg-white transition-colors">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isGenerating ? "生成中，请稍候..." : "描述你想要的网站..."}
            disabled={isGenerating}
            className="w-full pl-4 pr-12 py-3 text-sm text-gray-800 placeholder-gray-400 bg-transparent focus:outline-none disabled:text-gray-400"
          />
          <button
            type="submit"
            disabled={!input.trim() || isGenerating}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 text-white rounded-lg flex items-center justify-center transition-colors"
          >
            {isGenerating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
