/**
 * Agent 编排器（重构版）
 *
 * 从 635 行的线性 workflow 简化为 Agent Loop 启动器。
 * 所有流程决策交给 Agent 自主完成。
 */

import { prisma } from "@/lib/prisma";
import {
  createSandbox,
  connectSandbox,
  writeTemplateFiles,
  keepAlive,
  stopSandbox,
} from "@/lib/sandbox";
import {
  publishStatusChange,
  publishError,
} from "@/lib/streaming";
import { agentLoop, type AgentLoopResult } from "@/lib/agent/loop";
import { BUILDER_SYSTEM_PROMPT, buildIteratePrompt, buildIteratePromptReused } from "@/lib/agent/prompt";
import type { Sandbox } from "@e2b/code-interpreter";

function log(projectId: string, stage: string, message: string) {
  console.log(
    `[Orchestrator] [${projectId.slice(0, 8)}] [${stage}] ${message}`
  );
}

/**
 * 执行完整的生成流程：创建 Sandbox → Agent Loop → 预览就绪
 */
export async function orchestrateGenerate(
  projectId: string,
  prompt: string
): Promise<void> {
  let sandbox: Sandbox | null = null;
  const totalStart = Date.now();
  log(projectId, "start", `开始生成 | prompt="${prompt.slice(0, 60)}"`);

  try {
    // 更新状态
    await prisma.project.update({
      where: { id: projectId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: "code_generating" as any },
    });
    await publishStatusChange(
      projectId,
      "code_generating",
      "Agent 开始工作..."
    );

    // 创建 Sandbox
    log(projectId, "sandbox", "创建 E2B 沙箱...");
    const instance = await createSandbox();
    sandbox = instance.sandbox;
    log(projectId, "sandbox", `就绪 | id=${instance.sandboxId}`);

    // 写入模板文件
    await writeTemplateFiles(sandbox);

    // 启动 Agent Loop
    log(projectId, "agent", "启动 Agent Loop");
    const result: AgentLoopResult = await agentLoop({
      projectId,
      sandbox,
      systemPrompt: BUILDER_SYSTEM_PROMPT,
      userMessage: prompt,
      maxSteps: 50,
    });

    // 处理结果
    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);

    if (result.success) {
      // 保活沙箱 15 分钟，供后续迭代复用
      try {
        await keepAlive(sandbox!, 15 * 60 * 1000);
      } catch {
        // 保活失败不阻塞主流程
      }

      await prisma.project.update({
        where: { id: projectId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: "running" as any },
      });
      await publishStatusChange(projectId, "running", "预览就绪");
      log(
        projectId,
        "end",
        `成功 | steps=${result.steps} | total=${totalDuration}s | url=${result.previewUrl}`
      );
    } else {
      await prisma.project.update({
        where: { id: projectId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: "failed" as any },
      });
      await publishStatusChange(
        projectId,
        "failed",
        result.summary || "生成失败"
      );
      log(
        projectId,
        "end",
        `失败 | steps=${result.steps} | total=${totalDuration}s | reason=${result.summary}`
      );

      if (sandbox) {
        try {
          await stopSandbox(sandbox);
        } catch {
          // 清理失败不阻塞
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const stack = error instanceof Error
      ? error.stack?.split("\n").slice(1, 3).join("\n")
      : "";
    log(projectId, "error", `异常: ${message}`);
    if (stack) console.error(`[Orchestrator] stack:\n${stack}`);

    await publishError(projectId, message, "ORCHESTRATION_ERROR");
    await prisma.project.update({
      where: { id: projectId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: "failed" as any },
    });
    await publishStatusChange(projectId, "failed", `生成失败: ${message}`);

    if (sandbox) {
      try {
        await stopSandbox(sandbox);
      } catch {
        // 清理失败不阻塞
      }
    }
  }
}

/**
 * 执行迭代修改流程：优先复用已有沙箱，失败则降级创建新沙箱
 */
export async function orchestrateIterate(
  projectId: string,
  prompt: string
): Promise<void> {
  let sandbox: Sandbox | null = null;
  let isReused = false;
  const totalStart = Date.now();
  log(projectId, "start", `开始迭代 | prompt="${prompt.slice(0, 60)}"`);

  try {
    // 更新状态
    await prisma.project.update({
      where: { id: projectId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: "code_generating" as any },
    });
    await publishStatusChange(
      projectId,
      "code_generating",
      "Agent 开始修改..."
    );

    // ─── 尝试复用已有沙箱 ──────────────────────────────────────────────────
    const session = await prisma.sandboxSession.findUnique({
      where: { projectId },
    });

    if (session?.sandboxId) {
      try {
        const instance = await connectSandbox(session.sandboxId);
        sandbox = instance.sandbox;
        isReused = true;
        log(projectId, "sandbox", `复用沙箱 | id=${session.sandboxId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(projectId, "sandbox", `复用失败: ${msg}，创建新沙箱`);
      }
    }

    // ─── 降级：创建新沙箱 + 恢复文件 ───────────────────────────────────────
    if (!sandbox) {
      log(projectId, "sandbox", "创建 E2B 沙箱...");
      const instance = await createSandbox();
      sandbox = instance.sandbox;
      log(projectId, "sandbox", `就绪 | id=${instance.sandboxId}`);

      await writeTemplateFiles(sandbox);

      const dbFiles = await prisma.projectFile.findMany({
        where: { projectId },
      });
      for (const file of dbFiles) {
        const fullPath = `/home/user/app/${file.path}`;
        const dir = fullPath.split("/").slice(0, -1).join("/");
        await sandbox.commands.run(`mkdir -p ${dir}`);
        await sandbox.files.write(fullPath, file.content);
      }
      log(projectId, "sandbox", `恢复文件 | count=${dbFiles.length}`);
    }

    // ─── 启动 Agent Loop ────────────────────────────────────────────────────
    log(projectId, "agent", `启动 Agent Loop（${isReused ? "复用" : "新建"}模式）`);
    const result: AgentLoopResult = await agentLoop({
      projectId,
      sandbox,
      systemPrompt: BUILDER_SYSTEM_PROMPT,
      userMessage: isReused
        ? buildIteratePromptReused(prompt)
        : buildIteratePrompt(prompt),
      maxSteps: 50,
    });

    // ─── 处理结果 ───────────────────────────────────────────────────────────
    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);

    if (result.success) {
      // 续命沙箱 15 分钟，供下次迭代复用
      try {
        await keepAlive(sandbox, 15 * 60 * 1000);
      } catch {
        // 续命失败不阻塞
      }

      await prisma.project.update({
        where: { id: projectId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: "running" as any },
      });
      await publishStatusChange(projectId, "running", "预览就绪");
      log(
        projectId,
        "end",
        `迭代成功 | steps=${result.steps} | total=${totalDuration}s | reused=${isReused}`
      );
    } else {
      await prisma.project.update({
        where: { id: projectId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { status: "failed" as any },
      });
      await publishStatusChange(
        projectId,
        "failed",
        result.summary || "修改失败"
      );
      log(
        projectId,
        "end",
        `迭代失败 | steps=${result.steps} | total=${totalDuration}s`
      );

      if (sandbox && !isReused) {
        try {
          await stopSandbox(sandbox);
        } catch {
          // 清理失败不阻塞
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    log(projectId, "error", `迭代异常: ${message}`);

    await publishError(projectId, message, "ITERATE_ERROR");
    await prisma.project.update({
      where: { id: projectId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: "failed" as any },
    });
    await publishStatusChange(projectId, "failed", `修改失败: ${message}`);

    if (sandbox && !isReused) {
      try {
        await stopSandbox(sandbox);
      } catch {
        // 清理失败不阻塞
      }
    }
  }
}
