import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 排除不需要 Webpack 打包的服务端依赖，减小构建内存占用
  serverExternalPackages: [
    "bullmq",
    "ioredis",
    "@prisma/adapter-pg",
    "pg",
    "@e2b/code-interpreter",
    "e2b",
  ],
};

export default nextConfig;
