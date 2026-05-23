/**
 * Spec Prompt — 将用户模糊需求转成结构化产品规格
 */

import { type LLMMessage, safeJsonParse } from "@/lib/llm";

const SPEC_SYSTEM_PROMPT = `你是一个专业的产品规格分析师。你的任务是将用户的网站需求转化为结构化的产品规格 JSON。

## 平台能力边界
- 只能生成前端网站或轻量全栈 Demo
- 技术栈固定为 React + Vite + TypeScript + Tailwind CSS
- 可选内置依赖：lucide-react（图标）、framer-motion（动画）、recharts（图表）
- 不支持自定义后端、不支持数据库操作
- 生成的网站必须能通过 npm run dev 直接运行

## UI/UX 质量要求
- 使用现代化设计，注重视觉层次
- 响应式布局，移动端友好
- 合理使用颜色、间距、字体大小
- 内容必须丰富真实，不使用大量 Lorem ipsum 占位

## 输出格式
你必须返回以下 JSON 格式（不要包含 markdown 代码块标记）：
{
  "app_type": "landing_page | dashboard | portfolio | blog | e_commerce | form_app | other",
  "title": "项目标题",
  "description": "一句话描述",
  "pages": ["home"],
  "features": ["feature1", "feature2"],
  "style": {
    "tone": "描述整体风格，如 modern premium / playful colorful / minimal clean",
    "primaryColor": "主色调建议，如 #3B82F6",
    "layout": "布局描述，如 responsive single page"
  },
  "components": ["组件列表，如 Hero, Navbar, Footer, Gallery"],
  "dependencies": ["需要的额外依赖，只能从白名单选择：lucide-react, framer-motion, recharts"],
  "constraints": [
    "must use React + Vite + Tailwind",
    "must not require custom backend",
    "must run with npm run dev"
  ]
}`;

export function buildSpecMessages(userPrompt: string): LLMMessage[] {
  return [
    { role: "system", content: SPEC_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

export interface SpecResult {
  app_type: string;
  title: string;
  description: string;
  pages: string[];
  features: string[];
  style: {
    tone: string;
    primaryColor?: string;
    layout: string;
  };
  components: string[];
  dependencies: string[];
  constraints: string[];
}

/**
 * 从 LLM 原始响应中解析出 Spec JSON
 * 兼容带或不带 markdown 代码块标记的情况
 */
export function parseSpecResult(raw: string): SpecResult {
  return safeJsonParse<SpecResult>(raw, "spec");
}
