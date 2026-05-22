/**
 * Agent 编排器
 *
 * 协调完整的代码生成流程：Spec → Codegen → Review → Build → Fix → Preview
 * 每个阶段的产物写入数据库，事件通过 Redis pub/sub 推送到前端。
 */

import { prisma } from "@/lib/prisma";
import { chatCompletion, chatCompletionStream } from "@/lib/llm";
import {
  buildSpecMessages,
  parseSpecResult,
  buildCodegenMessages,
  buildIterateCodegenMessages,
  parseCodegenResult,
  buildReviewMessages,
  parseReviewResult,
  buildFixMessages,
  parseFixResult,
  classifyError,
  type SpecResult,
  type CodegenFile,
} from "@/lib/agent";
import {
  createSandbox,
  writeTemplateFiles,
  writeProjectFiles,
  buildProject,
  startDevServer,
  listProjectFiles,
  readFile,
  stopSandbox,
} from "@/lib/sandbox";
import { getTemplateFiles, TEMPLATE_PACKAGE_JSON } from "@/lib/template/files";
import {
  publishEvent,
  publishStatusChange,
  publishBuildLog,
  publishError,
} from "@/lib/streaming";
import type { Sandbox } from "@e2b/code-interpreter";

const MAX_FIX_ATTEMPTS = 3;

/**
 * 更新项目状态并推送事件
 */
