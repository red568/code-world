import { Template } from "e2b";

export const template = Template()
  .fromNodeImage("20-slim")
  .setWorkdir("/home/user/app")

  // 项目配置文件
  .copy("package.json", "package.json")
  .copy("index.html", "index.html")
  .copy("vite.config.ts", "vite.config.ts")
  .copy("tsconfig.json", "tsconfig.json")
  .copy("tailwind.config.js", "tailwind.config.js")
  .copy("postcss.config.js", "postcss.config.js")

  // 源码骨架
  .copy("src/main.tsx", "src/main.tsx")
  .copy("src/App.tsx", "src/App.tsx")
  .copy("src/index.css", "src/index.css")
  .copy("src/vite-env.d.ts", "src/vite-env.d.ts")

  // 预装依赖
  .runCmd("npm install")
  .runCmd("npm run build || true");
