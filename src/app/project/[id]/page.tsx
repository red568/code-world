"use client";

import { useState, useCallback, useEffect, useRef, use } from "react";
import { useRouter } from "next/navigation";
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
  const { id: routeId } = use(params);
  const router = useRouter();
  const isDraft = routeId === "new";

  const [projectId, setProjectId] = useState<string | null>(isDraft ? null : routeId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [hasActiveRun, setHasActiveRun] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { state, reset, forceIdle } = useProjectStream(projectId);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (isDraft) {
      setProjectId(null);
      setMessages([]);
      setSending(false);
      setHasActiveRun(false);
      reset();
      return;
    }
    setProjectId(routeId);
    // Skip fetch if we just created this project (messages already in state)
    if (creatingRef.current) return;
    fetch(`/api/projects/${routeId}`)
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
        if (data.activeRun) {
          setHasActiveRun(true);
        }
      })
      .catch(() => {});
  }, [routeId, isDraft, reset]);

  const isGenerating =
    sending ||
    hasActiveRun ||
    state.phase === "code_generating";

  useEffect(() => {
    setSending(false);
    setHasActiveRun(false);
  }, [state.phase]);

  const handleStop = useCallback(() => {
    setSending(false);
    setHasActiveRun(false);
    forceIdle();
  }, [forceIdle]);

  const handleNewProject = useCallback(() => {
    router.replace("/project/new");
  }, [router]);

  const handleSend = useCallback(
    async (content: string) => {
      reset();
      setSending(true);
      setMessages((prev) => [...prev, { role: "user", content }]);

      if (!projectId) {
        if (creatingRef.current) return;
        creatingRef.current = true;
        try {
          const res = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: content }),
          });
          const data = await res.json();
          setProjectId(data.projectId);
          router.replace(`/project/${data.projectId}`);
        } catch (err) {
          setSending(false);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `创建失败: ${err instanceof Error ? err.message : "未知错误"}`,
            },
          ]);
        } finally {
          creatingRef.current = false;
        }
        return;
      }

      try {
        await fetch(`/api/projects/${projectId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
      } catch (err) {
        setSending(false);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `发送失败: ${err instanceof Error ? err.message : "未知错误"}`,
          },
        ]);
      }
    },
    [projectId, reset, router]
  );

  return (
    <div className="h-screen flex bg-white">
      {/* Left: Session sidebar */}
      <div className={`flex-shrink-0 transition-all duration-200 ${sidebarCollapsed ? "w-[52px]" : "w-[220px]"}`}>
        <SessionSidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          activeProjectId={projectId}
          onNewProject={handleNewProject}
        />
      </div>

      {/* Middle: Chat + Activity trail */}
      <div className="w-[420px] flex-shrink-0 border-r border-gray-200">
        <ChatPanel
          projectId={projectId || ""}
          messages={messages}
          streamState={state}
          isGenerating={isGenerating}
          onSend={handleSend}
          onStop={handleStop}
        />
      </div>

      {/* Right: Preview */}
      <div className="flex-1 min-w-0 border-l border-gray-200">
        <PreviewPanel
          previewUrl={state.previewUrl}
          isBuilding={isGenerating}
          phase={state.phase}
          stopped={state.phase === "idle" && state.message === "已停止"}
        />
      </div>
    </div>
  );
}
