/**
 * 结构化日志
 *
 * 支持 stdout JSON 输出 + Axiom 批量推送（如果配置了 AXIOM_TOKEN）。
 */

import type { LoggerInterface } from "./types.js";

interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
  runId: string;
  projectId: string;
  [key: string]: unknown;
}

export class Logger implements LoggerInterface {
  private runId: string;
  private projectId: string;
  private buffer: LogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private axiomToken: string | null;
  private axiomDataset: string;

  constructor(runId: string, projectId: string) {
    this.runId = runId;
    this.projectId = projectId;
    this.axiomToken = process.env.AXIOM_TOKEN || null;
    this.axiomDataset = process.env.AXIOM_DATASET || "ai-website-builder";

    if (this.axiomToken) {
      this.flushInterval = setInterval(() => this.flush(), 5000);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log("error", message, meta);
  }

  private log(level: LogEntry["level"], message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      runId: this.runId,
      projectId: this.projectId,
      ...meta,
    };

    const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : "▸";
    console.log(`${prefix} [${this.projectId.slice(0, 8)}] ${message}`, meta ? JSON.stringify(meta) : "");

    if (this.axiomToken) {
      this.buffer.push(entry);
      if (this.buffer.length >= 100) {
        this.flush();
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.axiomToken || this.buffer.length === 0) return;

    const entries = this.buffer.splice(0);
    try {
      await fetch(`https://api.axiom.co/v1/datasets/${this.axiomDataset}/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.axiomToken}`,
        },
        body: JSON.stringify(entries),
      });
    } catch (error) {
      console.error("[Logger] Axiom flush failed:", error);
      this.buffer.unshift(...entries);
    }
  }

  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
}
