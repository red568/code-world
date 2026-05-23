"use client";

import { useState, useCallback, useEffect, use } from "react";
import { SessionSidebar } from "@/components/session-sidebar";
import { ChatPanel } from "@/components/chat-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { useProjectStream } from "@/hooks/use-project-stream";

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { state } = useProjectStream(id);

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
    <div className="h-screen flex bg-white">
      {/* Left: Session sidebar */}
      <div className="w-[220px] flex-shrink-0">
        <SessionSidebar />
      </div>

      {/* Middle: Chat + Activity trail */}
      <div className="w-[420px] flex-shrink-0 border-r border-gray-200">
        <ChatPanel
          messages={messages}
          streamState={state}
          isGenerating={isGenerating}
          onSend={handleSend}
        />
      </div>

      {/* Right: Preview */}
      <div className="flex-1 min-w-0 border-l border-gray-200">
        <PreviewPanel
          previewUrl={state.previewUrl}
          isBuilding={isGenerating}
          phase={state.phase}
        />
      </div>
    </div>
  );
}
