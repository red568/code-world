"use client";

import { useState, useCallback, useEffect, useRef, use } from "react";
import { useRouter } from "next/navigation";
import { PanelRightOpen } from "lucide-react";
import { SessionSidebar } from "@/components/session-sidebar";
import { ChatPanel } from "@/components/chat-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { ResizeHandle } from "@/components/resize-handle";
import { useProjectStream } from "@/hooks/use-project-stream";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ prompt?: string }>;
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
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const [analyzing, setAnalyzing] = useState(false);
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

  useEffect(() => {
    if (isDraft) {
      if (resolvedSearchParams.prompt) return;
      setProjectId(null);
      setMessages([]);
      setSending(false);
      setHasActiveRun(false);
      reset();
      return;
    }
    setProjectId(routeId);
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

  const handleResize = useCallback((deltaX: number) => {
    setChatWidth((w) => Math.max(320, Math.min(800, w + deltaX)));
  }, []);

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
      <div
        className={`border-r border-gray-200 ${previewCollapsed ? "flex-1 min-w-0" : "flex-shrink-0"}`}
        style={previewCollapsed ? undefined : { width: chatWidth }}
      >
        <ChatPanel
          projectId={projectId || ""}
          messages={messages}
          streamState={state}
          isGenerating={isGenerating}
          analyzing={analyzing}
          onSend={handleSend}
          onStop={handleStop}
          onAskUserAnswered={answerDone}
        />
      </div>

      {/* Resize handle */}
      {!previewCollapsed && <ResizeHandle onResize={handleResize} />}

      {/* Right: Preview */}
      <div className={`border-l border-gray-200 transition-all duration-200 ${previewCollapsed ? "w-0 overflow-hidden" : "flex-1 min-w-0"}`}>
        <PreviewPanel
          previewUrl={state.previewUrl}
          isBuilding={isGenerating}
          phase={state.phase}
          stopped={state.phase === "idle" && state.message === "已停止"}
          collapsed={previewCollapsed}
          onToggleCollapse={() => setPreviewCollapsed((v) => !v)}
        />
      </div>

      {/* Collapse toggle when preview is hidden */}
      {previewCollapsed && (
        <div className="w-[32px] flex-shrink-0 border-l border-gray-200 bg-gray-50">
          <button
            onClick={() => setPreviewCollapsed(false)}
            className="w-full pt-4 flex justify-center text-gray-400 hover:text-gray-600 transition-colors"
            title="展开预览"
          >
            <PanelRightOpen className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
