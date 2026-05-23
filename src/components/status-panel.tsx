/**
 * StatusPanel — 生成过程展示面板
 *
 * 分阶段展示：Spec → Codegen → Review → Build → Fix
 * 类似 Atoms 的步骤处理视图（"已处理 N 步"）。
 */

"use client";

import { useRef, useEffect } from "react";
import {
  FileCode,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Terminal,
  Wrench,
  Sparkles,
  Search,
  Hammer,
} from "lucide-react";
import { type StreamState } from "@/hooks/use-project-stream";

interface StatusPanelProps {
  state: StreamState;
}

// 将阶段映射为步骤序号
const PHASE_STEPS: Record<string, number> = {
  idle: 0,
  spec_generating: 1,
  code_generating: 2,
  reviewing: 3,
  building: 4,
  fixing: 4,
  running: 5,
  failed: -1,
};

const STEPS = [
  { key: "spec", label: "分析需求", icon: Sparkles },
  { key: "codegen", label: "生成代码", icon: FileCode },
  { key: "review", label: "审查代码", icon: Search },
  { key: "build", label: "构建部署", icon: Hammer },
  { key: "done", label: "预览就绪", icon: CheckCircle2 },
];

export function StatusPanel({ state }: StatusPanelProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);
  const currentStep = PHASE_STEPS[state.phase] ?? 0;

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.buildLogs]);

  const completedSteps = state.phase === "running" ? 5 : currentStep;

  return (
    <div className="flex flex-col h-full bg-white">
      {/* 头部 */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800 text-sm">生成过程</h2>
        {currentStep > 0 && (
          <span className="text-xs text-gray-400">
            已处理 {Math.min(completedSteps, 5)} 步
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 步骤指示器 */}
        <div className="px-5 py-4">
          <div className="space-y-1">
            {STEPS.map((step, i) => {
              const stepNum = i + 1;
              const isActive = stepNum === currentStep;
              const isDone = stepNum < currentStep || state.phase === "running";
              const isFailed = state.phase === "failed" && stepNum === Math.abs(currentStep);
              const Icon = step.icon;

              return (
                <div
                  key={step.key}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                    isActive
                      ? "bg-blue-50"
                      : isDone
                        ? "bg-gray-50"
                        : ""
                  }`}
                >
                  {/* 状态图标 */}
                  <div className="flex-shrink-0">
                    {isDone ? (
                      <CheckCircle2 className="w-4 h-4 text-green-500" />
                    ) : isFailed ? (
                      <XCircle className="w-4 h-4 text-red-500" />
                    ) : isActive ? (
                      <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                    ) : (
                      <Icon className="w-4 h-4 text-gray-300" />
                    )}
                  </div>
                  {/* 步骤名称 */}
                  <span
                    className={`text-sm ${
                      isActive
                        ? "text-blue-700 font-medium"
                        : isDone
                          ? "text-gray-600"
                          : "text-gray-400"
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 详细信息区域 */}
        <div className="px-5 pb-4 space-y-4">
          {/* 文件列表 */}
          {state.files.length > 0 && (
            <DetailSection title="文件">
              <ul className="space-y-1.5">
                {state.files.map((file) => (
                  <li key={file.path} className="flex items-center gap-2">
                    {file.status === "done" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                    )}
                    <span className="text-xs font-mono text-gray-600 truncate">
                      {file.path}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          )}

          {/* Review 问题 */}
          {state.reviewIssues.length > 0 && (
            <DetailSection title="审查结果">
              <ul className="space-y-2">
                {state.reviewIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {issue.severity === "error" ? (
                      <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 mt-0.5 flex-shrink-0" />
                    )}
                    <div>
                      <span className="text-xs font-mono text-gray-500">{issue.file}</span>
                      <p className="text-xs text-gray-600">{issue.problem}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </DetailSection>
          )}

          {/* 修复信息 */}
          {state.fixAttempt > 0 && (
            <DetailSection title={`自动修复（第 ${state.fixAttempt} 轮）`}>
              <div className="flex items-center gap-2">
                <Wrench className="w-3.5 h-3.5 text-orange-500" />
                <p className="text-xs text-gray-600">{state.message}</p>
              </div>
            </DetailSection>
          )}

          {/* 构建日志 */}
          {state.buildLogs.length > 0 && (
            <DetailSection title="构建日志">
              <div className="bg-gray-900 rounded-lg p-3 max-h-48 overflow-y-auto">
                <pre className="text-xs text-green-400 font-mono whitespace-pre-wrap leading-5">
                  {state.buildLogs.slice(-80).join("\n")}
                </pre>
                <div ref={logsEndRef} />
              </div>
            </DetailSection>
          )}

          {/* 错误信息 */}
          {state.error && (
            <div className="bg-red-50 border border-red-100 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-3.5 h-3.5 text-red-500" />
                <span className="text-xs font-medium text-red-700">错误</span>
              </div>
              <p className="text-xs text-red-600">{state.error}</p>
            </div>
          )}

          {/* 空状态 */}
          {state.phase === "idle" && state.files.length === 0 && (
            <div className="text-center text-gray-400 mt-12">
              <Terminal className="w-8 h-8 mx-auto mb-2 text-gray-200" />
              <p className="text-xs">等待生成...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}
