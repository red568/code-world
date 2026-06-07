/**
 * 代码文件周期性同步调度器
 *
 * 双重触发：每 10 步 OR 每 5 分钟，将变更的文件异步同步到外部存储。
 * 沙盒销毁前执行全量同步确保数据不丢失。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RuntimeConfig, LoggerInterface } from "./types.js";

interface FileEntry {
  path: string;
  content: string;
}

export class CodeSyncScheduler {
  private lastSyncStep: number = 0;
  private lastSyncTime: number = Date.now();
  private dirtyFiles: Set<string> = new Set();
  private syncInterval: number;
  private stepInterval: number;
  private config: RuntimeConfig;
  private logger: LoggerInterface;

  constructor(config: RuntimeConfig, logger: LoggerInterface) {
    this.config = config;
    this.logger = logger;
    this.syncInterval = parseInt(process.env.CODE_SYNC_INTERVAL_MS || "300000", 10); // 5 min
    this.stepInterval = parseInt(process.env.CODE_SYNC_STEP_INTERVAL || "10", 10);
  }

  markDirty(filePath: string): void {
    this.dirtyFiles.add(filePath);
  }

  getDirtyCount(): number {
    return this.dirtyFiles.size;
  }

  async checkAndSync(currentStep: number): Promise<void> {
    const timeSinceLastSync = Date.now() - this.lastSyncTime;
    const stepsSinceLastSync = currentStep - this.lastSyncStep;

    const shouldSync =
      this.dirtyFiles.size > 0 &&
      (stepsSinceLastSync >= this.stepInterval || timeSinceLastSync >= this.syncInterval);

    if (shouldSync) {
      await this.syncInBackground(currentStep);
    }
  }

  private async syncInBackground(currentStep: number): Promise<void> {
    const filesToSync = [...this.dirtyFiles];
    this.dirtyFiles.clear();
    this.lastSyncStep = currentStep;
    this.lastSyncTime = Date.now();

    const files: FileEntry[] = [];
    for (const filePath of filesToSync) {
      try {
        const fullPath = join(this.config.projectDir, filePath);
        const content = await readFile(fullPath, "utf-8");
        files.push({ path: filePath, content });
      } catch {
        // file may have been deleted
      }
    }

    if (files.length === 0) return;

    const url = `${this.config.apiBaseUrl}/api/internal/files/sync-batch`;

    // fire-and-forget
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": this.config.internalApiSecret,
      },
      body: JSON.stringify({
        projectId: this.config.projectId,
        files,
      }),
    })
      .then(() => {
        this.logger.info("Background code sync completed", { fileCount: files.length });
      })
      .catch((err) => {
        this.logger.warn("Background code sync failed, will retry next cycle", {
          error: String(err),
        });
        // re-mark as dirty for next sync
        for (const f of filesToSync) {
          this.dirtyFiles.add(f);
        }
      });
  }

  /**
   * 沙盒销毁前全量同步（阻塞等待完成）
   */
  async syncFinal(): Promise<void> {
    const files = await this.collectAllProjectFiles();

    if (files.length === 0) {
      this.logger.info("No files to sync at final");
      return;
    }

    const url = `${this.config.apiBaseUrl}/api/internal/files/sync-final`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": this.config.internalApiSecret,
        },
        body: JSON.stringify({
          projectId: this.config.projectId,
          files,
          isFinal: true,
        }),
      });

      if (response.ok) {
        this.logger.info("Final code sync completed", { fileCount: files.length });
      } else {
        this.logger.warn("Final code sync failed", { status: response.status });
      }
    } catch (error) {
      this.logger.warn("Final code sync error", { error: String(error) });
    }
  }

  private async collectAllProjectFiles(): Promise<FileEntry[]> {
    const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json", ".md"]);
    const skipDirs = new Set(["node_modules", ".git", "dist", ".next"]);
    const files: FileEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue;
            await walk(fullPath);
          } else {
            const ext = "." + entry.name.split(".").pop();
            if (extensions.has(ext)) {
              try {
                const content = await readFile(fullPath, "utf-8");
                const relPath = relative(this.config.projectDir, fullPath).replace(/\\/g, "/");
                files.push({ path: relPath, content });
              } catch {
                // skip unreadable files
              }
            }
          }
        }
      } catch {
        // directory doesn't exist
      }
    };

    await walk(this.config.projectDir);
    return files;
  }
}
