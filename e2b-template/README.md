# E2B 预构建 Template

此目录包含 E2B Sandbox 的预构建 Template 文件。

## 工作原理

E2B Template 是一个上传到 E2B 云端的预构建 Docker 镜像。工作流程如下：

```
本地 e2b-template/ 目录
  ↓  e2b template build（构建镜像并上传到 E2B 云端）
E2B 云端保存镜像，返回 Template ID（如 abc123xyz）
  ↓  将 Template ID 写入项目 .env 文件
应用运行时调用 Sandbox.create("abc123xyz")
  ↓  E2B 基于该镜像在云端创建一个沙盒实例
沙盒内已有 node_modules，直接写入业务代码 → build → 启动预览
```

**核心价值**：预装了所有白名单依赖，每次创建沙盒跳过 npm install，从 40-70 秒缩短到 8-13 秒。

## 首次配置

### 1. 注册 E2B 账号

前往 https://e2b.dev 注册账号，获取 API Key，写入项目根目录 `.env`：

```bash
E2B_API_KEY="your-e2b-api-key"
```

### 2. 安装 E2B CLI

```bash
npm install -g @e2b/cli
```

### 3. 登录

```bash
e2b auth login
```

浏览器会弹出授权页面，确认即可。

### 4. 构建并上传 Template

```bash
cd e2b-template
e2b template build --name "vite-react-tailwind"
```

构建过程大约 1-3 分钟（需要在云端执行 npm install）。完成后终端会输出：

```
✅ Template vite-react-tailwind created successfully
   Template ID: abc123xyz
```

### 5. 配置 Template ID

将返回的 ID 写入项目根目录 `.env`：

```bash
E2B_TEMPLATE_ID="abc123xyz"
```

配置完成后，应用创建沙盒时会自动使用这个 Template。

## 不配置 Template 也能运行

如果暂时不想配置自定义 Template，应用也能正常工作。代码中的 fallback 逻辑会：

1. 使用 E2B 默认的基础沙盒
2. 通过 `writeTemplateFiles()` 写入所有模板文件
3. 执行 `npm install` 安装依赖

唯一区别是每次创建项目会多等 30-60 秒（npm install 的时间）。

## Template 内容

- 基础镜像：Node.js 20
- 预装框架：React 18 + Vite 6 + TypeScript 5.6 + Tailwind CSS 3.4
- 预装白名单依赖：lucide-react、framer-motion、recharts
- 预执行 `npm install`，sandbox 创建后 node_modules 已就绪

## 更新 Template

当需要添加或更新白名单依赖时：

1. 修改本目录下的 `package.json`
2. 同步修改项目 `src/lib/template/files.ts` 中的 `TEMPLATE_PACKAGE_JSON`
3. 重新构建：
   ```bash
   cd e2b-template
   e2b template build --name "vite-react-tailwind"
   ```
4. 如果返回了新的 Template ID，更新 `.env` 中的 `E2B_TEMPLATE_ID`

## 目录结构

```
e2b-template/
├── e2b.Dockerfile        # Docker 构建文件（定义镜像内容）
├── package.json          # 预装依赖声明
├── index.html            # Vite 入口 HTML
├── vite.config.ts        # Vite 配置
├── tsconfig.json         # TypeScript 配置
├── tailwind.config.js    # Tailwind 配置
├── postcss.config.js     # PostCSS 配置
└── src/
    ├── main.tsx           # React 入口（不可修改）
    ├── App.tsx            # 默认 App 组件（会被生成代码覆盖）
    └── index.css          # Tailwind 指令
```

这些文件和项目 `src/lib/template/files.ts` 中的模板内容保持一致。修改时需要两边同步。
