# E2B 预构建 Template v2
#
# 基于 Node.js 20，包含：
# 1. agent-runtime（预编译）
# 2. 用户项目模板（React + Vite + Tailwind，预装依赖）
#
# 构建命令：e2b template build --name "ai-website-builder-v2"

FROM node:20-slim

# 安装系统依赖 + Python（Repo Map 用）
RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3-minimal \
    python3-pip \
    && pip3 install tree-sitter grep-ast tree-sitter-languages --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

# ─── Agent Runtime ────────────────────────────────────────────────────────────

WORKDIR /agent-runtime

# 复制并安装全部依赖（含 devDependencies 用于编译）
COPY agent-runtime/package.json ./
RUN npm install

# 复制源码并编译
COPY agent-runtime/tsconfig.json ./
COPY agent-runtime/src/ ./src/
RUN npx tsc

# 复制 Python 工具
COPY agent-runtime/tools/ ./tools/

# 编译完成，清理 devDependencies 减小体积
RUN npm prune --omit=dev

# ─── 用户项目模板 ─────────────────────────────────────────────────────────────

WORKDIR /home/user/app

# 复制模板配置文件（逐个 COPY 确保 E2B v2 构建系统正确处理）
COPY package.json ./
COPY index.html ./
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY tailwind.config.js ./
COPY postcss.config.js ./
COPY src/ ./src/

# 预装依赖
RUN npm install

# 预构建验证模板可用
RUN npm run build || true

# ─── 设置工作目录 ─────────────────────────────────────────────────────────────

WORKDIR /home/user

# 默认命令：保持容器存活，实际执行由 dispatcher 通过 sandbox.commands.run 触发
CMD ["sleep", "infinity"]
