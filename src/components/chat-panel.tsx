"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Send, Loader2, Sparkles } from "lucide-react";
import { TimelineRound } from "@/components/timeline";
import type { StreamState } from "@/hooks/use-project-stream";
import type {
  TimelineRound as TRound,
  TimelineStep,
  TimelineFileItem,
  StepStatus,
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

const PHASE_ORDER = [
  "spec_generating",
  "code_generating",
  "reviewing",
  "building",
  "running",
] as const;

function phaseIndex(phase: string): number {
  const idx = PHASE_ORDER.indexOf(phase as typeof PHASE_ORDER[number]);
  return idx >= 0 ? idx : -1;
}

function stepStatusFromPhase(currentPhase: string, stepPhase: string): StepStatus {
  if (currentPhase === "failed") return "error";
  const cur = phaseIndex(currentPhase);
  const step = phaseIndex(stepPhase);
  if (cur < 0) return "pending";
  if (step < cur) return "done";
  if (step === cur) return "active";
  return "pending";
}

function buildCurrentRoundSteps(streamState: StreamState): TimelineStep[] {
  const { phase, timestamps, files, reviewIssues, fixAttempt, message, error } = streamState;
  const steps: TimelineStep[] = [];

  const specTs = timestamps.spec_generating;
  steps.push({
    id: "spec",
    type: "spec",
    label: "分析需求",
    status: stepStatusFromPhase(phase, "spec_generating"),
    startedAt: specTs?.startedAt,
    finishedAt: specTs?.finishedAt,
    detail: phase === "spec_generating" && streamState.specText
      ? streamState.specText.slice(0, 80) + "..."
      : undefined,
  });

  const codeTs = timestamps.code_generating;
  const fileItems: TimelineFileItem[] = files.map((f) => ({
    path: f.path,
    status: f.status === "done" ? "done" as const : "generating" as const,
  }));
  const codegenStatus = stepStatusFromPhase(phase, "code_generating");

  steps.push({
    id: "plan",
    type: "plan",
    label: files.length > 0 ? `规划文件（${files.length} 个）` : "规划文件",
    status: codegenStatus === "pending" ? "pending" : "done",
    startedAt: codeTs?.startedAt,
    finishedAt: codeTs?.startedAt ? (codeTs.startedAt + 500) : undefined,
  });

  const doneCount = fileItems.filter((f) => f.status === "done").length;
  steps.push({
    id: "codegen",
    type: "codegen",
    label: codegenStatus === "done"
      ? `生成代码（${fileItems.length} 个文件）`
      : fileItems.length > 0
        ? `生成代码（${doneCount}/${fileItems.length}）`
        : "生成代码",
    status: codegenStatus,
    startedAt: codeTs?.startedAt,
    finishedAt: codeTs?.finishedAt,
    children: fileItems.length > 0 ? fileItems : undefined,
  });

  const reviewTs = timestamps.reviewing;
  steps.push({
    id: "review",
    type: "review",
    label: "审查代码",
    status: stepStatusFromPhase(phase, "reviewing"),
    startedAt: reviewTs?.startedAt,
    finishedAt: reviewTs?.finishedAt,
    detail: reviewIssues.length > 0
      ? `发现 ${reviewIssues.length} 个问题`
      : reviewTs?.finishedAt ? "通过" : undefined,
  });

  if (fixAttempt > 0) {
    const fixTs = timestamps.fixing;
    steps.push({
      id: `fix-${fixAttempt}`,
      type: "fix",
      label: `自动修复（第 ${fixAttempt} 轮）`,
      status: phase === "fixing" ? "active" : "done",
      startedAt: fixTs?.startedAt,
      finishedAt: fixTs?.finishedAt,
      detail: message || undefined,
    });
  }

  const buildTs = timestamps.building;
  steps.push({
    id: "build",
    type: "build",
    label: "构建项目",
    status: phase === "fixing"
      ? "active"
      : stepStatusFromPhase(phase, "building"),
    startedAt: buildTs?.startedAt,
    finishedAt: buildTs?.finishedAt,
  });

  const runTs = timestamps.running;
  steps.push({
    id: "preview",
    type: "preview",
    label: "预览就绪",
    status: phase === "running" ? "done" : "pending",
    startedAt: runTs?.startedAt,
    finishedAt: runTs?.finishedAt,
    detail: phase === "running" ? "点击右侧面板查看" : undefined,
  });

  if (error) {
    const activeStep = steps.find((s) => s.status === "active");
    if (activeStep) activeStep.status = "error";
  }

  return steps;
}

function buildHistoryRoundSteps(): TimelineStep[] {
  return [
    { id: "spec", type: "spec", label: "分析需求", status: "done" },
    { id: "plan", type: "plan", label: "规划文件", status: "done" },
    { id: "codegen", type: "codegen", label: "生成代码", status: "done" },
    { id: "review", type: "review", label: "审查代码", status: "done" },
    { id: "build", type: "build", label: "构建项目", status: "done" },
    { id: "preview", type: "preview", label: "预览就绪", status: "done" },
  ];
}

function buildRounds(messages: Message[], streamState: StreamState): TRound[] {
  const rounds: TRound[] = [];
  const userMessages = messages.filter((m) => m.role === "user");

  userMessages.forEach((msg, idx) => {
    const isCurrentRound = idx === userMessages.length - 1;
    rounds.push({
      id: idx,
      userMessage: msg.content,
      steps: isCurrentRound
        ? buildCurrentRoundSteps(streamState)
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
    () => buildRounds(messages, streamState),
    [messages, streamState]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rounds, streamState.phase, streamState.files]);

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
