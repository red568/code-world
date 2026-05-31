"use client";

import { motion } from "framer-motion";
import {
  Brain,
  FileCode,
  Terminal,
  FileSearch,
  Eye,
  AlertCircle,
  Check,
  X,
  Loader2,
  Square,
} from "lucide-react";
import type { StepStatus } from "./types";

const STEP_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  thinking: Brain,
  file: FileCode,
  command: Terminal,
  read: FileSearch,
  preview: Eye,
  error: AlertCircle,
};

const STATUS_RING: Record<StepStatus, string> = {
  pending: "border-gray-200 bg-white",
  active: "border-blue-400 bg-blue-50",
  done: "border-green-400 bg-green-50",
  error: "border-red-400 bg-red-50",
  stopped: "border-gray-300 bg-gray-50",
};

const STATUS_ICON_COLOR: Record<StepStatus, string> = {
  pending: "text-gray-300",
  active: "text-blue-500",
  done: "text-green-600",
  error: "text-red-500",
  stopped: "text-gray-400",
};

export function StepIcon({ type, status }: { type: string; status: StepStatus }) {
  const Icon = STEP_ICONS[type] ?? FileSearch;

  return (
    <div className={`relative w-7 h-7 rounded-full border-2 flex items-center justify-center ${STATUS_RING[status]}`}>
      {status === "active" && (
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-blue-400"
          animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
      )}
      {status === "done" ? (
        <Check className="w-3.5 h-3.5 text-green-600" />
      ) : status === "error" ? (
        <X className="w-3.5 h-3.5 text-red-500" />
      ) : status === "stopped" ? (
        <Square className="w-2.5 h-2.5 text-gray-400 fill-current" />
      ) : (
        <Icon className={`w-3.5 h-3.5 ${STATUS_ICON_COLOR[status]}`} />
      )}
    </div>
  );
}

export function SpinnerDot() {
  return <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />;
}
