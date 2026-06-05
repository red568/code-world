/**
 * Internal API: 加载 Skills
 *
 * agent-runtime 启动时加载可用的 skills。
 * 按优先级：project > user > global
 */

import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const secret = request.headers.get("X-Internal-Secret");
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  const projectId = searchParams.get("projectId");

  const skills = await prisma.skill.findMany({
    where: {
      enabled: true,
      OR: [
        { scope: "global" },
        ...(userId ? [{ scope: "user" as const, userId }] : []),
        ...(projectId ? [{ scope: "project" as const, projectId }] : []),
      ],
    },
    orderBy: [
      { scope: "desc" },
      { name: "asc" },
    ],
  });

  // 转换为 SkillDefinition 格式
  const definitions = skills.map((skill) => ({
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    category: skill.category,
    schema: skill.schema,
    type: skill.type,
    implementation: skill.implementation,
    mcpConfig: skill.mcpConfig,
  }));

  return NextResponse.json(definitions);
}
