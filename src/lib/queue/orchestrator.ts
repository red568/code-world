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
  buildIterateCodegenMessages,
  parseCodegenResult,
  buildFixMessages,
  parseFixResult,
  classifyError,
  extractErrorFiles,
  CodegenConversation,
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

const MAX_FIX_ATTEMPTS = 5;

function log(projectId: string, stage: string, message: string) {
  console.log(`[Orchestrator] [${projectId.slice(0, 8)}] [${stage}] ${message}`);
}

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
  const startTime = Date.now();
  log(projectId, "spec", "开始生成规格");
  await updateProjectStatus(projectId, "spec_generating", "正在分析需求...");

  const messages = buildSpecMessages(prompt);
  let fullResponse = "";

  for await (const chunk of chatCompletionStream(messages, { label: `spec:${projectId.slice(0, 8)}` })) {
    fullResponse += chunk;
    await publishEvent(projectId, {
      type: "spec_chunk",
      data: { chunk },
    });
  }

  const spec = parseSpecResult(fullResponse);

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
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log(projectId, "spec", `完成 | title="${spec.title}" | ${duration}s`);
  return spec;
}

// ─── 阶段 2：多轮会话式代码生成（Plan + Codegen + Review 在同一会话中）──────────

async function runConversationCodegen(
  projectId: string,
  spec: SpecResult
): Promise<CodegenFile[]> {
  const startTime = Date.now();
  log(projectId, "codegen", "开始多轮会话式代码生成");
  await updateProjectStatus(projectId, "code_generating", "正在规划代码结构...");

  const conversation = new CodegenConversation(projectId, spec);

  // Turn 1: 生成 Plan
  const plan = await conversation.generatePlan();

  await publishEvent(projectId, {
    type: "plan_ready",
    data: {
      fileCount: plan.files.length,
      files: plan.files.map((f: { path: string; role: string }) => ({ path: f.path, role: f.role })),
    },
  });

  await recordAgentRun(projectId, "codegen", `plan: ${plan.files.length} files`, {
    plan: plan.files.map((f: { path: string }) => f.path),
    notes: plan.notes,
  });

  const planDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  log(projectId, "plan", `完成 | files=${plan.files.length} | ${planDuration}s`);

  // Turn 2~N: 按顺序生成每个文件
  await updateProjectStatus(projectId, "code_generating", "正在生成代码...");
  const planFileMap = new Map(plan.files.map((f) => [f.path, f]));
  const generatedFiles: CodegenFile[] = [];

  for (const filePath of plan.generation_order) {
    const planFile = planFileMap.get(filePath);
    if (!planFile) {
      log(projectId, "codegen", `跳过未知文件: ${filePath}`);
      continue;
    }

    await publishEvent(projectId, {
      type: "codegen_file_start",
      data: { path: filePath },
    });

    const fileStart = Date.now();
    const content = await conversation.generateFile(planFile);
    const fileDuration = ((Date.now() - fileStart) / 1000).toFixed(1);
    log(projectId, "codegen", `✓ ${filePath} | ${content.length} chars | ${fileDuration}s`);

    await prisma.projectFile.upsert({
      where: { projectId_path: { projectId, path: filePath } },
      create: { projectId, path: filePath, content },
      update: { content, version: { increment: 1 } },
    });

    generatedFiles.push({ path: filePath, content });

    await publishEvent(projectId, {
      type: "codegen_file_done",
      data: { path: filePath },
    });
  }

  // Final Turn: Review（在同一会话中，LLM 能看到之前所有代码）
  log(projectId, "review", "开始会话内 Review");
  await updateProjectStatus(projectId, "reviewing", "正在审查代码一致性...");

  const reviewResult = await conversation.review();

  if (!reviewResult.passed && reviewResult.issues.length > 0) {
    log(projectId, "review", `发现 ${reviewResult.issues.length} 个问题，自动应用修复`);
    for (const issue of reviewResult.issues) {
      if (issue.fix && issue.file) {
        const idx = generatedFiles.findIndex((f) => f.path === issue.file);
        if (idx >= 0) {
          generatedFiles[idx] = { path: issue.file, content: issue.fix };
        } else {
          generatedFiles.push({ path: issue.file, content: issue.fix });
        }
        await prisma.projectFile.upsert({
          where: { projectId_path: { projectId, path: issue.file } },
          create: { projectId, path: issue.file, content: issue.fix },
          update: { content: issue.fix, version: { increment: 1 } },
        });
        log(projectId, "review", `  修复: ${issue.file} — ${issue.problem}`);
      }
    }
  } else {
    log(projectId, "review", "Review 通过，无问题");
  }

  await publishEvent(projectId, {
    type: "review_done",
    data: { passed: reviewResult.passed, issueCount: reviewResult.issues.length },
  });

  await publishEvent(projectId, {
    type: "codegen_done",
    data: { fileCount: generatedFiles.length },
  });

  await recordAgentRun(
    projectId,
    "codegen",
    `${generatedFiles.length} files (conversation-based)`,
    { filePaths: generatedFiles.map((f) => f.path) }
  );

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log(projectId, "codegen", `完成 | files=${generatedFiles.length} | ${duration}s`);
  return generatedFiles;
}

