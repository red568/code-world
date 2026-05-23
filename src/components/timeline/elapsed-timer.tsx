"use client";

import { useState, useEffect } from "react";

export function ElapsedTimer({ startedAt, finishedAt }: { startedAt: number; finishedAt?: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (finishedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [finishedAt]);

  const elapsed = ((finishedAt ?? now) - startedAt) / 1000;
  return (
    <span className="text-[11px] text-gray-400 tabular-nums font-mono">
      {elapsed.toFixed(1)}s
    </span>
  );
}
