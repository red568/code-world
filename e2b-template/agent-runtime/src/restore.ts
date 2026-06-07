/**
 * 恢复流程 — 新 Run 启动时从外部 DB 恢复 Agent 状态
 *
 * 认知恢复优先级：代码文件 > Repo Map > Summary > pending messages
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { RuntimeConfig, LoggerInterface } from "./types.js";

export interface RestoredState {
  compressionSummary: string;
  summaryCoversStepEnd: number;
  summaryVersion: number;
  pendingMessages: unknown[];
  pendingStartStep: number;
  pendingEndStep: number;
  filesRestored: number;
}

export async function restoreAgentState(
  config: RuntimeConfig,
  logger: LoggerInterface
): Promise<RestoredState> {
  const baseUrl = config.apiBaseUrl;
  const headers = {
    "Content-Type": "application/json",
    "X-Internal-Secret": config.internalApiSecret,
  };

  // 1. 获取最新 compression summary
  let summaryData: {
    summary: string | null;
    coversStepEnd?: number;
    version?: number;
  } = { summary: null };

  try {
    const res = await fetch(
      `${baseUrl}/api/internal/context/latest-summary?projectId=${config.projectId}`,
      { headers }
    );
    if (res.ok) {
      summaryData = await res.json();
    }
  } catch (error) {
    logger.warn("Failed to fetch latest summary", { error: String(error) });
  }

  // 2. 获取 summary 之后未压缩的 messages
  let pendingData: {
    messages: unknown[];
    startStep?: number;
    endStep?: number;
  } = { messages: [] };

  const afterStep = summaryData.coversStepEnd || 0;
  try {
    const res = await fetch(
      `${baseUrl}/api/internal/context/pending-messages?projectId=${config.projectId}&afterStep=${afterStep}`,
      { headers }
    );
    if (res.ok) {
      pendingData = await res.json();
    }
  } catch (error) {
    logger.warn("Failed to fetch pending messages", { error: String(error) });
  }

  // 3. 恢复项目文件（如果不是 skipFileRestore 模式）
  let filesRestored = 0;
  if (!config.skipFileRestore) {
    filesRestored = await restoreProjectFiles(config, logger);
  }

  logger.info("Agent state restored", {
    hasSummary: !!summaryData.summary,
    summaryVersion: summaryData.version || 0,
    pendingMessages: pendingData.messages?.length || 0,
    filesRestored,
  });

  return {
    compressionSummary: summaryData.summary || "",
    summaryCoversStepEnd: summaryData.coversStepEnd || 0,
    summaryVersion: summaryData.version || 0,
    pendingMessages: pendingData.messages || [],
    pendingStartStep: pendingData.startStep || 0,
    pendingEndStep: pendingData.endStep || 0,
    filesRestored,
  };
}

async function restoreProjectFiles(
  config: RuntimeConfig,
  logger: LoggerInterface
): Promise<number> {
  const baseUrl = config.apiBaseUrl;
  const headers = {
    "Content-Type": "application/json",
    "X-Internal-Secret": config.internalApiSecret,
  };

  try {
    const res = await fetch(
      `${baseUrl}/api/internal/files/sync?projectId=${config.projectId}`,
      { method: "GET", headers }
    );

    if (!res.ok) {
      logger.warn("Failed to fetch project files for restore", { status: res.status });
      return 0;
    }

    const { files } = (await res.json()) as {
      files: { path: string; content: string }[];
    };

    if (!files || files.length === 0) return 0;

    for (const file of files) {
      const fullPath = join(config.projectDir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf-8");
    }

    logger.info("Project files restored to disk", { count: files.length });
    return files.length;
  } catch (error) {
    logger.warn("File restore failed", { error: String(error) });
    return 0;
  }
}
