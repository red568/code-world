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

function deriveStepStatus(phase: string, stepPhase: string, order: string[]): StepStatus {
  const currentIdx = order.indexOf(phase);
  const stepIdx = order.indexOf(stepPhase);
  if (currentIdx < 0) return "pending";
  if (stepIdx < currentIdx) return "done";
  if (stepIdx === currentIdx) return "active";
  return "pending";
}

function buildRounds(messages: Message[], streamState: StreamState): TRound[] {
  const rounds: TRound[] = [];
  const phaseOrder = ["spec_generating", "code_generating", "reviewing", "building", "running"];

  const userMessages = messages.filter((m) => m.role === "user");

  userMessages.forEach((msg, idx) => {
    const isCurrentRound = idx === userMessages.length - 1;

    if (!isCurrentRound) {
      rounds.push({
        id: idx,
        userMessage: msg.content,
        steps: [
          { id: `${idx}-done`, type: "preview", label: "已完成", status: "done" },
        ],
      });
      return;
    }

    const steps: TimelineStep[] = [];
    const phase = streamState.phase;
    const now = Date.now();

    const specStatus = phase === "idle" ? "pending" :
      phase === "spec_generating" ? "active" : "done";
    steps.push({
      id: `${idx}-spec`,
      type: "spec",
      label: "分析需求",
      status: specStatus,
      startedAt: specStatus !== "pending" ? now - 3000 : undefined,
      finishedAt: specStatus === "done" ? now - 2000 : undefined,
      detail: specStatus === "active" && streamState.specText
        ? streamState.specText.slice(0, 60) + "..."
        : undefined,
    });

    const planStatus = deriveStepStatus(phase, "code_generating", phaseOrder);
    const planActive = phase === "code_generating" && streamState.files.length === 0;
    steps.push({
      id: `${idx}-plan`,
      type: "plan",
      label: streamState.files.length > 0
        ? `规划文件（${streamState.files.length} 个）`
        : "规划文件",
      status: planActive ? "active" : (planStatus === "active" ? "done" : planStatus),
      startedAt: planStatus !== "pending" ? now - 1500 : undefined,
      finishedAt: planStatus === "done" || streamState.files.length > 0 ? now - 1000 : undefined,
    });

    if (streamState.files.length > 0 || phase === "code_generating") {
      const codegenDone = phaseOrder.indexOf(phase) > phaseOrder.indexOf("code_generating");
      const fileItems: TimelineFileItem[] = streamState.files.map((f) => ({
        path: f.path,
        status: f.status === "done" ? "done" as const : "generating" as const,
      }));
      const doneCount = fileItems.filter((f) => f.status === "done").length;
      steps.push({
        id: `${idx}-codegen`,
        type: "codegen",
        label: codegenDone
          ? `生成代码（${fileItems.length} 个文件）`
          : `生成代码（${doneCount}/${fileItems.length}）`,
        status: codegenDone ? "done" : phase === "code_generating" ? "active" : "pending",
        startedAt: phase === "code_generating" || codegenDone ? now - 5000 : undefined,
        finishedAt: codegenDone ? now - 500 : undefined,
        children: fileItems,
      });
    }

    const reviewStatus = deriveStepStatus(phase, "reviewing", phaseOrder);
    if (reviewStatus !== "pending" || phase === "reviewing") {
      steps.push({
        id: `${idx}-review`,
        type: "review",
        label: "审查代码",
        status: phase === "reviewing" ? "active" : reviewStatus,
        startedAt: reviewStatus !== "pending" ? now - 400 : undefined,
        finishedAt: reviewStatus === "done" ? now - 200 : undefined,
        detail: streamState.reviewIssues.length > 0
          ? `发现 ${streamState.reviewIssues.length} 个问题`
          : reviewStatus === "done" ? "通过，无问题" : undefined,
      });
    }

    if (streamState.fixAttempt > 0) {
      steps.push({
        id: `${idx}-fix-${streamState.fixAttempt}`,
        type: "fix",
        label: `自动修复（第 ${streamState.fixAttempt} 轮）`,
        status: phase === "fixing" ? "active" : "done",
        startedAt: now - 300,
        finishedAt: phase !== "fixing" ? now - 100 : undefined,
        detail: streamState.message || undefined,
      });
    }

    const buildStatus = deriveStepStatus(phase, "building", phaseOrder);
    if (buildStatus !== "pending" || phase === "building") {
      steps.push({
        id: `${idx}-build`,
        type: "build",
        label: "构建项目",
        status: phase === "building" || phase === "fixing" ? "active" : buildStatus,
        startedAt: buildStatus !== "pending" ? now - 200 : undefined,
        finishedAt: buildStatus === "done" && phase !== "fixing" ? now - 50 : undefined,
      });
    }

    if (phase === "running" || streamState.previewUrl) {
      steps.push({
        id: `${idx}-preview`,
        type: "preview",
        label: "预览就绪",
        status: "done",
        startedAt: now - 50,
        finishedAt: now,
        detail: "点击右侧面板查看",
      });
    }

    if (streamState.error) {
      const lastStep = steps[steps.length - 1];
      if (lastStep) lastStep.status = "error";
      steps.push({
        id: `${idx}-error`,
        type: "build",
        label: streamState.error,
        status: "error",
        startedAt: now,
        finishedAt: now,
      });
    }

    rounds.push({ id: idx, userMessage: msg.content, steps });
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
  }, [rounds, streamState.phase]);

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
