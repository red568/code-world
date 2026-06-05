"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import type { AskUserData } from "@/hooks/use-project-stream";

// ─── ask_user 卡片 ──────────────────────────────────────────────────────────────

interface AskUserCardProps {
  data: AskUserData;
  projectId: string;
  onAnswered: () => void;
}

export function AskUserCard({ data, projectId, onAnswered }: AskUserCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [expandedOther, setExpandedOther] = useState(false);
  const [otherText, setOtherText] = useState("");

  const submitAnswer = async (answer: string, isOther = false, skip = false) => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: data.runId,
          answerToken: data.answerToken,
          answer,
          isOther,
          skipAndContinue: skip,
        }),
      });
      if (res.ok) {
        onAnswered();
      } else {
        setSubmitting(false);
      }
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      {/* 标题栏 */}
      <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
        <p className="text-xs font-medium text-gray-500">快速确认</p>
      </div>

      <div className="px-5 py-4 space-y-3">
        <p className="text-sm text-gray-800">{data.question}</p>
        <p className="text-xs text-gray-400">{data.context}</p>

        <div className="space-y-2">
          {data.options.map((option) => (
            <button
              key={option.label}
              onClick={() => submitAnswer(option.label)}
              disabled={submitting}
              className="w-full text-left px-4 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl hover:border-gray-400 hover:bg-white disabled:opacity-50 transition-all"
            >
              <span className="font-medium text-gray-800">{option.label}</span>
              {option.description && (
                <span className="text-gray-400 ml-2">{option.description}</span>
              )}
            </button>
          ))}
        </div>

        {!expandedOther ? (
          <button
            onClick={() => setExpandedOther(true)}
            className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            <Pencil className="w-3 h-3" />
            <span>自定义</span>
          </button>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              maxLength={200}
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && otherText.trim()) submitAnswer(otherText, true);
              }}
              placeholder="输入你的想法..."
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-blue-300 transition-colors"
              autoFocus
            />
            <button
              onClick={() => submitAnswer(otherText, true)}
              disabled={!otherText.trim() || submitting}
              className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
            >
              确定
            </button>
          </div>
        )}
      </div>

      {/* 底部 */}
      <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
        <button
          onClick={() => submitAnswer("", false, true)}
          disabled={submitting}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          跳过，让 AI 自行决定
        </button>
      </div>
    </div>
  );
}
