/**
 * Episode 记录器
 *
 * 每步执行后记录结构化元数据，用于后续检索召回。
 * Episodes 仅存在于沙盒内存中，不持久化。
 */

export interface Episode {
  stepNumber: number;
  toolName: string;
  toolSuccess: boolean;
  relatedFiles: string[];
  relatedSymbols: string[];
  resultSummary: string;
  codeChange?: { file: string; type: "create" | "modify" | "delete" };
  thinking: string;
}

export class EpisodeRecorder {
  private episodes: Episode[] = [];

  record(params: {
    stepNumber: number;
    toolName: string;
    toolSuccess: boolean;
    toolArgs: Record<string, unknown>;
    toolResult: string;
    thinking?: string;
  }): Episode {
    const { stepNumber, toolName, toolSuccess, toolArgs, toolResult, thinking } = params;

    const relatedFiles = this.extractRelatedFiles(toolName, toolArgs, toolResult);
    const relatedSymbols = this.extractSymbols(toolName, toolResult);
    const codeChange = this.detectCodeChange(toolName, toolArgs, toolResult);
    const resultSummary = this.summarizeResult(toolName, toolResult, toolSuccess);

    const episode: Episode = {
      stepNumber,
      toolName,
      toolSuccess,
      relatedFiles,
      relatedSymbols,
      resultSummary,
      codeChange,
      thinking: thinking?.slice(0, 200) || "",
    };

    this.episodes.push(episode);
    return episode;
  }

  getAll(): Episode[] {
    return this.episodes;
  }

  getRecent(count: number): Episode[] {
    return this.episodes.slice(-count);
  }

  private extractRelatedFiles(
    toolName: string,
    args: Record<string, unknown>,
    result: string
  ): string[] {
    const files: string[] = [];

    if (toolName === "write_file" || toolName === "read_file") {
      if (args.path) files.push(String(args.path));
    }

    if (toolName === "list_files" && result) {
      const paths = result.split("\n").filter((l) => /\.\w+$/.test(l));
      files.push(...paths.slice(0, 20));
    }

    // 从 shell 输出中提取文件引用
    if (toolName === "run_shell") {
      const fileRefs = result.match(/[\w\-\/]+\.(tsx?|jsx?|css|json)/g);
      if (fileRefs) files.push(...fileRefs.slice(0, 5));
    }

    return [...new Set(files)];
  }

  private extractSymbols(toolName: string, result: string): string[] {
    if (toolName !== "read_file" || !result) return [];

    const symbols: string[] = [];

    // 函数声明
    const funcMatches = result.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g);
    for (const m of funcMatches) symbols.push(m[1]);

    // const 组件/箭头函数
    const constMatches = result.matchAll(/(?:export\s+)?const\s+(\w+)\s*[=:]/g);
    for (const m of constMatches) symbols.push(m[1]);

    // interface / type
    const typeMatches = result.matchAll(/(?:export\s+)?(?:interface|type)\s+(\w+)/g);
    for (const m of typeMatches) symbols.push(m[1]);

    // class
    const classMatches = result.matchAll(/(?:export\s+)?class\s+(\w+)/g);
    for (const m of classMatches) symbols.push(m[1]);

    return [...new Set(symbols)].slice(0, 30);
  }

  private detectCodeChange(
    toolName: string,
    args: Record<string, unknown>,
    result: string
  ): Episode["codeChange"] | undefined {
    if (toolName !== "write_file") return undefined;

    const file = String(args.path || "");
    if (!file) return undefined;

    // 判断是创建还是修改：看 result 里是否有 "Written" 且之前是否读过
    const isCreate = !this.episodes.some(
      (ep) => ep.toolName === "read_file" && ep.relatedFiles.includes(file)
    );

    return { file, type: isCreate ? "create" : "modify" };
  }

  private summarizeResult(toolName: string, result: string, success: boolean): string {
    if (!success) {
      const errorLine = result.split("\n").find((l) => l.includes("Error") || l.includes("error"));
      return `失败: ${(errorLine || result).slice(0, 100)}`;
    }

    switch (toolName) {
      case "write_file":
        return result.slice(0, 80);
      case "read_file":
        const lines = result.split("\n").length;
        return `读取成功 (${lines} 行)`;
      case "run_shell":
        if (result.includes("exit_code: 0")) return "执行成功";
        return result.slice(0, 80);
      case "list_files":
        const count = result.split("\n").filter(Boolean).length;
        return `列出 ${count} 个文件`;
      case "get_preview_url":
        return result.slice(0, 100);
      case "ask_user":
        return `用户回答: ${result.slice(0, 80)}`;
      default:
        return result.slice(0, 80);
    }
  }
}
