"use client";

import { useCallback, useEffect, use } from "react";
import { SessionSidebar } from "@/components/session-sidebar";
import { ChatPanel } from "@/components/chat-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { useProjectStream, type Round } from "@/hooks/use-project-stream";

export default function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { state, addUserMessage, loadHistory } = useProjectStream(id);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.project?.messages && data.project.messages.length > 0) {
          const rounds = messagesToRounds(data.project.messages);
          loadHistory(rounds);
        }
      })
      .catch(() => {});
  }, [id, loadHistory]);

  const isGenerating =
    state.phase !== "idle" &&
    state.phase !== "running" &&
    state.phase !== "failed";

  const handleSend = useCallback(
    async (content: string) => {
      addUserMessage(content);
      try {
        await fetch(`/api/projects/${id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
      } catch {
        // Error will come through SSE
      }
    },
    [id, addUserMessage]
  );

  return (
    <div className="h-screen flex bg-white">
      {/* Left: Session sidebar */}
      <div className="w-[220px] flex-shrink-0">
        <SessionSidebar />
      </div>

      {/* Middle: Chat timeline */}
      <div className="w-[420px] flex-shrink-0 border-r border-gray-200">
        <ChatPanel
          rounds={state.rounds}
          phase={state.phase}
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

function messagesToRounds(messages: { role: string; content: string }[]): Round[] {
  const rounds: Round[] = [];
  let roundId = 0;

  for (const msg of messages) {
    if (msg.role === "user") {
      rounds.push({
        id: ++roundId,
        userMessage: msg.content,
        steps: [],
        phase: "running",
      });
    } else if (msg.role === "assistant" && rounds.length > 0) {
      const current = rounds[rounds.length - 1];
      current.steps.push({
        id: roundId * 100,
        type: "done",
        label: msg.content,
        status: "done",
      });
    }
  }

  return rounds;
}