/**
 * 迭代修改：基于现有文件和新需求生成代码
 */
async function runIterateCodegen(
  projectId: string,
  spec: SpecResult,
  userRequest: string
): Promise<CodegenFile[]> {
  const startTime = Date.now();
  log(projectId, "iterate", "开始迭代修改");
  await updateProjectStatus(projectId, "code_generating", "正在修改代码...");

  const dbFiles = await prisma.projectFile.findMany({ where: { projectId } });
  const currentFiles = dbFiles.map((f) => ({ path: f.path, content: f.content }));

  log(projectId, "iterate", `现有文件数=${currentFiles.length} | 用户需求="${userRequest.slice(0, 50)}"`);

  const messages = buildIterateCodegenMessages(spec, currentFiles, userRequest);
  let fullResponse = "";
  let lastProgressPush = 0;

  for await (const chunk of chatCompletionStream(messages, { maxTokens: 16384, label: `iterate:${projectId.slice(0, 8)}` })) {
    fullResponse += chunk;
    if (fullResponse.length - lastProgressPush > 500) {
      lastProgressPush = fullResponse.length;
      await publishEvent(projectId, { type: "codegen_progress", data: { chars: fullResponse.length } });
    }
  }

  log(projectId, "iterate", `LLM 响应完成 | responseChars=${fullResponse.length}`);

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

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log(projectId, "iterate", `完成 | files=${result.files.length} | ${duration}s`);
  return result.files;
}

// ─── 阶段 4：构建和自动修复 ──────────────────────────────────────────────────────

