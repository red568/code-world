"use client";

import { motion } from "framer-motion";
import { User, Bot } from "lucide-react";
import { TimelineStepRow } from "./timeline-step";
import type { TimelineRound as TRound } from "./types";

export function TimelineRound({ round }: { round: TRound }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-3"
    >
      {/* User message */}
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
          <User className="w-3.5 h-3.5 text-gray-600" />
        </div>
        <div className="flex-1 min-w-0 pt-1">
          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
            {round.userMessage}
          </p>
        </div>
      </div>

      {/* Agent steps */}
      {round.steps.length > 0 && (
        <div className="flex gap-3">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center flex-shrink-0">
            <Bot className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="space-y-0">
              {round.steps.map((step, i) => (
                <TimelineStepRow
                  key={step.id}
                  step={step}
                  isLast={i === round.steps.length - 1}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