async function updateProjectStatus(
  projectId: string,
  status: Parameters<typeof publishStatusChange>[1],
  message: string
) {
  await prisma.project.update({
    where: { id: projectId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { status: status as any },
  });
  await publishStatusChange(projectId, status, message);
}

/**
 * 记录 Agent 运行
 */
async function recordAgentRun(
  projectId: string,
  type: "spec" | "codegen" | "review" | "fix",
  inputSummary: string,
  outputJson: unknown,
  status: "completed" | "failed" = "completed"
) {
  await prisma.agentRun.create({
    data: {
      projectId,
      type,
      inputSummary,
      outputJson: outputJson as object,
      status,
    },
  });
}

// ─── 阶段 1：Spec 生成 ──────────────────────────────────────────────────────────

async function runSpec(projectId: string, prompt: string): Promise<SpecResult> {
  await updateProjectStatus(projectId, "spec_generating", "正在分析需求...");

  const messages = buildSpecMessages(prompt);
  let fullResponse = "";

  // 流式输出 Spec 生成过程
  for await (const chunk of chatCompletionStream(messages)) {
    fullResponse += chunk;
    await publishEvent(projectId, {
      type: "spec_chunk",
      data: { chunk },
    });
  }

  const spec = parseSpecResult(fullResponse);

  // 保存 Spec 到项目
  await prisma.project.update({
    where: { id: projectId },
    data: {
      specJson: spec as object,
      title: spec.title || "Untitled",
    },
  });

  await publishEvent(projectId, {
    type: "spec_done",
    data: { specJson: spec as unknown as Record<string, unknown> },
  });

  await recordAgentRun(projectId, "spec", prompt.slice(0, 200), spec);
  return spec;
}

// ─── 阶段 2：Codegen 代码生成 ───────────────────────────────────────────────────

async function runCodegen(
  projectId: string,
  spec: SpecResult
): Promise<CodegenFile[]> {
  await updateProjectStatus(projectId, "code_generating", "正在生成代码...");

  const messages = buildCodegenMessages(spec);
  let fullResponse = "";

  for await (const chunk of chatCompletionStream(messages, { maxTokens: 8192 })) {
    fullResponse += chunk;
  }

  const result = parseCodegenResult(fullResponse);

  // 逐文件推送事件并保存到数据库
  for (const file of result.files) {
    await publishEvent(projectId, {
      type: "codegen_file_start",
      data: { path: file.path },
    });

    await prisma.projectFile.upsert({
      where: { projectId_path: { projectId, path: file.path } },
      create: { projectId, path: file.path, content: file.content },
      update: { content: file.content, version: { increment: 1 } },
    });

    await publishEvent(projectId, {
      type: "codegen_file_done",
      data: { path: file.path },
    });
  }

  await publishEvent(projectId, {
    type: "codegen_done",
    data: { fileCount: result.files.length },
  });

  await recordAgentRun(
    projectId,
    "codegen",
    `${result.files.length} files`,
    { filePaths: result.files.map((f) => f.path) }
  );

  return result.files;
}

/**
 * 迭代修改：基于现有文件和新需求生成代码
 */
async function runIterateCodegen(
  projectId: string,
  spec: SpecResult,
  userRequest: string
): Promise<CodegenFile[]> {
  await updateProjectStatus(projectId, "code_generating", "正在修改代码...");

  // 读取当前文件
  const dbFiles = await prisma.projectFile.findMany({ where: { projectId } });
  const currentFiles = dbFiles.map((f) => ({ path: f.path, content: f.content }));

  const messages = buildIterateCodegenMessages(spec, currentFiles, userRequest);
  let fullResponse = "";

  for await (const chunk of chatCompletionStream(messages, { maxTokens: 8192 })) {
    fullResponse += chunk;
  }

  const result = parseCodegenResult(fullResponse);

  for (const file of result.files) {
    await publishEvent(projectId, {
      type: "codegen_file_start",
      data: { path: file.path },
    });

    await prisma.projectFile.upsert({
      where: { projectId_path: { projectId, path: file.path } },
      create: { projectId, path: file.path, content: file.content },
      update: { content: file.content, version: { increment: 1 } },
    });

    await publishEvent(projectId, {
      type: "codegen_file_done",
      data: { path: file.path },
    });
  }

  await publishEvent(projectId, {
    type: "codegen_done",
    data: { fileCount: result.files.length },
  });

  return result.files;
}

// ─── 阶段 3：Review 代码审查 ────────────────────────────────────────────────────

async function runReview(
  projectId: string,
  spec: SpecResult,
  files: CodegenFile[]
): Promise<boolean> {
  await updateProjectStatus(projectId, "reviewing", "正在审查代码...");

  const packageJson =
    files.find((f) => f.path === "package.json")?.content ||
    TEMPLATE_PACKAGE_JSON;

  const messages = buildReviewMessages(spec, files, packageJson);
  const response = await chatCompletion(messages);
  const result = parseReviewResult(response);

  // 推送每个审查问题
  for (const issue of result.issues) {
    await publishEvent(projectId, {
      type: "review_issue",
      data: {
        severity: issue.severity,
        file: issue.file,
        problem: issue.problem,
      },
    });
  }

  await publishEvent(projectId, {
    type: "review_done",
    data: { passed: result.passed, issueCount: result.issues.length },
  });

  await recordAgentRun(projectId, "review", `${files.length} files`, result);
  return result.passed;
}

// ─── 阶段 4：构建和自动修复 ──────────────────────────────────────────────────────

async function runBuildAndFix(
  projectId: string,
  spec: SpecResult,
  sandbox: Sandbox
): Promise<{ success: boolean; previewUrl?: string }> {
  const fixSummaries: string[] = [];

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    await updateProjectStatus(
      projectId,
      attempt === 1 ? "building" : "fixing",
      attempt === 1 ? "正在构建项目..." : `正在修复（第 ${attempt - 1} 轮）...`
    );

    // 执行构建，实时推送日志
    const buildResult = await buildProject(
      sandbox,
      (line) => publishBuildLog(projectId, "stdout", line),
      (line) => publishBuildLog(projectId, "stderr", line)
    );

    // 记录构建日志
    await prisma.buildLog.create({
      data: {
        projectId,
        command: "npm run build",
        stdout: buildResult.stdout,
        stderr: buildResult.stderr,
        exitCode: buildResult.exitCode,
        attempt,
      },
    });

    // 构建成功 → 启动 dev server
    if (buildResult.exitCode === 0) {
      await updateProjectStatus(projectId, "running", "构建成功，正在启动预览...");
      const previewUrl = await startDevServer(sandbox);

      await prisma.project.update({
        where: { id: projectId },
        data: { previewUrl, sandboxId: sandbox.sandboxId },
      });

      await prisma.sandboxSession.upsert({
        where: { projectId },
        create: {
          projectId,
          sandboxId: sandbox.sandboxId,
          status: "running",
          previewUrl,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
        update: {
          sandboxId: sandbox.sandboxId,
          status: "running",
          previewUrl,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });

      await publishEvent(projectId, {
        type: "preview_ready",
        data: { previewUrl },
      });

      return { success: true, previewUrl };
    }

    // 最后一次尝试也失败了
    if (attempt === MAX_FIX_ATTEMPTS) {
      break;
    }

    // 构建失败 → 尝试自动修复
    const errorCategory = classifyError(buildResult.stderr);
    await publishEvent(projectId, {
      type: "fix_start",
      data: { attempt, diagnosis: `错误类型: ${errorCategory}` },
    });

    // 收集修复所需的上下文
    const fileTree = await listProjectFiles(sandbox);
    const relatedFiles: CodegenFile[] = [];
    const dbFiles = await prisma.projectFile.findMany({ where: { projectId } });

    for (const f of dbFiles) {
      relatedFiles.push({ path: f.path, content: f.content });
    }

    const currentPackageJson =
      dbFiles.find((f) => f.path === "package.json")?.content ||
      TEMPLATE_PACKAGE_JSON;

    const fixMessages = buildFixMessages({
      spec,
      command: "npm run build",
      stdout: buildResult.stdout,
      stderr: buildResult.stderr,
      errorCategory,
      relatedFiles,
      packageJson: currentPackageJson,
      fileTree,
      previousAttempts: fixSummaries,
    });

    const fixResponse = await chatCompletion(fixMessages, { maxTokens: 8192 });
    const fixResult = parseFixResult(fixResponse);

    // 应用修复的文件
    await writeProjectFiles(sandbox, fixResult.files);
    for (const file of fixResult.files) {
      await prisma.projectFile.upsert({
        where: { projectId_path: { projectId, path: file.path } },
        create: { projectId, path: file.path, content: file.content },
        update: { content: file.content, version: { increment: 1 } },
      });
    }

    // 更新构建日志的诊断
    await prisma.buildLog.updateMany({
      where: { projectId, attempt },
      data: { diagnosis: fixResult.diagnosis },
    });

    fixSummaries.push(fixResult.diagnosis);

    await publishEvent(projectId, {
      type: "fix_done",
      data: { attempt, success: false },
    });

    await recordAgentRun(projectId, "fix", fixResult.diagnosis, fixResult);
  }

  // 所有修复尝试都失败
  await updateProjectStatus(projectId, "failed", "构建失败，已尝试自动修复但未成功");
  return { success: false };
}

// ─── 主编排流程 ──────────────────────────────────────────────────────────────────

/**
 * 执行完整的生成流程：Spec → Codegen → Review → Build → Fix → Preview
 */
export async function orchestrateGenerate(
  projectId: string,
  prompt: string
): Promise<void> {
  let sandbox: Sandbox | null = null;

  try {
    // 1. 生成 Spec
    const spec = await runSpec(projectId, prompt);

    // 2. 生成代码
    const files = await runCodegen(projectId, spec);

    // 3. Review 代码
    await runReview(projectId, spec, files);

    // 4. 创建 Sandbox 并写入文件
    const instance = await createSandbox();
    sandbox = instance.sandbox;

    // 写入模板文件（如果 E2B Template 未预装）
    await writeTemplateFiles(sandbox);

    // 合并模板文件和生成文件
    const templateFiles = getTemplateFiles();
    const allFiles: CodegenFile[] = [
      ...Object.entries(templateFiles).map(([path, content]) => ({ path, content })),
      ...files, // 生成文件覆盖模板文件
    ];

    await writeProjectFiles(sandbox, allFiles);

    // 5. 构建和自动修复
    const result = await runBuildAndFix(projectId, spec, sandbox);
    if (!result.success) {
      await stopSandbox(sandbox);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await publishError(projectId, message, "ORCHESTRATION_ERROR");
    await updateProjectStatus(projectId, "failed", `生成失败: ${message}`);

    if (sandbox) {
      try {
        await stopSandbox(sandbox);
      } catch {
        // sandbox 清理失败不阻塞
      }
    }
  }
}

/**
 * 执行迭代修改流程：基于现有项目和新需求修改代码
 */
export async function orchestrateIterate(
  projectId: string,
  prompt: string
): Promise<void> {
  let sandbox: Sandbox | null = null;

  try {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    });

    const spec = project.specJson as unknown as SpecResult;

    // 1. 基于现有文件生成修改
    const files = await runIterateCodegen(projectId, spec, prompt);

    // 2. 创建新 Sandbox
    const instance = await createSandbox();
    sandbox = instance.sandbox;

    // 写入模板文件
    await writeTemplateFiles(sandbox);

    // 读取所有当前文件并写入
    const dbFiles = await prisma.projectFile.findMany({ where: { projectId } });
    const allFiles = dbFiles.map((f) => ({ path: f.path, content: f.content }));

    // 合并模板和数据库文件
    const templateFiles = getTemplateFiles();
    const templateFileList = Object.entries(templateFiles).map(([path, content]) => ({
      path,
      content,
    }));

    await writeProjectFiles(sandbox, [...templateFileList, ...allFiles]);

    // 3. 构建和修复
    const result = await runBuildAndFix(projectId, spec, sandbox);
    if (!result.success) {
      await stopSandbox(sandbox);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await publishError(projectId, message, "ITERATE_ERROR");
    await updateProjectStatus(projectId, "failed", `修改失败: ${message}`);

    if (sandbox) {
      try {
        await stopSandbox(sandbox);
      } catch {
        // sandbox 清理失败不阻塞
      }
    }
  }
}
