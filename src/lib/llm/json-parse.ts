/**
 * 安全 JSON 解析 — 先尝试直接解析，失败后用 jsonrepair 修复再试
 *
 * 解决 LLM（尤其是 DeepSeek）输出 JSON 时缺少花括号、尾逗号等问题。
 */

import { jsonrepair } from "jsonrepair";

export function safeJsonParse<T = unknown>(raw: string, label?: string): T {
  const cleaned = raw
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    try {
      const repaired = jsonrepair(cleaned);
      console.log(`[JSON] ${label || "parse"} | 修复成功 | 原始长度=${cleaned.length} | 修复后=${repaired.length}`);
      return JSON.parse(repaired);
    } catch {
      throw firstError;
    }
  }
}
