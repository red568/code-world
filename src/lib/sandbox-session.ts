/**
 * 沙盒会话管理器
 *
 * 管理 E2B 沙盒的生命周期：创建、复用、销毁。
 * - 每个 Project 维护一个活跃沙盒会话
 * - 会话有 15 分钟 TTL，新 Run 优先复用
 * - 失败/停止立即清理，成功保留复用
 */

import { prisma } from "@/lib/prisma";
import { Sandbox } from "@e2b/code-interpreter";

const SESSION_TTL = 15 * 60 * 1000; // 15 分钟

export class SandboxSessionManager {
  /**
   * 获取或创建沙盒（自动复用）
   */
  async acquireForProject(projectId: string): Promise<{
    sandbox: Sandbox;
    isReused: boolean;
  }> {
    // 1. 查询数据库中的活跃会话
    const session = await prisma.sandboxSession.findUnique({
      where: { projectId },
    });

    // 2. 尝试复用
    if (
      session &&
      session.status === "running" &&
      session.expiresAt &&
      session.expiresAt > new Date()
    ) {
      try {
        const sandbox = await Sandbox.connect(session.sandboxId);

        // 续期
        await prisma.sandboxSession.update({
          where: { projectId },
          data: { expiresAt: new Date(Date.now() + SESSION_TTL) },
        });

        console.log(
          `[Session] Reused sandbox | project=${projectId.slice(0, 8)} | sandbox=${session.sandboxId.slice(0, 8)}`
        );

        return { sandbox, isReused: true };
      } catch (error) {
        // 连接失败，标记过期
        console.warn(
          `[Session] Failed to connect to existing sandbox, creating new | project=${projectId.slice(0, 8)}`,
          error
        );
        await prisma.sandboxSession.update({
          where: { projectId },
          data: { status: "expired" },
        });
      }
    }

    // 3. 创建新沙盒（基础设施级环境变量在此注入，整个生命周期有效）
    const template = process.env.E2B_TEMPLATE || "ai-website-builder-v2";
    const sandboxEnvs = {
      // 沙盒在外部网络，需要用公网 Redis 地址
      REDIS_URL: process.env.REDIS_PUBLIC_URL || process.env.REDIS_URL || "",
      LLM_API_KEY: process.env.LLM_API_KEY || "",
      LLM_BASE_URL: process.env.LLM_BASE_URL || "",
      LLM_MODEL: process.env.LLM_MODEL || "",
      // 沙盒回调后端也需要公网地址
      API_BASE_URL: process.env.API_PUBLIC_URL || process.env.API_BASE_URL || process.env.NEXTAUTH_URL || "http://localhost:3000",
      INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET || "",
      AXIOM_TOKEN: process.env.AXIOM_TOKEN || "",
    };

    // 诊断日志：检查注入沙盒的环境变量是否齐全
    const envStatus = Object.entries(sandboxEnvs).map(
      ([key, val]) => `${key}=${val ? "✓" : "✗ MISSING"}`
    );
    console.log(`[Session] Creating sandbox | template=${template} | project=${projectId.slice(0, 8)}`);
    console.log(`[Session] Sandbox envs: ${envStatus.join(", ")}`);

    const createStart = Date.now();
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create({
        template,
        timeoutMs: SESSION_TTL,
        envs: sandboxEnvs,
      });
    } catch (createError) {
      const elapsed = Date.now() - createStart;
      console.error(
        `[Session] ✗ Sandbox.create() FAILED after ${elapsed}ms | project=${projectId.slice(0, 8)} | template=${template}`,
        createError
      );
      throw createError;
    }

    const createElapsed = Date.now() - createStart;
    console.log(
      `[Session] Created new sandbox | project=${projectId.slice(0, 8)} | sandbox=${sandbox.sandboxId} | took=${createElapsed}ms`
    );

    // 健康检查：确认沙盒环境可用
    try {
      const healthCheck = await sandbox.commands.run(
        "echo OK && node --version && ls /agent-runtime/dist/main.js 2>&1",
        { timeoutMs: 10000 }
      );
      console.log(
        `[Session] Sandbox health check | exitCode=${healthCheck.exitCode} | stdout=${healthCheck.stdout?.trim()}`
      );
      if (healthCheck.exitCode !== 0) {
        console.error(`[Session] ⚠ Health check failed | stderr=${healthCheck.stderr}`);
      }
    } catch (healthErr) {
      console.error(`[Session] ⚠ Health check exception:`, healthErr);
    }

    // 4. 保存到数据库
    await prisma.sandboxSession.upsert({
      where: { projectId },
      create: {
        projectId,
        sandboxId: sandbox.sandboxId,
        provider: "e2b",
        status: "running",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL),
      },
      update: {
        sandboxId: sandbox.sandboxId,
        status: "running",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL),
        stoppedAt: null,
      },
    });

    return { sandbox, isReused: false };
  }

  /**
   * 主动终止会话（停止/失败时调用）
   * 只有当前 session 的 sandboxId 与 expectedSandboxId 匹配时才执行 kill。
   * 防止异步回调误杀后续新建的沙盒。
   */
  async terminateSession(projectId: string, expectedSandboxId?: string): Promise<void> {
    const session = await prisma.sandboxSession.findUnique({
      where: { projectId },
    });

    if (!session) return;

    // 如果指定了 expectedSandboxId，但 session 已经被新 run 更新，跳过
    if (expectedSandboxId && session.sandboxId !== expectedSandboxId) {
      console.log(
        `[Session] Skip terminate: sandbox replaced | project=${projectId.slice(0, 8)} | expected=${expectedSandboxId.slice(0, 8)} | current=${session.sandboxId.slice(0, 8)}`
      );
      return;
    }

    try {
      const sandbox = await Sandbox.connect(session.sandboxId);
      await sandbox.kill();
      console.log(
        `[Session] Killed sandbox | project=${projectId.slice(0, 8)} | sandbox=${session.sandboxId.slice(0, 8)}`
      );
    } catch (error) {
      console.warn(`[Session] Failed to kill sandbox (may already be dead):`, error);
    }

    // 只有 sandboxId 仍然匹配时才更新状态（原子条件更新）
    await prisma.sandboxSession.updateMany({
      where: { projectId, sandboxId: session.sandboxId },
      data: { status: "stopped", stoppedAt: new Date() },
    });
  }
}

export const sandboxSessionManager = new SandboxSessionManager();
