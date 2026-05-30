export type StepStatus = "pending" | "active" | "done" | "error";

export type StepType =
  | "thinking"
  | "file"
  | "command"
  | "read"
  | "preview"
  | "error";

export interface TimelineStep {
  id: string;
  type: StepType;
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
