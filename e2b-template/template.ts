import { Template } from "e2b";

export const template = Template()
  .fromNodeImage("20-slim")

  // ─── 系统依赖 + Python（Repo Map 用）—— 需要 root 权限 ────────────────
  .runCmd("sudo apt-get update && sudo apt-get install -y git curl python3-minimal python3-pip && sudo pip3 install tree-sitter grep-ast tree-sitter-languages --break-system-packages && sudo rm -rf /var/lib/apt/lists/*")

  // ─── Agent Runtime ─────────────────────────────────────────────────────
  .setWorkdir("/agent-runtime")
  .copy("agent-runtime/package.json", "package.json")
  .runCmd("sudo npm install")
  .copy("agent-runtime/tsconfig.json", "tsconfig.json")
  .copy("agent-runtime/src", "src")
  .runCmd("sudo npx tsc")
  .copy("agent-runtime/tools", "tools")
  .runCmd("sudo npm prune --omit=dev")

  // ─── 用户项目模板 ─────────────────────────────────────────────────────
  .setWorkdir("/home/user/app")
  .copy("package.json", "package.json")
  .copy("index.html", "index.html")
  .copy("vite.config.ts", "vite.config.ts")
  .copy("tsconfig.json", "tsconfig.json")
  .copy("tailwind.config.js", "tailwind.config.js")
  .copy("postcss.config.js", "postcss.config.js")
  .copy("src/main.tsx", "src/main.tsx")
  .copy("src/App.tsx", "src/App.tsx")
  .copy("src/index.css", "src/index.css")
  .copy("src/vite-env.d.ts", "src/vite-env.d.ts")
  .runCmd("npm install")
  .runCmd("npm run build || true")

  // ─── 工作目录 ─────────────────────────────────────────────────────────
  .setWorkdir("/home/user");
