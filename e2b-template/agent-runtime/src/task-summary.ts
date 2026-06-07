/**
 * Task Summary — Episodes 的聚合视图 (Slot D)
 *
 * 纯规则更新，零 IO、零 LLM 调用。
 * 仅沙盒内存维护，不跨 run、不持久化。
 */

import type { Episode } from "./episode-recorder.js";

interface TaskSummaryState {
  userGoal: string;
  currentPhase: "planning" | "implementing" | "debugging" | "polishing";
  totalSteps: number;
  filesWritten: string[];
  recentDecisions: Array<{ step: number; decision: string; reason: string }>;
}

export class TaskSummarizer {
  private summary: TaskSummaryState = {
    userGoal: "",
    currentPhase: "planning",
    totalSteps: 0,
    filesWritten: [],
    recentDecisions: [],
  };

  update(episode: Episode): void {
    this.summary.totalSteps++;

    if (episode.codeChange) {
      const file = episode.codeChange.file;
      if (!this.summary.filesWritten.includes(file)) {
        this.summary.filesWritten.push(file);
        if (this.summary.filesWritten.length > 10) {
          this.summary.filesWritten = this.summary.filesWritten.slice(-10);
        }
      }
    }

    // 根据工具使用模式自动推断阶段
    if (this.summary.totalSteps <= 2) {
      this.summary.currentPhase = "planning";
    } else if (!episode.toolSuccess && episode.toolName === "run_shell") {
      this.summary.currentPhase = "debugging";
    } else if (episode.codeChange) {
      this.summary.currentPhase = "implementing";
    } else if (
      episode.toolName === "get_preview_url" ||
      (episode.toolName === "run_shell" && episode.resultSummary.includes("成功"))
    ) {
      this.summary.currentPhase = "polishing";
    }
  }

  /**
   * 生成 Slot D 内容（~150-200 token）
   */
  toSlotD(): string {
    const s = this.summary;
    if (s.totalSteps === 0) return "";

    const lines: string[] = [];
    if (s.userGoal) lines.push(`目标: ${s.userGoal}`);
    lines.push(`阶段: ${s.currentPhase} | 已完成 ${s.totalSteps} 步`);
    if (s.filesWritten.length > 0) {
      lines.push(`已写入: ${s.filesWritten.slice(-5).join(", ")}`);
    }
    if (s.recentDecisions.length > 0) {
      lines.push(`决策: ${s.recentDecisions.map((d) => d.decision).join("; ")}`);
    }
    return lines.join("\n");
  }

  setUserGoal(goal: string): void {
    this.summary.userGoal = goal.slice(0, 200);
  }

  addDecision(step: number, decision: string, reason: string): void {
    this.summary.recentDecisions.push({ step, decision, reason });
    if (this.summary.recentDecisions.length > 3) {
      this.summary.recentDecisions = this.summary.recentDecisions.slice(-3);
    }
  }

  getCurrentPhase(): string {
    return this.summary.currentPhase;
  }

  getTotalSteps(): number {
    return this.summary.totalSteps;
  }
}
