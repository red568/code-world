"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Loader2,
  Bot,
  User,
  FileCode,
  Terminal,
  Search,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Wrench,
  Sparkles,
  Hammer,
} from "lucide-react";
import type { Round, AgentStep, StreamState } from "@/hooks/use-project-stream";

interface ChatPanelProps {
  rounds: Round[];
  phase: StreamState["phase"];
  isGenerating: boolean;
  onSend: (message: string) => void;
}

const STEP_ICONS: Record<AgentStep["type"], React.ReactNode> = {
  spec: <Sparkles className="w-3.5 h-3.5" />,
  plan: <FileCode className="w-3.5 h-3.5" />,
  codegen: <FileCode className="w-3.5 h-3.5" />,
  review: <Search className="w-3.5 h-3.5" />,
  build: <Hammer className="w-3.5 h-3.5" />,
  fix: <Wrench className="w-3.5 h-3.5" />,
  done: <CheckCircle2 className="w-3.5 h-3.5" />,
  error: <XCircle className="w-3.5 h-3.5" />,
};

const STEP_COLORS: Record<AgentStep["type"], string> = {
  spec: "text-blue-500",
  plan: "text-violet-500",
  codegen: "text-violet-500",
  review: "text-cyan-500",
  build: "text-amber-500",
  fix: "text-orange-500",
  done: "text-green-500",
  error: "text-red-500",
};

export function ChatPanel({ rounds, phase, isGenerating, onSend }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rounds]);

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
            <p className="text-sm">对话内容将显示在这里</p>
          </div>
        )}

        {rounds.map((round) => (
          <RoundItem key={round.id} round={round} />
        ))}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-100">
        <div className="relative bg-gray-50 rounded-xl border border-gray-200 focus-within:border-blue-300 focus-within:bg-white transition-colors">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isGenerating ? "生成中，请稍候..." : "描述修改需求..."}
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

function RoundItem({ round }: { round: Round }) {
  return (
    <div className="space-y-3">
      {/* User message */}
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-gray-100">
          <User className="w-3.5 h-3.5 text-gray-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-400 mb-1">你</p>
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
            {round.userMessage}
          </p>
        </div>
      </div>

      {/* Agent response with steps */}
      {round.steps.length > 0 && (
        <div className="flex gap-3">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-gradient-to-br from-blue-500 to-purple-600">
            <Bot className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-gray-400 mb-2">AI</p>
            <AgentSteps steps={round.steps} />
            {round.error && (
              <div className="mt-2 bg-red-50 border border-red-100 rounded-lg p-2.5">
                <div className="flex items-center gap-2">
                  <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                  <span className="text-xs text-red-600">{round.error}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentSteps({ steps }: { steps: AgentStep[] }) {
  return (
    <div className="space-y-1">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const shouldExpand = isLast && step.status === "active";
        return <StepItem key={step.id} step={step} expanded={shouldExpand} />;
      })}
    </div>
  );
}

function StepItem({ step, expanded }: { step: AgentStep; expanded: boolean }) {
  const [manualExpand, setManualExpand] = useState(false);
  const isOpen = expanded || manualExpand;
  const hasContent = (step.files && step.files.length > 0) ||
    (step.buildLogs && step.buildLogs.length > 0) ||
    (step.reviewIssues && step.reviewIssues.length > 0);

  return (
    <div className="group">
      <div
        className={`flex items-center gap-2 py-1.5 px-2 rounded-md transition-colors ${
          step.status === "active" ? "bg-blue-50/50" : "hover:bg-gray-50"
        } ${hasContent ? "cursor-pointer" : ""}`}
        onClick={() => hasContent && setManualExpand(!manualExpand)}
        role={hasContent ? "button" : undefined}
      >
        <span className={`flex-shrink-0 ${STEP_COLORS[step.type]}`}>
          {step.status === "active" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            STEP_ICONS[step.type]
          )}
        </span>

        <span className={`text-xs flex-1 ${
          step.status === "active" ? "text-gray-700 font-medium" : "text-gray-500"
        }`}>
          {step.label}
        </span>

        {step.status === "done" && step.type !== "done" && step.type !== "error" && (
          <CheckCircle2 className="w-3 h-3 text-green-400" />
        )}

        {hasContent && (
          <ChevronDown className={`w-3 h-3 text-gray-300 transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`} />
        )}
      </div>

      <AnimatePresence>
        {isOpen && hasContent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="ml-6 pl-2 border-l-2 border-gray-100 pb-1 space-y-1.5">
              {step.files && step.files.length > 0 && (
                <ul className="space-y-0.5">
                  {step.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-2 py-0.5">
                      {f.status === "done" ? (
                        <CheckCircle2 className="w-3 h-3 text-green-500" />
                      ) : (
                        <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />
                      )}
                      <span className="text-[11px] font-mono text-gray-500 truncate">{f.path}</span>
                    </li>
                  ))}
                </ul>
              )}

              {step.reviewIssues && step.reviewIssues.length > 0 && (
                <ul className="space-y-1">
                  {step.reviewIssues.map((issue, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <XCircle className="w-3 h-3 text-red-400 mt-0.5 flex-shrink-0" />
                      <span className="text-[11px] text-gray-500">
                        <span className="font-mono">{issue.file}</span>: {issue.problem}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {step.buildLogs && step.buildLogs.length > 0 && (
                <div className="bg-gray-900 rounded-md p-2 max-h-32 overflow-y-auto">
                  <pre className="text-[10px] text-green-400 font-mono whitespace-pre-wrap leading-4">
                    {step.buildLogs.slice(-40).join("\n")}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
