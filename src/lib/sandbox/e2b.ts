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
 */
export async function createSandbox(): Promise<SandboxInstance> {
  const startTime = Date.now();
  console.log(`[Sandbox] 创建沙箱 | template=${E2B_TEMPLATE_ID} | timeout=${SANDBOX_TIMEOUT_MS}ms`);

  try {
    const sandbox = await Sandbox.create(E2B_TEMPLATE_ID, {
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Sandbox] 沙箱就绪 | id=${sandbox.sandboxId} | ${duration}s`);

    return {
      sandbox,
      sandboxId: sandbox.sandboxId,
    };
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Sandbox] 创建失败 | ${duration}s | error=${message}`);
    throw error;
  }
}

/**
 * 将模板配置文件写入 sandbox
 */
export async function writeTemplateFiles(sandbox: Sandbox): Promise<void> {
  const files = getTemplateFiles();
  const count = Object.keys(files).length;
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 写入模板文件 | count=${count}`);

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
  const startTime = Date.now();
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 写入项目文件 | count=${files.length}`);

  for (const file of files) {
    const dir = file.path.split("/").slice(0, -1).join("/");
    if (dir) {
      await sandbox.commands.run(`mkdir -p ${dir}`);
    }
    await sandbox.files.write(file.path, file.content);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 文件写入完成 | ${duration}s`);
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
  const startTime = Date.now();
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 执行命令: ${command}`);

  try {
    const result = await sandbox.commands.run(command, {
      timeoutMs: 120_000,
      onStdout: onStdout ? (data: string) => onStdout(data) : undefined,
      onStderr: onStderr ? (data: string) => onStderr(data) : undefined,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 命令完成 | exitCode=${result.exitCode} | ${duration}s`);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 命令异常 | ${duration}s | error=${message}`);

    // E2B SDK CommandHandle.wait() throws on non-zero exit code in some versions
    // Extract exit code from error message if possible (format: "exit status N")
    const exitCodeMatch = message.match(/exit status (\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 1;

    return {
      stdout: "",
      stderr: message,
      exitCode,
    };
  }
}

/**
 * 安装额外依赖
 */
export async function installDependency(
  sandbox: Sandbox,
  packageName: string
): Promise<CommandResult> {
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 安装依赖: ${packageName}`);
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
 */
export async function startDevServer(sandbox: Sandbox): Promise<string> {
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 启动 dev server | port=${DEV_SERVER_PORT}`);

  sandbox.commands.run(
    `npm run dev -- --host 0.0.0.0 --port ${DEV_SERVER_PORT}`,
    { timeoutMs: SANDBOX_TIMEOUT_MS }
  );

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const host = sandbox.getHost(DEV_SERVER_PORT);
  const url = `https://${host}`;
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] dev server 就绪 | url=${url}`);
  return url;
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
  console.log(`[Sandbox] [${sandbox.sandboxId.slice(0, 8)}] 停止沙箱`);
  await sandbox.kill();
}
