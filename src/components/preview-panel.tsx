"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, Monitor, RefreshCw, Code2, Square, PanelRightClose } from "lucide-react";

interface PreviewPanelProps {
  previewUrl: string | null;
  isBuilding: boolean;
  phase: string;
  stopped?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function PreviewPanel({ previewUrl, isBuilding, phase, stopped, collapsed, onToggleCollapse }: PreviewPanelProps) {
  const [iframeKey, setIframeKey] = useState(0);

  if (collapsed) return null;

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Browser chrome */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-3">
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
            title="折叠预览面板"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-400" />
          <div className="w-3 h-3 rounded-full bg-yellow-400" />
          <div className="w-3 h-3 rounded-full bg-green-400" />
        </div>
        <div className="flex-1 flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border border-gray-200">
          <Monitor className="w-3.5 h-3.5 text-gray-400" />
          {previewUrl ? (
            <span className="text-xs text-gray-600 truncate">{previewUrl}</span>
          ) : (
            <span className="text-xs text-gray-400">预览地址</span>
          )}
        </div>
        {previewUrl && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIframeKey((k) => k + 1)}
              className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
              title="刷新预览"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
              title="在新窗口打开"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        )}
      </div>

      {/* Preview area */}
      <div className="flex-1 relative bg-gray-50">
        <AnimatePresence mode="wait">
          {previewUrl ? (
            <motion.div
              key="preview"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="absolute inset-0"
            >
              <iframe
                key={iframeKey}
                src={previewUrl}
                className="w-full h-full border-0 bg-white"
                sandbox="allow-scripts allow-forms allow-same-origin"
                title="Website Preview"
              />
            </motion.div>
          ) : (
            <motion.div
              key="placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 flex flex-col items-center justify-center"
            >
              {isBuilding ? (
                <BuildingAnimation phase={phase} />
              ) : stopped ? (
                <StoppedPlaceholder />
              ) : (
                <IdlePlaceholder />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function BuildingAnimation({ phase }: { phase: string }) {
  const label = phase === "code_generating" ? "Agent 工作中..." : "处理中...";

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Animated rings */}
      <div className="relative w-20 h-20">
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-blue-500/30"
          animate={{ scale: [1, 1.4, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
        />
        <motion.div
          className="absolute inset-2 rounded-full border-2 border-purple-500/30"
          animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeOut", delay: 0.3 }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
            <Code2 className="w-6 h-6 text-white" />
          </div>
        </div>
      </div>

      <div className="text-center">
        <motion.p
          key={label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-sm text-gray-600 font-medium"
        >
          {label}
        </motion.p>
        <p className="text-xs text-gray-400 mt-1">完成后将自动显示预览</p>
      </div>

      {/* Progress dots */}
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-blue-500"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          />
        ))}
      </div>
    </div>
  );
}

function StoppedPlaceholder() {
  return (
    <div className="text-center">
      <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-4">
        <Square className="w-5 h-5 text-gray-400 fill-current" />
      </div>
      <p className="text-sm text-gray-500">已停止生成</p>
      <p className="text-xs text-gray-400 mt-1">输入新的需求继续</p>
    </div>
  );
}

function IdlePlaceholder() {
  return (
    <div className="text-center">
      <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-4">
        <Monitor className="w-6 h-6 text-gray-300" />
      </div>
      <p className="text-sm text-gray-400">预览将在构建完成后显示</p>
    </div>
  );
}
