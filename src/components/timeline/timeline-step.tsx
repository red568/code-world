"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import { ChevronRight, CheckCircle2, Loader2, Circle } from "lucide-react";
import { StepIcon } from "./step-icon";
import { ElapsedTimer } from "./elapsed-timer";
import type { TimelineStep as TStep, TimelineFileItem } from "./types";

function FileProgress({ files }: { files: TimelineFileItem[] }) {
  const done = files.filter((f) => f.status === "done").length;
  const total = files.length;

  return (
    <div className="ml-9 mt-1.5 space-y-1">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex gap-0.5">
          {files.map((f, i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                f.status === "done"
                  ? "bg-green-400"
                  : f.status === "generating"
                  ? "bg-blue-400 animate-pulse"
                  : "bg-gray-200"
              }`}
            />
          ))}
        </div>
        <span className="text-[11px] text-gray-400">{done}/{total}</span>
      </div>
      <AnimatePresence initial={false}>
        {files.map((f) => (
          <motion.div
            key={f.path}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-2 py-0.5"
          >
            {f.status === "done" ? (
              <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
            ) : f.status === "generating" ? (
              <Loader2 className="w-3 h-3 text-blue-500 animate-spin flex-shrink-0" />
            ) : (
              <Circle className="w-3 h-3 text-gray-300 flex-shrink-0" />
            )}
            <span className={`text-xs font-mono truncate ${
              f.status === "generating" ? "text-blue-600" : "text-gray-500"
            }`}>
              {f.path}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function TimelineStepRow({ step, isLast }: { step: TStep; isLast: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = step.children && step.children.length > 0;

  return (
    <div className="relative">
      {/* Vertical connector line */}
      {!isLast && (
        <div className="absolute left-[13px] top-7 bottom-0 w-px bg-gray-200" />
      )}

      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.25 }}
      >
        {/* Step header */}
        <div className="flex items-center gap-2.5 group">
          <StepIcon type={step.type} status={step.status} />
          <span className={`text-sm flex-1 ${
            step.status === "active" ? "text-gray-800 font-medium" :
            step.status === "done" ? "text-gray-600" :
            step.status === "error" ? "text-red-600" :
            "text-gray-400"
          }`}>
            {step.label}
          </span>
          {step.startedAt && (
            <ElapsedTimer startedAt={step.startedAt} finishedAt={step.finishedAt} />
          )}
          {hasChildren && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-0.5 rounded hover:bg-gray-100"
            >
              <ChevronRight className={`w-3.5 h-3.5 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`} />
            </button>
          )}
        </div>

        {/* Detail text */}
        {step.detail && step.status !== "pending" && (
          <p className="ml-9 mt-0.5 text-xs text-gray-400">{step.detail}</p>
        )}

        {/* File children */}
        {hasChildren && expanded && step.status !== "pending" && (
          <FileProgress files={step.children!} />
        )}
      </motion.div>

      {/* Spacing */}
      <div className={isLast ? "pb-1" : "pb-3"} />
    </div>
  );
}
