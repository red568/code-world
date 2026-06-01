# E2B 预构建 Template v2
#
# 基于 Node.js 20，包含：
# 1. agent-runtime（预编译）
# 2. 用户项目模板（React + Vite + Tailwind，预装依赖）
#
# 构建命令：e2b template build --name "ai-website-builder-v2"

FROM node:20-slim

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ─── Agent Runtime ────────────────────────────────────────────────────────────

WORKDIR /agent-runtime

# 复制并安装依赖
COPY agent-runtime/package*.json ./
RUN npm ci --production

# 复制源码并编译
COPY agent-runtime/tsconfig.json ./
COPY agent-runtime/src/ ./src/
RUN npx tsc

# ─── 用户项目模板 ─────────────────────────────────────────────────────────────

WORKDIR /home/user/app

# 复制模板文件
COPY package.json index.html vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY src/ ./src/

# 预装依赖
RUN npm install

# 预构建验证模板可用
RUN npm run build || true

# ─── 设置工作目录 ─────────────────────────────────────────────────────────────

WORKDIR /home/user

# 默认命令（会被 dispatcher 覆盖）
CMD ["node", "/agent-runtime/dist/main.js"]
