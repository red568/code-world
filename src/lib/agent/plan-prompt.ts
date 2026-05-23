/**
 * Code Plan Prompt — 根据产品规格生成技术蓝图（文件清单、职责、依赖关系）
 *
 * Plan 输出轻量 JSON，告诉后续 executor 应该生成哪些文件、顺序和上下文。
 */

import { type LLMMessage } from "@/lib/llm";
import { safeJsonParse } from "@/lib/llm";
import { type SpecResult } from "./spec-prompt";
import { TEMPLATE_FILE_TREE, EDITABLE_FILES_HINT } from "@/lib/template/files";

const PLAN_SYSTEM_PROMPT = `你是一个高级前端架构师。根据产品规格规划代码结构，输出一个 Code Plan。

## 你的任务
分析产品规格，决定需要哪些文件、每个文件的职责、组件间的 import 关系和生成顺序。

## 技术约束
- 技术栈：React 18 + TypeScript + Vite + Tailwind CSS
- 白名单依赖：react, react-dom, lucide-react, framer-motion, recharts
- 使用函数组件和 hooks
- CSS 全部通过 Tailwind 类名实现

## 项目结构规则
- src/main.tsx 已存在，不需要生成
- src/App.tsx 是入口组件，必须存在且有默认导出
- 组件放在 src/components/ 目录
- 工具函数放在 src/lib/ 目录
- 静态资源放在 public/ 目录
- 单个文件不超过 300 行

## 精简原则（重要）
- 优先按页面/功能区域聚合，不要把 30-50 行的小组件单独拆文件
- 例如：导航栏+页脚可以合并为 Layout.tsx；同一页面的小区块直接内联
- 只在组件被多处复用时才单独拆文件
- 目标：用最少的文件完整实现需求，避免过度拆分

## 输出格式
返回以下 JSON（不要包含 markdown 代码块标记）：
{
  "files": [
    {
      "path": "src/components/Header.tsx",
      "role": "顶部导航栏，包含 logo、菜单链接和移动端汉堡菜单",
      "exports": ["Header"],
      "imports_from": []
    },
    {
      "path": "src/components/Hero.tsx",
      "role": "首屏区域，大标题+描述+CTA按钮，使用 framer-motion 入场动画",
      "exports": ["Hero"],
      "imports_from": []
    },
    {
      "path": "src/App.tsx",
      "role": "根组件，组合所有页面组件",
      "exports": ["default App"],
      "imports_from": ["src/components/Header.tsx", "src/components/Hero.tsx"]
    }
  ],
  "generation_order": ["src/components/Header.tsx", "src/components/Hero.tsx", "src/App.tsx"],
  "notes": "简要说明架构决策"
}

## 规则
- generation_order 中被依赖的文件必须排在前面（叶子组件先生成，App.tsx 最后）
- files 数组和 generation_order 必须包含完全相同的文件路径集合
- 每个文件的 imports_from 只能引用 files 中的其他文件路径
- src/index.css 如果需要自定义样式也要包含
- 文件数量控制在 3-8 个之间，用最少文件完整实现需求
- role 字段简洁，不超过 20 个字
- exports 中用 "default Xxx" 表示默认导出，用 "Xxx" 表示命名导出
- 所有组件统一使用 default export（除非一个文件导出多个工具函数）
- 不要规划 files 清单中不存在的组件，每个 import 必须有对应的文件`;

export interface CodePlanFile {
  path: string;
  role: string;
  exports: string[];
  imports_from: string[];
}

export interface CodePlan {
  files: CodePlanFile[];
  generation_order: string[];
  notes: string;
}

export function buildPlanMessages(spec: SpecResult): LLMMessage[] {
  const userContent = `## 产品规格
${JSON.stringify(spec, null, 2)}

## 项目模板文件树
${TEMPLATE_FILE_TREE}

## 可修改的文件范围
${EDITABLE_FILES_HINT}

请规划代码结构，输出 Code Plan。`;

  return [
    { role: "system", content: PLAN_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export function parsePlanResult(raw: string): CodePlan {
  const plan: CodePlan = safeJsonParse(raw, "plan");

  if (!plan.files || !Array.isArray(plan.files) || plan.files.length === 0) {
    throw new Error("Code Plan 格式错误：files 为空");
  }
  if (!plan.generation_order || !Array.isArray(plan.generation_order) || plan.generation_order.length === 0) {
    throw new Error("Code Plan 格式错误：generation_order 为空");
  }

  const filePaths = new Set(plan.files.map((f) => f.path));
  for (const path of plan.generation_order) {
    if (!filePaths.has(path)) {
      throw new Error(`Code Plan 不一致：generation_order 中的 "${path}" 不在 files 中`);
    }
  }
  for (const f of plan.files) {
    if (!plan.generation_order.includes(f.path)) {
      throw new Error(`Code Plan 不一致：files 中的 "${f.path}" 不在 generation_order 中`);
    }
  }

  return plan;
}
