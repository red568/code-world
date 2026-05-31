"use client";

import { useState } from "react";
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
    }
  };

  const allAnswered = data.missing_info.every((item) => selections[item.aspect]);

  const handleSubmit = () => {
    if (allAnswered) {
      onSubmit(selections);
    }
  };

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-4">
      <p className="text-sm text-gray-600">帮我确认几个细节，好让结果更符合你的预期</p>

      {data.missing_info.map((item) => (
        <div key={item.aspect} className="space-y-2">
          <p className="text-xs font-medium text-gray-500">{item.aspect}</p>
          <div className="flex flex-wrap gap-2">
            {item.options.map((option) => (
              <button
                key={option}
                onClick={() => handleSelect(item.aspect, option)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  selections[item.aspect] === option
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-700 border-gray-200 hover:border-gray-400"
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          {!expandedOther[item.aspect] ? (
            <button
              onClick={() => setExpandedOther((prev) => ({ ...prev, [item.aspect]: true }))}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              以上都不是？补充说明
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                maxLength={200}
                value={otherInputs[item.aspect] || ""}
                onChange={(e) => setOtherInputs((prev) => ({ ...prev, [item.aspect]: e.target.value }))}
                placeholder="输入你的想法..."
                className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400"
              />
              <button
                onClick={() => handleOtherSubmit(item.aspect)}
                disabled={!otherInputs[item.aspect]?.trim()}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-200 disabled:text-gray-400"
              >
                确认
              </button>
            </div>
          )}
        </div>
      ))}

      <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
        >
          开始生成
        </button>
        <button
          onClick={onSkip}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          让 AI 自由发挥，直接开始
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
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-3">
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-500">快速确认</p>
        <p className="text-sm text-gray-800">{data.question}</p>
        <p className="text-xs text-gray-400">因为：{data.context}</p>
      </div>

      <div className="space-y-2">
        {data.options.map((option) => (
          <button
            key={option.label}
            onClick={() => submitAnswer(option.label)}
            disabled={submitting}
            className="w-full text-left px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:border-gray-400 disabled:opacity-50 transition-colors"
          >
            <span className="font-medium">{option.label}</span>
            <span className="text-gray-400 ml-2">{option.description}</span>
          </button>
        ))}
      </div>

      {!expandedOther ? (
        <button
          onClick={() => setExpandedOther(true)}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          以上都不是？补充说明
        </button>
      ) : (
        <div className="flex gap-2">
          <input
            type="text"
            maxLength={200}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="输入你的想法..."
            className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-gray-400"
          />
          <button
            onClick={() => submitAnswer(otherText, true)}
            disabled={!otherText.trim() || submitting}
            className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg disabled:bg-gray-200 disabled:text-gray-400"
          >
            确认
          </button>
        </div>
      )}

      <button
        onClick={() => submitAnswer("", false, true)}
        disabled={submitting}
        className="text-xs text-gray-400 hover:text-gray-600"
      >
        跳过，让 AI 自行决定
      </button>
    </div>
  );
}
