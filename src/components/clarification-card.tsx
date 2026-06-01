"use client";

import { useState } from "react";
import { Lightbulb, Pencil, Sparkles, Check } from "lucide-react";
import type { ClarificationData, AskUserData } from "@/hooks/use-project-stream";

// ─── 前置澄清卡片 ───────────────────────────────────────────────────────────────

interface ClarificationCardProps {
  data: ClarificationData;
  onSubmit: (selections: Record<string, string>) => void;
  onSkip: () => void;
}

export function ClarificationCard({ data, onSubmit, onSkip }: ClarificationCardProps) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});
  const [expandedOther, setExpandedOther] = useState<Record<string, boolean>>({});

  const handleSelect = (aspect: string, option: string) => {
    setSelections((prev) => ({ ...prev, [aspect]: option }));
    setExpandedOther((prev) => ({ ...prev, [aspect]: false }));
  };

  const handleOtherSubmit = (aspect: string) => {
    const text = otherInputs[aspect]?.trim();
    if (text) {
      setSelections((prev) => ({ ...prev, [aspect]: text }));
      setExpandedOther((prev) => ({ ...prev, [aspect]: false }));
    }
  };

  const allAnswered = data.missing_info.every((item) => selections[item.aspect]);

  const handleSubmit = () => {
    if (allAnswered) {
      onSubmit(selections);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center gap-2 px-5 py-3 bg-gray-50 border-b border-gray-100">
        <Lightbulb className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-medium text-gray-700">帮我完善一下细节</span>
      </div>

      {/* 选项区域 */}
      <div className="px-5 py-4 space-y-5">
        {data.missing_info.map((item) => (
          <div key={item.aspect} className="space-y-2.5">
            <p className="text-sm font-medium text-gray-800">{item.question}</p>
            <div className="flex flex-wrap gap-2">
              {item.options.map((option) => {
                const isSelected = selections[item.aspect] === option;
                return (
                  <button
                    key={option}
                    onClick={() => handleSelect(item.aspect, option)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full border transition-all ${
                      isSelected
                        ? "bg-gray-900 text-white border-gray-900 shadow-sm"
                        : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:text-gray-800"
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3" />}
                    {option}
                  </button>
                );
              })}
            </div>

            {/* 自定义输入 */}
            {!expandedOther[item.aspect] ? (
              <button
                onClick={() => setExpandedOther((prev) => ({ ...prev, [item.aspect]: true }))}
                className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                <Pencil className="w-3 h-3" />
                <span>自定义</span>
              </button>
            ) : (
              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  maxLength={200}
                  value={otherInputs[item.aspect] || ""}
                  onChange={(e) => setOtherInputs((prev) => ({ ...prev, [item.aspect]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleOtherSubmit(item.aspect);
                  }}
                  placeholder="输入你的想法..."
                  className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-blue-300 transition-colors"
                  autoFocus
                />
                <button
                  onClick={() => handleOtherSubmit(item.aspect)}
                  disabled={!otherInputs[item.aspect]?.trim()}
                  className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
                >
                  确定
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-t border-gray-100">
        <button
          onClick={onSkip}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          跳过，让 AI 自由发挥
        </button>
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-gray-900 text-white rounded-lg disabled:bg-gray-200 disabled:text-gray-400 hover:bg-gray-800 transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          开始生成
        </button>
      </div>
    </div>
  );
}

// ─── 过程中 ask_user 卡片 ────────────────────────────────────────────────────────

interface AskUserCardProps {
  data: AskUserData;
  projectId: string;
  runId?: string;
  onAnswered: () => void;
}

export function AskUserCard({ data, projectId, runId, onAnswered }: AskUserCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [expandedOther, setExpandedOther] = useState(false);
  const [otherText, setOtherText] = useState("");

  const submitAnswer = async (answer: string, isOther = false, skip = false) => {
    if (submitting) return;
    setSubmitting(true);

    try {
      await fetch(`/api/projects/${projectId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          answerToken: data.answerToken,
          answer,
          isOther,
          skipAndContinue: skip,
        }),
      });
      onAnswered();
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
