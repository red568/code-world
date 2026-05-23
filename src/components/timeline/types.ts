export type StepStatus = "pending" | "active" | "done" | "error";

export interface TimelineStep {
  id: string;
  type: "spec" | "plan" | "codegen" | "review" | "build" | "fix" | "preview";
  label: string;
  status: StepStatus;
  startedAt?: number;
  finishedAt?: number;
  detail?: string;
  children?: TimelineFileItem[];
}

export interface TimelineFileItem {
  path: string;
  status: "pending" | "generating" | "done";
}

export interface TimelineRound {
  id: number;
  userMessage: string;
  steps: TimelineStep[];
}
