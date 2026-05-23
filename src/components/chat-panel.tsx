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
  Brain,
  Sparkles,
  ChevronDown,
  AlertTriangle,
  Wrench,
} from "lucide-react";
import type { ActivityEntry, StreamState } from "@/hooks/use-project-stream";

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

const ACTIVITY_ICONS: Record<ActivityEntry["type"], React.ReactNode> = {
  thinking: <Brain className="w-3.5 h-3.5" />,
  file: <FileCode className="w-3.5 h-3.5" />,
  command: <Terminal className="w-3.5 h-3.5" />,
  review: <Search className="w-3.5 h-3.5" />,
  error: <XCircle className="w-3.5 h-3.5" />,
  success: <CheckCircle2 className="w-3.5 h-3.5" />,
};

const ACTIVITY_COLORS: Record<ActivityEntry["type"], string> = {
  thinking: "text-blue-500",
  file: "text-violet-500",
  command: "text-amber-500",
  review: "text-cyan-500",
  error: "text-red-500",
  success: "text-green-500",
};

function ActivityTrail({ activities, codegenChars }: { activities: ActivityEntry[]; codegenChars: number }) {
  if (activities.length === 0) return null;

  return (
    <div className="ml-10 mt-2 space-y-1">
      <AnimatePresence initial={false}>
        {activities.map((act) => (
          <motion.div
            key={act.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-2 py-1"
          >
            <span className={`flex-shrink-0 ${ACTIVITY_COLORS[act.type]}`}>
              {ACTIVITY_ICONS[act.type]}
            </span>
            <span className="text-xs text-gray-600">{act.label}</span>
            {act.detail && (
              <span className="text-xs text-gray-400 truncate max-w-[140px]">
                {act.detail}
              </span>
            )}
            {act.status === "active" && (
              <Loader2 className="w-3 h-3 text-gray-400 animate-spin ml-auto" />
            )}
            {act.status === "done" && act.type !== "error" && (
              <CheckCircle2 className="w-3 h-3 text-green-400 ml-auto" />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
      {codegenChars > 0 && (
        <div className="flex items-center gap-2 py-1 text-xs text-gray-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>已生成 {(codegenChars / 1000).toFixed(1)}k 字符...</span>
        </div>
      )}
    </div>
  );
}

export function ChatPanel({
  messages,
  streamState,
  isGenerating,
  onSend,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamState.activities, streamState.specText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isGenerating) return;
    onSend(input.trim());
    setInput("");
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {messages.length === 0 && !streamState.specText && streamState.activities.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <Sparkles className="w-8 h-8 mb-3 text-gray-200" />
            <p className="text-sm">对话内容将显示在这里</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className="flex gap-3">
            <div
              className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
                msg.role === "user"
                  ? "bg-gray-100"
                  : "bg-gradient-to-br from-blue-500 to-purple-600"
              }`}
            >
              {msg.role === "user" ? (
                <User className="w-3.5 h-3.5 text-gray-600" />
              ) : (
                <Bot className="w-3.5 h-3.5 text-white" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-400 mb-1">
                {msg.role === "user" ? "你" : "AI"}
              </p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                {msg.content}
              </p>
            </div>
          </div>
        ))}

        {/* Spec streaming */}
        {streamState.specText && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-gradient-to-br from-blue-500 to-purple-600">
              <Bot className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-blue-500 mb-1">正在分析需求...</p>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                <p className="text-xs text-gray-600 font-mono whitespace-pre-wrap leading-relaxed">
                  {streamState.specText}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Activity trail — appears as AI doing things */}
        {streamState.activities.length > 0 && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-gradient-to-br from-blue-500 to-purple-600">
              <Bot className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-400 mb-1">Agent 行为轨迹</p>
              <ActivityTrail
                activities={streamState.activities}
                codegenChars={streamState.codegenChars}
              />

              {/* Collapsible details */}
              <div className="mt-3 space-y-2">
                {streamState.files.length > 0 && (
                  <CollapsibleSection title={`文件 (${streamState.files.length})`}>
                    <ul className="space-y-1">
                      {streamState.files.map((f) => (
                        <li key={f.path} className="flex items-center gap-2">
                          {f.status === "done" ? (
                            <CheckCircle2 className="w-3 h-3 text-green-500" />
                          ) : (
                            <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />
                          )}
                          <span className="text-xs font-mono text-gray-600 truncate">{f.path}</span>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleSection>
                )}

                {streamState.reviewIssues.length > 0 && (
                  <CollapsibleSection title={`审查问题 (${streamState.reviewIssues.length})`}>
                    <ul className="space-y-1.5">
                      {streamState.reviewIssues.map((issue, i) => (
                        <li key={i} className="flex items-start gap-2">
                          {issue.severity === "error" ? (
                            <XCircle className="w-3 h-3 text-red-500 mt-0.5 flex-shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3 h-3 text-yellow-500 mt-0.5 flex-shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className="text-xs font-mono text-gray-500">{issue.file}</span>
                            <p className="text-xs text-gray-600">{issue.problem}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleSection>
                )}

                {streamState.fixAttempt > 0 && (
                  <div className="flex items-center gap-2 py-1">
                    <Wrench className="w-3 h-3 text-orange-500" />
                    <span className="text-xs text-gray-600">
                      自动修复 第 {streamState.fixAttempt} 轮: {streamState.message}
                    </span>
                  </div>
                )}

                {streamState.buildLogs.length > 0 && (
                  <CollapsibleSection title={`构建日志 (${streamState.buildLogs.length} 行)`}>
                    <div className="bg-gray-900 rounded-lg p-2 max-h-40 overflow-y-auto">
                      <pre className="text-[11px] text-green-400 font-mono whitespace-pre-wrap leading-4">
                        {streamState.buildLogs.slice(-60).join("\n")}
                      </pre>
                    </div>
                  </CollapsibleSection>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {streamState.error && (
          <div className="ml-10 bg-red-50 border border-red-100 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <XCircle className="w-3.5 h-3.5 text-red-500" />
              <span className="text-xs text-red-600">{streamState.error}</span>
            </div>
          </div>
        )}
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

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-0" : "-rotate-90"}`} />
        <span>{title}</span>
      </button>
      {open && <div className="px-3 pb-2">{children}</div>}
    </div>
  );
}
