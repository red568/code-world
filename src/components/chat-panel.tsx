/**
 * ChatPanel — 聊天面板
 *
 * 展示对话历史和 AI 需求分析过程。
 * 底部输入框可继续迭代修改。
 */

"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2, Bot, User } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  messages: Message[];
  specText: string;
  isGenerating: boolean;
  onSend: (message: string) => void;
}

export function ChatPanel({
  messages,
  specText,
  isGenerating,
  onSend,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, specText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isGenerating) return;
    onSend(input.trim());
    setInput("");
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* 头部 */}
      <div className="px-5 py-3 border-b border-gray-100">
        <h2 className="font-semibold text-gray-800 text-sm">对话</h2>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {messages.length === 0 && !specText && (
          <div className="text-center text-gray-400 mt-16">
            <p className="text-sm">对话内容将显示在这里</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className="flex gap-3">
            {/* 头像 */}
            <div
              className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
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
            {/* 内容 */}
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

        {/* Spec 流式输出 */}
        {specText && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-blue-500 to-purple-600">
              <Bot className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-blue-500 mb-1">
                正在分析需求...
              </p>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                <p className="text-xs text-gray-600 font-mono whitespace-pre-wrap leading-relaxed">
                  {specText}
                </p>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入框 */}
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
