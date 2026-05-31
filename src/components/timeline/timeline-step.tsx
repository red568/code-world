"use client";

import { motion } from "framer-motion";
import { StepIcon } from "./step-icon";
import { ElapsedTimer } from "./elapsed-timer";
import type { TimelineStep as TStep } from "./types";

export function TimelineStepRow({ step, isLast }: { step: TStep; isLast: boolean }) {
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
          <span className={`text-sm flex-1 truncate ${
            step.status === "active" ? "text-gray-800 font-medium" :
            step.status === "done" ? "text-gray-600" :
            step.status === "error" ? "text-red-600" :
            step.status === "stopped" ? "text-gray-400" :
            "text-gray-400"
          }`}>
            {step.label}
          </span>
          {step.startedAt && (
            <ElapsedTimer startedAt={step.startedAt} finishedAt={step.finishedAt} />
          )}
        </div>

        {/* Detail text */}
        {step.detail && step.status !== "pending" && (
          <p className="ml-9 mt-0.5 text-xs text-gray-400 truncate">{step.detail}</p>
        )}
      </motion.div>

      {/* Spacing */}
      <div className={isLast ? "pb-1" : "pb-3"} />
    </div>
  );
}
