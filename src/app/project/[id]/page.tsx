"use client";

import { useState, useCallback, useEffect, useRef, use } from "react";
import { useRouter } from "next/navigation";
import { SessionSidebar } from "@/components/session-sidebar";
import { ChatPanel } from "@/components/chat-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { useProjectStream } from "@/hooks/use-project-stream";
import type { ClarificationData } from "@/hooks/use-project-stream";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ clarification?: string; prompt?: string }>;
}) {
  const { id: routeId } = use(params);
  const resolvedSearchParams = searchParams ? use(searchParams) : {};
  const router = useRouter();
  const isDraft = routeId === "new";

  const [projectId, setProjectId] = useState<string | null>(isDraft ? null : routeId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [hasActiveRun, setHasActiveRun] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [localClarification, setLocalClarification] = useState<ClarificationData | null>(null);
  const { state, reset, forceIdle, answerDone } = useProjectStream(projectId);
  const creatingRef = useRef(false);

  // 乐观跳转：从首页带着 prompt 过来，立即调用 API
  useEffect(() => {
    const promptParam = resolvedSearchParams.prompt;
    if (!isDraft || !promptParam || creatingRef.current) return;

    creatingRef.current = true;
    setAnalyzing(true);
    setMessages([{ role: "user", content: promptParam }]);

    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptParam }),
    })
      .then((res) => res.json())
      .then((data) => {
        setProjectId(data.projectId);
        setAnalyzing(false);

        if (data.awaiting_clarification && data.clarification) {
          setLocalClarification(data.clarification);
        }
        window.history.replaceState(null, "", `/project/${data.projectId}`);
      })
      .catch((err) => {
        setAnalyzing(false);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `创建失败: ${err instanceof Error ? err.message : "未知错误"}` },
        ]);
      });
  }, [isDraft, resolvedSearchParams.prompt]);

  // 从 URL 读取 clarification 参数（兼容老路径）
  useEffect(() => {
    const clarificationParam = resolvedSearchParams.clarification;
    if (clarificationParam && projectId) {
      try {
        const clarification = JSON.parse(decodeURIComponent(clarificationParam));
        setLocalClarification(clarification);
        window.history.replaceState(null, "", `/project/${projectId}`);
      } catch (err) {
        console.error("[ProjectPage] Failed to parse clarification from URL:", err);
      }
    }
  }, [resolvedSearchParams.clarification, projectId]);

  useEffect(() => {
    if (isDraft) {
      if (resolvedSearchParams.prompt) return;
      setProjectId(null);
      setMessages([]);
      setSending(false);
      setHasActiveRun(false);
      setLocalClarification(null);
      reset();
      return;
    }
    setProjectId(routeId);
    // 如果已有消息（乐观跳转流程），跳过重复 fetch
    if (messages.length > 0) return;
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
  }, [routeId, isDraft, reset, resolvedSearchParams.prompt, messages.length]);

  // 合并两个来源的 clarification
  const effectiveClarification = localClarification || state.clarification;

  const isGenerating =
    sending ||
    analyzing ||
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
    async (content: string, clarificationResponse?: Record<string, unknown>) => {
      // 如果是 clarification 提交，清掉本地 clarification
      if (clarificationResponse) {
        setLocalClarification(null);
      }

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
          window.history.replaceState(null, "", `/project/${data.projectId}`);
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
        const body: Record<string, unknown> = { content };
        if (clarificationResponse) {
          body.clarification_response = clarificationResponse;
        }
        await fetch(`/api/projects/${projectId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
    [projectId, reset]
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
          analyzing={analyzing}
          clarification={effectiveClarification}
          onSend={handleSend}
          onStop={handleStop}
          onAskUserAnswered={answerDone}
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
