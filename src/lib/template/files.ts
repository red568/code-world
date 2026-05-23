/**
 * 项目模板 — React + Vite + Tailwind 的固定模板文件
 *
 * 这些文件会预装在 E2B Template 中。
 * Codegen 只修改 src/ 和 public/ 下的业务文件，不碰配置文件。
 */

// 展示给 LLM 的文件树结构
export const TEMPLATE_FILE_TREE = `template-vite-react-tailwind/
  package.json          (谨慎修改：只允许添加白名单依赖)
  index.html            (不可修改)
  vite.config.ts        (不可修改)
  tsconfig.json         (不可修改)
  tailwind.config.js    (不可修改)
  postcss.config.js     (不可修改)
  src/
    main.tsx            (不可修改：入口文件，渲染 App 组件)
    App.tsx             (主入口组件，必须有默认导出)
    index.css           (可修改：Tailwind 指令和全局样式)
    components/         (组件目录，自由创建)
    lib/                (工具函数目录，自由创建)
  public/               (静态资源目录，自由创建)`;

// 告知 LLM 哪些文件可以修改
export const EDITABLE_FILES_HINT = `可自由创建和修改的文件：
- src/App.tsx
- src/index.css
- src/components/*.tsx（任意组件文件）
- src/lib/*.ts（任意工具文件）
- public/*（静态资源）

谨慎修改（仅限添加白名单依赖）：
- package.json

不可修改：
- index.html, vite.config.ts, tsconfig.json, tailwind.config.js, postcss.config.js, src/main.tsx`;

// ─── 模板文件内容 ──────────────────────────────────────────────────────────────

export const TEMPLATE_PACKAGE_JSON = `{
  "name": "generated-website",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "lucide-react": "^0.460.0",
    "framer-motion": "^11.12.0",
    "recharts": "^2.13.3"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.15",
    "typescript": "~5.6.2",
    "vite": "^6.0.1"
  }
}`;

export const TEMPLATE_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Generated Website</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

export const TEMPLATE_VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})`;

export const TEMPLATE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}`;

export const TEMPLATE_TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}`;

export const TEMPLATE_POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}`;

export const TEMPLATE_MAIN_TSX = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`;

export const TEMPLATE_INDEX_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;`;

export const TEMPLATE_VITE_ENV_DTS = `/// <reference types="vite/client" />`;

export const TEMPLATE_APP_TSX = `export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <h1 className="text-4xl font-bold text-gray-900">Hello World</h1>
    </div>
  )
}`;

/**
 * 获取完整的模板文件映射
 * 用于写入 E2B Sandbox 或作为 Codegen 的基础
 */
export function getTemplateFiles(): Record<string, string> {
  return {
    "package.json": TEMPLATE_PACKAGE_JSON,
    "index.html": TEMPLATE_INDEX_HTML,
    "vite.config.ts": TEMPLATE_VITE_CONFIG,
    "tsconfig.json": TEMPLATE_TSCONFIG,
    "tailwind.config.js": TEMPLATE_TAILWIND_CONFIG,
    "postcss.config.js": TEMPLATE_POSTCSS_CONFIG,
    "src/main.tsx": TEMPLATE_MAIN_TSX,
    "src/vite-env.d.ts": TEMPLATE_VITE_ENV_DTS,
    "src/index.css": TEMPLATE_INDEX_CSS,
    "src/App.tsx": TEMPLATE_APP_TSX,
  };
}
