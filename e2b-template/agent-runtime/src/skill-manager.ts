/**
 * Skill 管理器
 *
 * 从后端 API 加载 Skills（global/user/project），Redis 缓存 5 分钟。
 * 支持 builtin/composite/mcp 三种类型的 Skill 执行。
 */

import type {
  SkillDefinition,
  CompositeStep,
  ToolResult,
  ToolContext,
  RedisInterface,
  LoggerInterface,
  RuntimeConfig,
} from "./types.js";
import { executeTool } from "./tools.js";

export class SkillManager {
  private loadedSkills = new Map<string, SkillDefinition>();
  private redis: RedisInterface;
  private logger: LoggerInterface;
  private config: RuntimeConfig;

  constructor(redis: RedisInterface, logger: LoggerInterface, config: RuntimeConfig) {
    this.redis = redis;
    this.logger = logger;
    this.config = config;
  }

  async loadSkills(): Promise<SkillDefinition[]> {
    const cacheKey = `skills:${this.config.projectId || this.config.userId || "global"}`;

    // 尝试 Redis 缓存
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const skills = JSON.parse(cached) as SkillDefinition[];
      for (const skill of skills) {
        this.loadedSkills.set(skill.name, skill);
      }
      this.logger.info("Skills loaded from cache", { count: skills.length });
      return skills;
    }

    // 从后端 API 加载
    try {
      const url = `${this.config.apiBaseUrl}/api/internal/skills?userId=${this.config.userId}&projectId=${this.config.projectId}`;
      const response = await fetch(url, {
        headers: { "X-Internal-Secret": this.config.internalApiSecret },
      });

      if (!response.ok) {
        this.logger.warn("Failed to load skills from API", { status: response.status });
        return [];
      }

      const skills = (await response.json()) as SkillDefinition[];

      // 去重（project > user > global）
      const uniqueSkills = new Map<string, SkillDefinition>();
      for (const skill of skills) {
        if (!uniqueSkills.has(skill.name)) {
          uniqueSkills.set(skill.name, skill);
        }
      }

      const result = Array.from(uniqueSkills.values());

      // 写入缓存
      await this.redis.setex(cacheKey, 300, JSON.stringify(result));

      for (const skill of result) {
        this.loadedSkills.set(skill.name, skill);
      }

      this.logger.info("Skills loaded from API", { count: result.length });
      return result;
    } catch (error) {
      this.logger.error("Error loading skills", { error: String(error) });
      return [];
    }
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.loadedSkills.get(name);
  }

  getAllSkills(): SkillDefinition[] {
    return Array.from(this.loadedSkills.values());
  }

  /**
   * 将 Skills 转换为 OpenAI tool 格式，供 LLM 使用
   */
  toOpenAITools(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this.getAllSkills().map((skill) => ({
      type: "function" as const,
      function: {
        name: skill.name,
        description: skill.description,
        parameters: skill.schema,
      },
    }));
  }

  async executeSkill(
    skillName: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const skill = this.loadedSkills.get(skillName);
    if (!skill) {
      return { success: false, output: `Skill '${skillName}' not found` };
    }

    switch (skill.type) {
      case "builtin":
        return executeTool(skillName, args, ctx);
      case "composite":
        return this.executeCompositeSkill(skill, args, ctx);
      case "mcp":
        return { success: false, output: "MCP skills not implemented yet" };
      default:
        return { success: false, output: `Unknown skill type: ${skill.type}` };
    }
  }

  private async executeCompositeSkill(
    skill: SkillDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    if (!skill.implementation) {
      return { success: false, output: `Skill '${skill.name}' has no implementation` };
    }

    const steps = skill.implementation;
    const outputs: Record<string, unknown> = {};

    for (const step of steps) {
      const resolvedArgs = this.resolveVariables(step.args, { args, outputs });
      const result = await executeTool(step.tool, resolvedArgs, ctx);

      if (!result.success) {
        return {
          success: false,
          output: `Skill '${skill.name}' failed at step '${step.tool}': ${result.output}`,
        };
      }

      if (step.outputVar) {
        outputs[step.outputVar] = result.output;
      }
    }

    return {
      success: true,
      output: `Skill '${skill.name}' completed successfully`,
    };
  }

  private resolveVariables(
    template: Record<string, unknown>,
    context: { args: Record<string, unknown>; outputs: Record<string, unknown> }
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(template)) {
      if (typeof value === "string") {
        resolved[key] = value.replace(/\$\{(\w+)\.(\w+)\}/g, (_, scope, prop) => {
          if (scope === "args") return String(context.args[prop] ?? "");
          if (scope === "outputs") return String(context.outputs[prop] ?? "");
          return "";
        });
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }
}
