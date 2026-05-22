/**
 * PreviewPanel — 预览面板
 *
 * 构建完成后自动加载 iframe 预览。
 * 未完成时展示加载占位。
 */

"use client";

import { ExternalLink, Monitor, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

interface PreviewPanelProps {
  previewUrl: string | null;
  isBuilding: boolean;
}

export function PreviewPanel({ previewUrl, isBuilding }: PreviewPanelProps) {
  const [iframeKey, setIframeKey] = useState(0);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* 头部：地址栏风格 */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-400" />
          <div className="w-3 h-3 rounded-full bg-yellow-400" />
          <div className="w-3 h-3 rounded-full bg-green-400" />
        </div>
        <div className="flex-1 flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-1.5">
          <Monitor className="w-3.5 h-3.5 text-gray-400" />
          {previewUrl ? (
            <span className="text-xs text-gray-500 truncate">{previewUrl}</span>
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

      {/* 预览区域 */}
      <div className="flex-1 relative bg-gray-50">
        {previewUrl ? (
          <iframe
            key={iframeKey}
            src={previewUrl}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-forms allow-same-origin"
            title="Website Preview"
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full">
            {isBuilding ? (
              <>
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center mb-4">
                  <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                </div>
                <p className="text-sm text-gray-500">正在生成预览...</p>
                <p className="text-xs text-gray-400 mt-1">
                  通常需要 10-30 秒
                </p>
              </>
            ) : (
              <>
                <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mb-4">
                  <Monitor className="w-6 h-6 text-gray-300" />
                </div>
                <p className="text-sm text-gray-400">预览将在构建完成后显示</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
