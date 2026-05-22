/**
 * 项目工作区页面 — 三栏布局
 *
 * 左侧：对话聊天（可继续迭代修改）
 * 中间：生成过程展示（文件进度、构建日志、修复状态）
 * 右侧：实时预览 iframe
 *
 * 类似 Atoms.dev 的项目生成页面。
 */

"use client";

import { useState, useCallback, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { ChatPanel } from "@/components/chat-panel";
import { StatusPanel } from "@/components/status-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { useProjectStream } from "@/hooks/use-project-stream";
import { ArrowLeft } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { state } = useProjectStream(id);

  // 加载已有消息
  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.project?.messages) {
          setMessages(
            data.project.messages.map((m: { role: string; content: string }) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }))
          );
        }
      })
      .catch(() => {});
  }, [id]);

  const isGenerating =
    state.phase !== "idle" &&
    state.phase !== "running" &&
    state.phase !== "failed";

  const handleSend = useCallback(
    async (content: string) => {
      setMessages((prev) => [...prev, { role: "user", content }]);
      try {
        await fetch(`/api/projects/${id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `发送失败: ${err instanceof Error ? err.message : "未知错误"}`,
          },
        ]);
      }
    },
    [id]
  );

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* 顶部栏 */}
      <header className="h-12 flex items-center px-4 border-b border-gray-200 bg-white flex-shrink-0">
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>返回</span>
        </button>
        <div className="ml-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-sm text-gray-700 font-medium">
            {state.phase === "running"
              ? "预览就绪"
              : state.phase === "failed"
                ? "生成失败"
                : state.phase === "idle"
                  ? "等待中"
                  : "生成中..."}
          </span>
        </div>
      </header>

      {/* 三栏工作区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左栏：聊天 */}
        <div className="w-[380px] flex-shrink-0">
          <ChatPanel
            messages={messages}
            specText={state.specText}
            isGenerating={isGenerating}
            onSend={handleSend}
          />
        </div>

        {/* 中栏：状态 */}
        <div className="w-[360px] flex-shrink-0 border-l border-gray-200">
          <StatusPanel state={state} />
        </div>

        {/* 右栏：预览 */}
        <div className="flex-1 min-w-0 border-l border-gray-200">
          <PreviewPanel previewUrl={state.previewUrl} isBuilding={isGenerating} />
        </div>
      </div>
    </div>
  );
}