async function runBuildAndFix(
  projectId: string,
  spec: SpecResult,
  sandbox: Sandbox
): Promise<{ success: boolean; previewUrl?: string }> {
  const fixSummaries: string[] = [];

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    log(projectId, "build", `构建尝试 #${attempt}`);

    await updateProjectStatus(
      projectId,
      attempt === 1 ? "building" : "fixing",
      attempt === 1 ? "正在构建项目..." : `正在修复（第 ${attempt - 1} 轮）...`
    );

    const buildResult = await buildProject(
      sandbox,
      (line) => publishBuildLog(projectId, "stdout", line),
      (line) => publishBuildLog(projectId, "stderr", line)
    );

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

    const buildDuration = ((Date.now() - attemptStart) / 1000).toFixed(1);
    log(projectId, "build", `构建 #${attempt} | exitCode=${buildResult.exitCode} | ${buildDuration}s`);

    if (buildResult.exitCode !== 0) {
      log(projectId, "build", `stderr 摘要: ${buildResult.stderr.slice(-200)}`);
    }

    // 构建成功 → 启动 dev server
    if (buildResult.exitCode === 0) {
      log(projectId, "preview", "构建成功，启动 dev server");
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

      log(projectId, "preview", `预览就绪 | url=${previewUrl}`);
      return { success: true, previewUrl };
    }

    // 最后一次尝试也失败了
    if (attempt === MAX_FIX_ATTEMPTS) {
      break;
    }

    // 构建失败 → 尝试自动修复
    const errorCategory = classifyError(buildResult.stderr);
    log(projectId, "fix", `开始修复 #${attempt} | errorCategory=${errorCategory}`);

    await publishEvent(projectId, {
      type: "fix_start",
      data: { attempt, diagnosis: `错误类型: ${errorCategory}` },
    });

    const fileTree = await listProjectFiles(sandbox);
    const dbFiles = await prisma.projectFile.findMany({ where: { projectId } });

    // 从 stderr 提取报错文件，只传相关文件给 Fix LLM
    const errorFilePaths = extractErrorFiles(buildResult.stderr);
    let relatedFiles: CodegenFile[] = [];
    if (errorFilePaths.length > 0) {
      const errorFiles = dbFiles
        .filter((f) => errorFilePaths.some((ep) => f.path.includes(ep) || ep.includes(f.path)))
        .map((f) => ({ path: f.path, content: f.content }));

      // 解析报错文件的 import，把依赖文件也加入
      const importedPaths = new Set<string>();
      for (const ef of errorFiles) {
        const importMatches = ef.content.matchAll(/from\s+["']([^"']+)["']/g);
        for (const m of importMatches) {
          if (m[1].startsWith(".")) {
            const dir = ef.path.split("/").slice(0, -1).join("/");
            let resolved = dir + "/" + m[1].replace(/^\.\//, "");
            resolved = resolved.replace(/\/\.\//g, "/");
            importedPaths.add(resolved);
          }
        }
      }

      // 合并：报错文件 + 其 import 的文件
      relatedFiles = [...errorFiles];
      for (const dbFile of dbFiles) {
        if (relatedFiles.some((f) => f.path === dbFile.path)) continue;
        const match = Array.from(importedPaths).some((ip) =>
          dbFile.path.startsWith(ip) || dbFile.path === ip + ".tsx" || dbFile.path === ip + ".ts"
        );
        if (match) {
          relatedFiles.push({ path: dbFile.path, content: dbFile.content });
        }
      }

      // 始终包含 App.tsx
      const appFile = dbFiles.find((f) => f.path === "src/App.tsx");
      if (appFile && !relatedFiles.some((f) => f.path === "src/App.tsx")) {
        relatedFiles.push({ path: appFile.path, content: appFile.content });
      }
      log(projectId, "fix", `报错文件: ${errorFilePaths.join(", ")} | 含依赖共 ${relatedFiles.length} 个文件`);
    } else {
      // stderr 中无法提取文件名时，回退传全部文件
      relatedFiles = dbFiles.map((f) => ({ path: f.path, content: f.content }));
      log(projectId, "fix", `无法从 stderr 提取文件名，传入全部 ${relatedFiles.length} 个文件`);
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

    const fixResponse = await chatCompletion(fixMessages, { maxTokens: 16384, label: `fix#${attempt}:${projectId.slice(0, 8)}` });
    const fixResult = parseFixResult(fixResponse);

    await writeProjectFiles(sandbox, fixResult.files);
    for (const file of fixResult.files) {
      await prisma.projectFile.upsert({
        where: { projectId_path: { projectId, path: file.path } },
        create: { projectId, path: file.path, content: file.content },
        update: { content: file.content, version: { increment: 1 } },
      });
    }

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
    log(projectId, "fix", `修复 #${attempt} 完成 | 修改文件=${fixResult.files.length} | diagnosis="${fixResult.diagnosis.slice(0, 80)}"`);
  }

  // 所有修复尝试都失败
  log(projectId, "build", `全部 ${MAX_FIX_ATTEMPTS} 次构建尝试失败`);
  await updateProjectStatus(projectId, "failed", "构建失败，已尝试自动修复但未成功");
  return { success: false };
}

// ─── 主编排流程 ──────────────────────────────────────────────────────────────────

/**
 * 执行完整的生成流程：Spec → 多轮会话 Codegen（含 Plan + Review）→ Build → Fix → Preview
 */
export async function orchestrateGenerate(
  projectId: string,
  prompt: string
): Promise<void> {
  let sandbox: Sandbox | null = null;
  const totalStart = Date.now();
  log(projectId, "start", `开始生成流程 | prompt="${prompt.slice(0, 60)}"`);

  try {
    // 1. 生成 Spec
    const spec = await runSpec(projectId, prompt);

    // 2. 多轮会话生成代码（Plan + 逐文件 + Review 在同一会话）
    const files = await runConversationCodegen(projectId, spec);

    // 3. 创建 Sandbox 并写入文件
    log(projectId, "sandbox", "正在创建 E2B 沙箱...");
    const sandboxStart = Date.now();
    const instance = await createSandbox();
    sandbox = instance.sandbox;
    const sandboxDuration = ((Date.now() - sandboxStart) / 1000).toFixed(1);
    log(projectId, "sandbox", `沙箱已创建 | id=${instance.sandboxId} | ${sandboxDuration}s`);

    // 写入模板文件
    await writeTemplateFiles(sandbox);

    // 合并模板文件和生成文件
    const templateFiles = getTemplateFiles();
    const allFiles: CodegenFile[] = [
      ...Object.entries(templateFiles).map(([path, content]) => ({ path, content })),
      ...files,
    ];

    log(projectId, "sandbox", `写入文件 | total=${allFiles.length}`);
    await writeProjectFiles(sandbox, allFiles);

    // 4. 构建和自动修复
    const result = await runBuildAndFix(projectId, spec, sandbox);
    if (!result.success) {
      await stopSandbox(sandbox);
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);
    log(projectId, "end", `流程结束 | success=${result.success} | totalTime=${totalDuration}s`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const stack = error instanceof Error ? error.stack?.split("\n").slice(1, 3).join("\n") : "";
    log(projectId, "error", `流程异常: ${message}`);
    if (stack) console.error(`[Orchestrator] [${projectId.slice(0, 8)}] stack:\n${stack}`);

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
  const totalStart = Date.now();
  log(projectId, "start", `开始迭代流程 | prompt="${prompt.slice(0, 60)}"`);

  try {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    });

    const spec = project.specJson as unknown as SpecResult;

    // 1. 基于现有文件生成修改
    const files = await runIterateCodegen(projectId, spec, prompt);

    // 2. 创建新 Sandbox
    log(projectId, "sandbox", "正在创建 E2B 沙箱...");
    const sandboxStart = Date.now();
    const instance = await createSandbox();
    sandbox = instance.sandbox;
    const sandboxDuration = ((Date.now() - sandboxStart) / 1000).toFixed(1);
    log(projectId, "sandbox", `沙箱已创建 | id=${instance.sandboxId} | ${sandboxDuration}s`);

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

    const mergedFiles = [...templateFileList, ...allFiles];
    log(projectId, "sandbox", `写入文件 | total=${mergedFiles.length}`);
    await writeProjectFiles(sandbox, mergedFiles);

    // 3. 构建和修复
    const result = await runBuildAndFix(projectId, spec, sandbox);
    if (!result.success) {
      await stopSandbox(sandbox);
    }

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);
    log(projectId, "end", `迭代结束 | success=${result.success} | totalTime=${totalDuration}s`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const stack = error instanceof Error ? error.stack?.split("\n").slice(1, 3).join("\n") : "";
    log(projectId, "error", `迭代异常: ${message}`);
    if (stack) console.error(`[Orchestrator] [${projectId.slice(0, 8)}] stack:\n${stack}`);

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
