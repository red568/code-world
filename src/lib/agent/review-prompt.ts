/**
 * Review Prompt — 在真实构建前检查生成代码的明显问题
 */

import { type LLMMessage } from "@/lib/llm";
import { type SpecResult } from "./spec-prompt";
import { type CodegenFile } from "./codegen-prompt";

const REVIEW_SYSTEM_PROMPT = `你是一个代码审查专家。检查生成的 React + Vite + Tailwind 项目代码是否存在明显问题。

## 检查清单
1. import 路径是否正确（引用的文件是否存在于文件列表中）
2. 是否使用了未安装的依赖（白名单：react, react-dom, lucide-react, framer-motion, recharts）
3. JSX/TSX 是否有语法错误（未闭合标签、括号不匹配等）
4. 是否使用了浏览器不可用的 Node.js API（如 fs, path, process 等）
5. 是否符合固定技术栈（React + Vite + Tailwind）
6. 是否存在空页面或纯占位内容
7. App.tsx 是否有默认导出
8. TypeScript 类型是否有明显错误

## 输出格式
返回以下 JSON 格式（不要包含 markdown 代码块标记）：
{
  "passed": true/false,
  "issues": [
    {
      "severity": "error | warning",
      "file": "文件路径",
      "problem": "问题描述",
      "suggested_fix": "建议修复方式"
    }
  ]
}

如果没有问题，返回 {"passed": true, "issues": []}`;

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
  const cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  return JSON.parse(cleaned);
}
