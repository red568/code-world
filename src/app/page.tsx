/**
 * 首页 — 聊天式引导页面
 *
 * 用户在此输入网站需求，提交后跳转到项目工作区。
 * 参考 Atoms.dev 风格：居中大标题 + 输入框 + 历史项目列表。
 */

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowUp, Loader2, FolderOpen, Clock, Trash2 } from "lucide-react";

interface ProjectSummary {
  id: string;
  title: string;
  status: string;
  originalPrompt: string;
  createdAt: string;
}

export default function HomePage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((data) => setProjects(data.projects || []))
      .catch(() => {});
  }, []);

  const handleDelete = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (!confirm("确定要删除这个项目吗？此操作不可撤销。")) return;

    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
      } else if (res.status === 409) {
        const data = await res.json();
        alert(data.error || "项目正在运行中，请先停止项目");
      }
    } catch {
      // 网络错误静默处理
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isSubmitting) return;

    setIsSubmitting(true);
    // 乐观跳转：立即导航到项目页面，API 调用在项目页面进行
    router.push(`/project/new?prompt=${encodeURIComponent(input.trim())}`);
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-50 to-white flex flex-col">
      {/* 顶部导航 */}
      <nav className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-lg text-gray-900">AI Website Builder</span>
        </div>
      </nav>

      {/* 主体内容 */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 -mt-20">
        {/* 标题区域 */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Sparkles className="w-8 h-8 text-white" />
            </div>
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-3">
            你想创造什么？
          </h1>
          <p className="text-gray-500 text-lg">
            描述你的想法，AI 帮你生成并部署网站
          </p>
        </div>

        {/* 输入框 */}
        <form onSubmit={handleSubmit} className="w-full max-w-2xl">
          <div className="relative bg-white rounded-2xl border border-gray-200 shadow-lg shadow-gray-200/50 transition-shadow focus-within:shadow-xl focus-within:border-blue-300">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="例如：一个现代风格的摄影工作室官网，包含作品集展示、关于我们和联系表单..."
              rows={3}
              disabled={isSubmitting}
              className="w-full px-5 pt-4 pb-14 text-gray-800 placeholder-gray-400 bg-transparent resize-none focus:outline-none text-base disabled:text-gray-400"
            />
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400">Enter 发送，Shift+Enter 换行</span>
              </div>
              <button
                type="submit"
                disabled={!input.trim() || isSubmitting}
                className="w-9 h-9 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 text-white rounded-xl flex items-center justify-center transition-colors"
              >
                {isSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowUp className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </form>

        {/* 快捷示例 */}
        <div className="flex flex-wrap gap-2 mt-5 max-w-2xl justify-center">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setInput(ex)}
              className="px-3 py-1.5 text-xs text-gray-500 bg-white border border-gray-200 rounded-full hover:border-gray-300 hover:text-gray-700 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* 底部：历史项目 */}
      {projects.length > 0 && (
        <div className="px-6 pb-8 max-w-3xl mx-auto w-full">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-500">最近项目</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.slice(0, 6).map((p) => (
              <div
                key={p.id}
                onClick={() => router.push(`/project/${p.id}`)}
                className="relative text-left p-4 bg-white border border-gray-200 rounded-xl hover:border-gray-300 hover:shadow-sm transition-all group cursor-pointer"
              >
                <button
                  onClick={(e) => handleDelete(e, p.id)}
                  className="absolute top-2 right-2 hidden group-hover:flex w-6 h-6 items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  title="删除项目"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <div className="flex items-start gap-2">
                  <FolderOpen className="w-4 h-4 text-gray-400 mt-0.5 group-hover:text-blue-500 transition-colors" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">
                      {(p.title && p.title !== "Untitled") ? p.title : p.originalPrompt.slice(0, 30)}
                    </p>
                    <p className="text-xs text-gray-400 truncate mt-0.5">
                      {p.originalPrompt}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

const EXAMPLES = [
  "个人博客网站",
  "SaaS 产品落地页",
  "摄影作品集",
  "餐厅官网",
  "数据仪表盘",
];
