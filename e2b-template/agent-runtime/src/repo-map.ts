/**
 * Repo Map 服务 — Node.js 包装层
 *
 * 调用 Python repomap_service.py 生成项目代码骨架。
 * 如果 Python 不可用，降级为简单的文件列表。
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { LoggerInterface } from "./types.js";

const PYTHON_SCRIPT = "/agent-runtime/tools/python/repomap_service.py";

export async function generateRepoMap(
  projectDir: string,
  maxTokens: number = 5000,
  logger?: LoggerInterface
): Promise<string> {
  // 尝试 Python tree-sitter 方式
  try {
    const result = await execPython(projectDir, maxTokens);
    if (result && result.map) {
      return result.map;
    }
  } catch (error) {
    logger?.info("Python repo map not available, falling back to simple mode", {
      error: String(error),
    });
  }

  // 降级：简单文件骨架
  return generateSimpleRepoMap(projectDir, maxTokens);
}

function execPython(
  projectDir: string,
  maxTokens: number
): Promise<{ map: string; tokens: number; files_count: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [PYTHON_SCRIPT, projectDir, String(maxTokens)],
      { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Failed to parse Python output"));
        }
      }
    );
  });
}

/**
 * 降级方案：遍历文件，用正则提取导出定义
 */
async function generateSimpleRepoMap(projectDir: string, maxTokens: number): Promise<string> {
  const extensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
  const skipDirs = new Set(["node_modules", ".git", "dist", ".next"]);

  const files: { path: string; content: string }[] = [];

  const walk = async (dir: string): Promise<void> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          await walk(join(dir, entry.name));
        } else {
          const ext = "." + entry.name.split(".").pop();
          if (extensions.has(ext)) {
            const fullPath = join(dir, entry.name);
            const content = await readFile(fullPath, "utf-8");
            const relPath = relative(projectDir, fullPath).replace(/\\/g, "/");
            files.push({ path: relPath, content });
          }
        }
      }
    } catch {
      // skip
    }
  };

  await walk(projectDir);

  if (files.length === 0) {
    return "No source files found.";
  }

  const lines: string[] = [];
  let tokenCount = 0;

  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const defs = extractDefinitionsSimple(file.content);
    if (defs.length === 0) continue;

    lines.push(`\n## ${file.path}`);
    tokenCount += file.path.length / 4;

    for (const def of defs) {
      lines.push(`  ${def}`);
      tokenCount += def.length / 4;

      if (tokenCount >= maxTokens) {
        lines.push("\n... (truncated)");
        return lines.join("\n");
      }
    }
  }

  return lines.join("\n") || "No definitions found.";
}

function extractDefinitionsSimple(code: string): string[] {
  const defs: string[] = [];
  const patterns = [
    /^(export\s+(?:default\s+)?(?:async\s+)?function\s+\w+.*?)[\s{]/gm,
    /^(export\s+(?:default\s+)?class\s+\w+.*?)[\s{]/gm,
    /^(export\s+(?:interface|type)\s+\w+.*?)[\s{=]/gm,
    /^(export\s+const\s+\w+)[\s:=]/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const line = match[1].trim();
      if (line.length <= 120) {
        defs.push(line);
      } else {
        defs.push(line.slice(0, 120) + "...");
      }
    }
  }

  return defs.slice(0, 30);
}
