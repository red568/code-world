/**
 * Fix Prompt — 根据真实构建错误日志和相关文件修复代码
 */

import { type LLMMessage } from "@/lib/llm";
import { type SpecResult } from "./spec-prompt";
import { type CodegenFile } from "./codegen-prompt";

// 错误类型，用于分类和针对性修复
export type ErrorCategory =
  | "dependency_missing"
  | "import_error"
  | "jsx_syntax"
  | "typescript_error"
  | "build_error"
  | "startup_error"
  | "unknown";

const FIX_SYSTEM_PROMPT = `你是一个构建错误修复专家。根据真实的命令输出和错误日志修复 React + Vite + Tailwind 项目代码。

## 修复原则
- 只修改必要的文件，尽量保持现有代码不变
- 如果缺少依赖且在白名单内（lucide-react, framer-motion, recharts），在 package.json 中添加
- 如果缺少依赖且不在白名单内，改用白名单内的替代方案或移除该功能
- 修复 import 路径时，确保目标文件确实存在
- 修复 TypeScript 错误时，优先修正类型而非使用 any
- 如果错误无法修复，简化相关功能实现

## 输出格式
返回以下 JSON 格式（不要包含 markdown 代码块标记）：
{
  "diagnosis": "错误诊断说明",
  "files": [
    {
      "path": "文件路径",
      "content": "修复后的完整文件内容"
    }
  ]
}`;

export interface FixContext {
  spec: SpecResult;
  command: string;
  stdout: string;
  stderr: string;
  errorCategory: ErrorCategory;
  relatedFiles: CodegenFile[];
  packageJson: string;
  fileTree: string[];
  previousAttempts: string[];
}

export function buildFixMessages(ctx: FixContext): LLMMessage[] {
  const relatedFilesStr = ctx.relatedFiles
    .map((f) => `### ${f.path}\n\`\`\`tsx\n${f.content}\n\`\`\``)
    .join("\n\n");

  const prevAttemptsStr =
    ctx.previousAttempts.length > 0
      ? `## 前几次修复尝试\n${ctx.previousAttempts.map((a, i) => `第 ${i + 1} 次：${a}`).join("\n")}`
      : "";

  const userContent = `## 产品规格
${JSON.stringify(ctx.spec, null, 2)}

## 执行的命令
${ctx.command}

## stdout
\`\`\`
${ctx.stdout.slice(-2000)}
\`\`\`

## stderr
\`\`\`
${ctx.stderr.slice(-2000)}
\`\`\`

## 错误分类
${ctx.errorCategory}

## 相关文件
${relatedFilesStr}

## package.json
\`\`\`json
${ctx.packageJson}
\`\`\`

## 文件树
${ctx.fileTree.join("\n")}

${prevAttemptsStr}

请诊断错误并提供修复方案。`;

  return [
    { role: "system", content: FIX_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export interface FixResult {
  diagnosis: string;
  files: CodegenFile[];
}

export function parseFixResult(raw: string): FixResult {
  const cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  return JSON.parse(cleaned);
}

/**
 * 根据 stderr 内容自动分类错误类型
 */
export function classifyError(stderr: string): ErrorCategory {
  if (/Cannot find module|Module not found|Cannot resolve/i.test(stderr)) {
    return "dependency_missing";
  }
  if (/Failed to resolve import|Could not resolve/i.test(stderr)) {
    return "import_error";
  }
  if (/Unexpected token|Unterminated|Expected/i.test(stderr)) {
    return "jsx_syntax";
  }
  if (/Type '.*' is not assignable|Property .* does not exist/i.test(stderr)) {
    return "typescript_error";
  }
  if (/vite.*build.*failed|Build failed/i.test(stderr)) {
    return "build_error";
  }
  if (/EADDRINUSE|script.*missing|ERR_MODULE/i.test(stderr)) {
    return "startup_error";
  }
  return "unknown";
}
