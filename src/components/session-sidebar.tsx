"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Plus, MessageSquare, CheckCircle2, XCircle, Loader2, Sparkles, Trash2, PanelLeftClose, PanelLeftOpen } from "lucide-react";

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

interface SessionSidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export function SessionSidebar({ collapsed = false, onToggle }: SessionSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const activeId = pathname.startsWith("/project/") ? pathname.split("/")[2] : null;

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (!confirm("确定要删除这个项目吗？此操作不可撤销。")) return;

    setDeletingId(projectId);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
        if (activeId === projectId) {
          router.push("/");
        }
      } else if (res.status === 409) {
        const data = await res.json();
        alert(data.error || "项目正在运行中，请先停止项目");
      }
    } catch {
      // 网络错误静默处理
    } finally {
      setDeletingId(null);
    }
  };

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
    <div className={`flex flex-col h-full bg-gray-50 border-r border-gray-200 transition-all duration-200 ${collapsed ? "w-[52px]" : "w-full"}`}>
      {/* Logo + Toggle */}
      <div className={`py-4 flex items-center ${collapsed ? "px-3 justify-center" : "px-4 gap-2.5"}`}>
        <div
          className="w-7 h-7 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center cursor-pointer"
          onClick={() => router.push("/")}
        >
          <Sparkles className="w-3.5 h-3.5 text-white" />
        </div>
        {!collapsed && <span className="font-semibold text-sm text-gray-900 flex-1">AI Builder</span>}
        {!collapsed && onToggle && (
          <button
            onClick={onToggle}
            className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600 rounded transition-colors"
            title="折叠侧栏"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Expand button (collapsed state) */}
      {collapsed && onToggle && (
        <div className="px-3 mb-2 flex justify-center">
          <button
            onClick={onToggle}
            className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            title="展开侧栏"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* New chat */}
      <div className={`mb-2 ${collapsed ? "px-3 flex justify-center" : "px-3"}`}>
        <button
          onClick={() => router.push("/")}
          className={`flex items-center text-sm text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors ${
            collapsed ? "w-7 h-7 justify-center" : "w-full gap-2 px-3 py-2"
          }`}
          title="新建项目"
        >
          <Plus className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>新建项目</span>}
        </button>
      </div>

      {/* Project list */}
      <div className={`flex-1 overflow-y-auto space-y-0.5 ${collapsed ? "px-2" : "px-3"}`}>
        {projects.map((p) => {
          const isActive = p.id === activeId;
          const isDeleting = deletingId === p.id;

          if (collapsed) {
            return (
              <div
                key={p.id}
                className={`w-7 h-7 mx-auto flex items-center justify-center rounded-lg cursor-pointer transition-colors ${
                  isActive
                    ? "bg-white shadow-sm border border-gray-200"
                    : "hover:bg-gray-100"
                } ${isDeleting ? "opacity-50 pointer-events-none" : ""}`}
                onClick={() => router.push(`/project/${p.id}`)}
                title={(p.title && p.title !== "Untitled") ? p.title : p.originalPrompt.slice(0, 30)}
              >
                <MessageSquare className="w-3.5 h-3.5 text-gray-400" />
              </div>
            );
          }

          return (
            <div
              key={p.id}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors group cursor-pointer ${
                isActive
                  ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              } ${isDeleting ? "opacity-50 pointer-events-none" : ""}`}
              onClick={() => router.push(`/project/${p.id}`)}
            >
              <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
              <span className="flex-1 text-sm truncate">
                {(p.title && p.title !== "Untitled") ? p.title : p.originalPrompt.slice(0, 30)}
              </span>
              <button
                onClick={(e) => handleDelete(e, p.id)}
                className="hidden group-hover:flex w-5 h-5 items-center justify-center rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                title="删除项目"
              >
                <Trash2 className="w-3 h-3" />
              </button>
              <span className="group-hover:hidden">
                <StatusDot status={p.status} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
