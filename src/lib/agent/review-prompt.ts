/**
 * Review Prompt — 在真实构建前检查生成代码的明显问题
 */

import { type LLMMessage, safeJsonParse } from "@/lib/llm";
import { type SpecResult } from "./spec-prompt";
import { type CodegenFile } from "./codegen-prompt";

const REVIEW_SYSTEM_PROMPT = `你是一个代码审查专家。检查生成的 React + Vite + Tailwind 项目代码是否存在会导致构建失败的严重问题。

## 只检查以下会导致构建失败的 P0 问题
1. import 路径错误（引用的文件不存在于文件列表中）
2. 使用了未安装的依赖（白名单：react, react-dom, lucide-react, framer-motion, recharts）
3. JSX/TSX 语法错误（未闭合标签、括号不匹配）
4. 使用了浏览器不可用的 Node.js API（如 fs, path, process 等）
5. App.tsx 缺少默认导出
6. TypeScript 类型错误（会导致 tsc 编译失败的）

## 不要报告以下问题（忽略）
- 代码风格、命名规范
- 可访问性（a11y）建议
- 性能优化建议
- 内容是否丰富
- 最佳实践建议
- 任何不会导致 npm run build 失败的问题

## 输出格式
返回以下 JSON 格式（不要包含 markdown 代码块标记）：
{
  "passed": true/false,
  "issues": [
    {
      "severity": "error",
      "file": "文件路径",
      "problem": "问题描述",
      "suggested_fix": "建议修复方式"
    }
  ]
}

severity 只使用 "error"（会导致构建失败）。
如果没有会导致构建失败的问题，返回 {"passed": true, "issues": []}。
宁可漏报 warning 也不要误报 error。`;

export function buildReviewMessages(
  spec: SpecResult,
  files: CodegenFile[],
  packageJson: string
): LLMMessage[] {
  const fileTree = files.map((f) => f.path).join("\n");
  const keyFiles = files
    .filter(
      (f) =>
        f.path === "src/App.tsx" ||
        f.path === "package.json" ||
        f.path.startsWith("src/components/")
    )
    .map((f) => `### ${f.path}\n\`\`\`tsx\n${f.content}\n\`\`\``)
    .join("\n\n");

  const userContent = `## 产品规格
${JSON.stringify(spec, null, 2)}

## 文件树
${fileTree}

## package.json
\`\`\`json
${packageJson}
\`\`\`

## 关键文件内容
${keyFiles}

请检查以上代码是否存在明显问题。`;

  return [
    { role: "system", content: REVIEW_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export interface ReviewIssue {
  severity: "error" | "warning";
  file: string;
  problem: string;
  suggested_fix: string;
}

export interface ReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
}

export function parseReviewResult(raw: string): ReviewResult {
  return safeJsonParse<ReviewResult>(raw, "review");
}
