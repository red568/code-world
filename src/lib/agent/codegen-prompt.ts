/**
 * Codegen Prompt — 根据规格和固定模板生成项目文件
 *
 * 支持两种模式：
 * 1. 整体生成：buildCodegenMessages（保留兼容，用于 iterate）
 * 2. 单文件生成：buildSingleFileMessages（Plan-based，新主流程）
 */

import { type LLMMessage } from "@/lib/llm";
import { type SpecResult } from "./spec-prompt";
import { type CodePlanFile } from "./plan-prompt";
import { TEMPLATE_FILE_TREE, EDITABLE_FILES_HINT } from "@/lib/template/files";

const CODEGEN_SYSTEM_PROMPT = `你是一个高级前端工程师。根据产品规格生成完整的 React + Vite + Tailwind 项目代码。

## 技术约束
- 使用 React 18 + TypeScript + Tailwind CSS
- 只能使用白名单依赖：react, react-dom, lucide-react, framer-motion, recharts
- 不要引入任何未在依赖白名单中的第三方包
- 使用函数组件和 hooks
- CSS 全部通过 Tailwind 类名实现，不要写自定义 CSS（index.css 中的 @tailwind 指令除外）
- 图片使用 placeholder URL（如 https://placehold.co/600x400）或 SVG 内联

## 代码质量要求
- 组件拆分合理，单个文件不超过 200 行
- 变量命名清晰，使用 PascalCase 组件名、camelCase 变量名
- 页面内容丰富真实，不使用大量 Lorem ipsum
- 确保所有 import 路径正确，组件间引用使用相对路径
- 确保 TypeScript 类型正确，避免使用 any

## 输出格式
你必须返回以下 JSON 格式（不要包含 markdown 代码块标记）：
{
  "files": [
    {
      "path": "src/App.tsx",
      "content": "文件完整内容"
    },
    {
      "path": "src/components/Hero.tsx",
      "content": "文件完整内容"
    }
  ]
}

## 注意事项
- src/main.tsx 已存在且不需要修改，它会渲染 App 组件
- 入口文件是 src/App.tsx，必须有默认导出
- 所有组件放在 src/components/ 目录下
- 工具函数放在 src/lib/ 目录下
- 静态资源放在 public/ 目录下`;

export function buildCodegenMessages(spec: SpecResult): LLMMessage[] {
  const userContent = `## 产品规格
${JSON.stringify(spec, null, 2)}

## 项目模板文件树
${TEMPLATE_FILE_TREE}

## 可修改的文件范围
${EDITABLE_FILES_HINT}

请根据以上产品规格生成项目代码。确保代码完整可运行，内容丰富。`;

  return [
    { role: "system", content: CODEGEN_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

/**
 * 迭代修改时使用的 Codegen Prompt
 * 带入当前文件树和用户新需求
 */
export function buildIterateCodegenMessages(
  spec: SpecResult,
  currentFiles: { path: string; content: string }[],
  userRequest: string
): LLMMessage[] {
  const filesSummary = currentFiles
    .map((f) => `### ${f.path}\n\`\`\`tsx\n${f.content}\n\`\`\``)
    .join("\n\n");

  const userContent = `## 产品规格
${JSON.stringify(spec, null, 2)}

## 当前项目文件
${filesSummary}

## 用户修改需求
${userRequest}

请根据用户需求修改代码。只返回需要修改或新增的文件，未变动的文件不要包含在返回中。
保持原有代码结构和风格，只做必要修改。`;

  return [
    { role: "system", content: CODEGEN_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export interface CodegenFile {
  path: string;
  content: string;
}

export interface CodegenResult {
  files: CodegenFile[];
}

export function parseCodegenResult(raw: string): CodegenResult {
  const cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // LLM 输出被截断时尝试修复 JSON
    const filesMatch = cleaned.match(/"files"\s*:\s*\[/);
    if (!filesMatch) {
      throw new Error("LLM 返回格式错误：未找到 files 数组");
    }

    // 尝试截取已完成的文件条目
    const files: CodegenFile[] = [];
    const filePattern = /\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
    let match;
    while ((match = filePattern.exec(cleaned)) !== null) {
      files.push({
        path: match[1],
        content: match[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      });
    }

    if (files.length === 0) {
      throw new Error("LLM 返回被截断且无法恢复任何文件");
    }

    return { files };
  }
}

// ─── 单文件生成（Plan-based）─────────────────────────────────────────────────

const SINGLE_FILE_SYSTEM_PROMPT = `你是一个高级前端工程师。根据产品规格和代码蓝图，生成指定文件的完整代码。

## 技术约束
- 使用 React 18 + TypeScript + Tailwind CSS
- 只能使用白名单依赖：react, react-dom, lucide-react, framer-motion, recharts
- 使用函数组件和 hooks
- CSS 全部通过 Tailwind 类名实现
- 图片使用 placeholder URL（如 https://placehold.co/600x400）或 SVG 内联

## 代码质量要求
- 变量命名清晰，使用 PascalCase 组件名、camelCase 变量名
- 页面内容丰富真实，不使用大量 Lorem ipsum
- 确保 TypeScript 类型正确，避免使用 any
- 单个文件不超过 200 行

## 输出格式
直接输出文件的完整代码内容，不要包含 markdown 代码块标记，不要包含 JSON 包装，不要包含文件路径注释。
只输出纯代码。`;

export interface SingleFileContext {
  spec: SpecResult;
  target: CodePlanFile;
  generatedFiles: { path: string; exports: string[] }[];
}

export function buildSingleFileMessages(ctx: SingleFileContext): LLMMessage[] {
  const depsInfo = ctx.target.imports_from.length > 0
    ? ctx.target.imports_from
        .map((depPath) => {
          const dep = ctx.generatedFiles.find((f) => f.path === depPath);
          if (dep) {
            return `- ${depPath} 导出: ${dep.exports.join(", ")}`;
          }
          return `- ${depPath}`;
        })
        .join("\n")
    : "无（独立文件）";

  const userContent = `## 产品规格
${JSON.stringify(ctx.spec, null, 2)}

## 当前任务
生成文件: ${ctx.target.path}
文件职责: ${ctx.target.role}
需要导出: ${ctx.target.exports.join(", ")}

## 依赖的已生成文件
${depsInfo}

## 注意事项
- import 路径使用相对路径（如 "./components/Header" 或 "../lib/utils"）
- 确保导出的名称与计划一致: ${ctx.target.exports.join(", ")}
- 直接输出完整代码，不要任何包装`;

  return [
    { role: "system", content: SINGLE_FILE_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export function parseSingleFileResult(raw: string): string {
  return raw
    .replace(/^```(?:tsx?|jsx?|css)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}
