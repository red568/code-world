# E2B 预构建 Template
#
# 基于 Node.js 20，预装 React + Vite + Tailwind 和所有白名单依赖。
# 构建命令：e2b template build --name "vite-react-tailwind"

FROM node:20-slim

WORKDIR /home/user/app

# 复制模板文件
COPY package.json index.html vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY src/ ./src/

# 预装依赖，后续 sandbox 创建后无需再 npm install
RUN npm install

# 预构建一次确保模板可用
RUN npm run build || true
