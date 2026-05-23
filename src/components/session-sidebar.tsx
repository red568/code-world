"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Plus, MessageSquare, CheckCircle2, XCircle, Loader2, Sparkles } from "lucide-react";

interface ProjectItem {
  id: string;
  title: string;
  status: string;
  originalPrompt: string;
  createdAt: string;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  running: <CheckCircle2 className="w-3 h-3 text-green-500" />,
  failed: <XCircle className="w-3 h-3 text-red-400" />,
};

function StatusDot({ status }: { status: string }) {
  const icon = STATUS_ICON[status];
  if (icon) return icon;
  if (["spec_generating", "code_generating", "reviewing", "building", "fixing"].includes(status)) {
    return <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />;
  }
  return <div className="w-2 h-2 rounded-full bg-gray-300" />;
}

export function SessionSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [projects, setProjects] = useState<ProjectItem[]>([]);

  const activeId = pathname.startsWith("/project/") ? pathname.split("/")[2] : null;

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/projects")
        .then((r) => r.json())
        .then((d) => setProjects(d.projects || []))
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col h-full bg-gray-950 text-gray-300">
      {/* Logo */}
      <div className="px-4 py-4 flex items-center gap-2.5">
        <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
          <Sparkles className="w-3.5 h-3.5 text-white" />
        </div>
        <span className="font-semibold text-sm text-white">AI Builder</span>
      </div>

      {/* New chat */}
      <div className="px-3 mb-2">
        <button
          onClick={() => router.push("/")}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800/60 rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>新建项目</span>
        </button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto px-3 space-y-0.5">
        {projects.map((p) => {
          const isActive = p.id === activeId;
          return (
            <button
              key={p.id}
              onClick={() => router.push(`/project/${p.id}`)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors group ${
                isActive
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"
              }`}
            >
              <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
              <span className="flex-1 text-sm truncate">
                {p.title || p.originalPrompt.slice(0, 30)}
              </span>
              <StatusDot status={p.status} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
