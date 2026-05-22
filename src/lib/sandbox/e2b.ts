/**
 * E2B Sandbox 服务
 *
 * 封装与 E2B 的所有交互：创建 sandbox、写入文件、执行命令、获取预览 URL。
 * 使用预构建 Template，跳过 npm install 以加速启动。
 */

import { Sandbox } from "@e2b/code-interpreter";
import { getTemplateFiles } from "@/lib/template";

const E2B_TEMPLATE_ID = process.env.E2B_TEMPLATE_ID || "vite-react-tailwind";
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时
const DEV_SERVER_PORT = 5173;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxInstance {
  sandbox: Sandbox;
  sandboxId: string;
}

/**
 * 创建预构建 Template 的 E2B Sandbox
 * 如果使用了自定义 Template，sandbox 内已包含 node_modules
 */
export async function createSandbox(): Promise<SandboxInstance> {
  const sandbox = await Sandbox.create(E2B_TEMPLATE_ID, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });

  return {
    sandbox,
    sandboxId: sandbox.sandboxId,
  };
}

/**
 * 将模板配置文件写入 sandbox
 * 当 E2B Template 未预装模板文件时使用（fallback 方案）
 */
export async function writeTemplateFiles(sandbox: Sandbox): Promise<void> {
  const files = getTemplateFiles();
  for (const [path, content] of Object.entries(files)) {
    await sandbox.files.write(path, content);
  }
}

/**
 * 将生成的业务文件写入 sandbox
 */
export async function writeProjectFiles(
  sandbox: Sandbox,
  files: { path: string; content: string }[]
): Promise<void> {
  for (const file of files) {
    // 确保目录存在
    const dir = file.path.split("/").slice(0, -1).join("/");
    if (dir) {
      await sandbox.commands.run(`mkdir -p ${dir}`);
    }
    await sandbox.files.write(file.path, file.content);
  }
}

/**
 * 执行 shell 命令并收集输出
 */
export async function runCommand(
  sandbox: Sandbox,
  command: string,
  onStdout?: (line: string) => void,
  onStderr?: (line: string) => void
): Promise<CommandResult> {
  const result = await sandbox.commands.run(command, {
    timeoutMs: 120_000,
    onStdout: onStdout ? (data: string) => onStdout(data) : undefined,
    onStderr: onStderr ? (data: string) => onStderr(data) : undefined,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * 安装额外依赖（仅用于白名单外但修复时需要的依赖）
 */
export async function installDependency(
  sandbox: Sandbox,
  packageName: string
): Promise<CommandResult> {
  return runCommand(sandbox, `npm install ${packageName}`);
}

/**
 * 执行项目构建
 */
export async function buildProject(
  sandbox: Sandbox,
  onStdout?: (line: string) => void,
  onStderr?: (line: string) => void
): Promise<CommandResult> {
  return runCommand(sandbox, "npm run build", onStdout, onStderr);
}

/**
 * 启动 Vite 开发服务器
 * 返回公网可访问的预览 URL
 */
export async function startDevServer(sandbox: Sandbox): Promise<string> {
  // 后台启动 dev server，不等待完成
  sandbox.commands.run(
    `npm run dev -- --host 0.0.0.0 --port ${DEV_SERVER_PORT}`,
    { timeoutMs: SANDBOX_TIMEOUT_MS }
  );

  // 等待 dev server 启动
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const host = sandbox.getHost(DEV_SERVER_PORT);
  return `https://${host}`;
}

/**
 * 读取 sandbox 中的文件内容
 */
export async function readFile(
  sandbox: Sandbox,
  path: string
): Promise<string> {
  return sandbox.files.read(path);
}

/**
 * 列出 sandbox 中 src/ 目录下的文件树
 */
export async function listProjectFiles(sandbox: Sandbox): Promise<string[]> {
  const result = await sandbox.commands.run(
    "find src/ -type f -name '*.tsx' -o -name '*.ts' -o -name '*.css' | sort"
  );
  return result.stdout
    .split("\n")
    .filter(Boolean);
}

/**
 * 延长 sandbox 生命周期
 */
export async function keepAlive(
  sandbox: Sandbox,
  timeoutMs: number = SANDBOX_TIMEOUT_MS
): Promise<void> {
  await sandbox.setTimeout(timeoutMs);
}

/**
 * 停止 sandbox
 */
export async function stopSandbox(sandbox: Sandbox): Promise<void> {
  await sandbox.kill();
}
