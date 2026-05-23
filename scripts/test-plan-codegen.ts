/**
 * 集成测试：Plan → 逐文件生成 完整流程
 *
 * 不依赖 Redis / PostgreSQL / E2B，只需要 LLM API。
 * 运行: npx tsx scripts/test-plan-codegen.ts
 *
 * 输出：
 * 1. Plan 结构和每个文件的角色/依赖
 * 2. 逐文件生成过程（耗时、字符数）
 * 3. 生成代码写入 scripts/test-output/ 目录
 * 4. 验证报告（完整性、import 一致性）
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { chatCompletion, chatCompletionStream } from "../src/lib/llm";
import {
  buildSpecMessages,
  parseSpecResult,
  buildPlanMessages,
  parsePlanResult,
  buildSingleFileMessages,
  parseSingleFileResult,
  type SpecResult,
  type CodePlan,
  type CodePlanFile,
  type CodegenFile,
} from "../src/lib/agent";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const TEST_PROMPT = "个人博客网站，包含首页、文章列表、关于我页面，现代简约风格";
const OUTPUT_DIR = path.join(__dirname, "test-output");
const MAX_RETRIES = 2;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function hr(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}\n`);
}

function elapsed(start: number): string {
  return ((Date.now() - start) / 1000).toFixed(1) + "s";
}

function writeOutputFile(filePath: string, content: string) {
  const fullPath = path.join(OUTPUT_DIR, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

// ─── Step 1: Spec 生成 ───────────────────────────────────────────────────────

async function stepSpec(): Promise<SpecResult> {
  hr("Step 1: Spec 生成");
  console.log(`Prompt: "${TEST_PROMPT}"`);
  const start = Date.now();

  const messages = buildSpecMessages(TEST_PROMPT);
  console.log(`Input chars: ${messages.reduce((s, m) => s + m.content.length, 0)}`);

  let fullResponse = "";
  process.stdout.write("Streaming: ");
  for await (const chunk of chatCompletionStream(messages, { label: "test-spec" })) {
    fullResponse += chunk;
    process.stdout.write(".");
  }
  console.log(` done (${elapsed(start)})`);

  console.log(`\nRaw response (${fullResponse.length} chars):`);
  console.log(fullResponse.slice(0, 500) + (fullResponse.length > 500 ? "..." : ""));

  const spec = parseSpecResult(fullResponse);
  console.log(`\nParsed Spec:`);
  console.log(`  Title: ${spec.title}`);
  console.log(`  Type: ${spec.app_type}`);
  console.log(`  Pages: ${spec.pages.join(", ")}`);
  console.log(`  Components: ${spec.components.join(", ")}`);
  console.log(`  Dependencies: ${spec.dependencies.join(", ")}`);

  writeOutputFile("spec.json", JSON.stringify(spec, null, 2));
  return spec;
}

// ─── Step 2: Code Plan 生成 ──────────────────────────────────────────────────

async function stepPlan(spec: SpecResult): Promise<CodePlan> {
  hr("Step 2: Code Plan 生成");
  const start = Date.now();

  const messages = buildPlanMessages(spec);
  console.log(`Input chars: ${messages.reduce((s, m) => s + m.content.length, 0)}`);

  const response = await chatCompletion(messages, { maxTokens: 8192, label: "test-plan" });
  console.log(`Response (${response.length} chars, ${elapsed(start)}):`);
  console.log(response.slice(0, 800) + (response.length > 800 ? "..." : ""));

  const plan = parsePlanResult(response);

  console.log(`\nCode Plan (${plan.files.length} files):`);
  console.log(`  Notes: ${plan.notes}`);
  console.log(`\n  Generation order:`);
  for (let i = 0; i < plan.generation_order.length; i++) {
    const filePath = plan.generation_order[i];
    const file = plan.files.find((f) => f.path === filePath);
    console.log(`    ${i + 1}. ${filePath}`);
    if (file) {
      console.log(`       Role: ${file.role}`);
      console.log(`       Exports: ${file.exports.join(", ")}`);
      console.log(`       Imports from: ${file.imports_from.length > 0 ? file.imports_from.join(", ") : "(none)"}`);
    }
  }

  writeOutputFile("plan.json", JSON.stringify(plan, null, 2));
  return plan;
}

// ─── Step 3: 逐文件生成代码 ──────────────────────────────────────────────────

async function stepCodegen(
  spec: SpecResult,
  plan: CodePlan
): Promise<CodegenFile[]> {
  hr("Step 3: 逐文件生成代码");

  const generatedFiles: CodegenFile[] = [];
  const generatedExports: { path: string; exports: string[] }[] = [];
  const results: { path: string; chars: number; time: string; retries: number }[] = [];

  for (let i = 0; i < plan.generation_order.length; i++) {
    const filePath = plan.generation_order[i];
    const planFile = plan.files.find((f) => f.path === filePath);
    if (!planFile) {
      console.log(`  [SKIP] ${filePath} — not in plan files`);
      continue;
    }

    console.log(`\n  [${i + 1}/${plan.generation_order.length}] ${filePath}`);
    console.log(`    Role: ${planFile.role}`);

    let content: string | null = null;
    let retries = 0;

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const fileStart = Date.now();
      const label = retry === 0
        ? `test-file:${filePath}`
        : `test-file:${filePath}:retry${retry}`;

      try {
        const messages = buildSingleFileMessages({
          spec,
          target: planFile,
          generatedFiles: generatedExports,
        });

        let fullResponse = "";
        process.stdout.write("    Streaming: ");
        for await (const chunk of chatCompletionStream(messages, { maxTokens: 4096, label })) {
          fullResponse += chunk;
          process.stdout.write(".");
        }

        if (!fullResponse || fullResponse.trim().length === 0) {
          throw new Error("LLM 返回空响应");
        }

        content = parseSingleFileResult(fullResponse);
        retries = retry;
        console.log(` done (${elapsed(fileStart)}, ${content.length} chars${retry > 0 ? `, retry ${retry}` : ""})`);

        // 打印代码前几行
        const previewLines = content.split("\n").slice(0, 5).map((l) => `      ${l}`).join("\n");
        console.log(`    Preview:\n${previewLines}`);
        if (content.split("\n").length > 5) {
          console.log(`      ... (${content.split("\n").length} lines total)`);
        }

        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(` FAILED (${elapsed(fileStart)}): ${msg}`);
        if (retry === MAX_RETRIES) {
          console.log(`    [ERROR] 放弃 ${filePath}，已重试 ${MAX_RETRIES} 次`);
        }
      }
    }

    if (content) {
      generatedFiles.push({ path: filePath, content });
      generatedExports.push({ path: filePath, exports: planFile.exports });
      writeOutputFile(filePath, content);
      results.push({ path: filePath, chars: content.length, time: elapsed(Date.now()), retries });
    }
  }

  return generatedFiles;
}

// ─── Step 4: 验证 ────────────────────────────────────────────────────────────

function stepValidate(plan: CodePlan, files: CodegenFile[]) {
  hr("Step 4: 验证");

  const generatedPaths = new Set(files.map((f) => f.path));
  let errors = 0;

  // 4a: 完整性检查
  console.log("  [完整性检查]");
  for (const planFile of plan.files) {
    if (generatedPaths.has(planFile.path)) {
      console.log(`    ✓ ${planFile.path}`);
    } else {
      console.log(`    ✗ ${planFile.path} — 未生成!`);
      errors++;
    }
  }

  // 4b: import 路径一致性检查
  console.log("\n  [Import 一致性检查]");
  for (const file of files) {
    const importMatches = file.content.matchAll(/from\s+["']([^"']+)["']/g);
    const localImports: string[] = [];
    for (const m of importMatches) {
      if (m[1].startsWith(".")) {
        localImports.push(m[1]);
      }
    }
    if (localImports.length > 0) {
      console.log(`    ${file.path}:`);
      for (const imp of localImports) {
        // Resolve relative import to absolute path
        const dir = path.dirname(file.path);
        let resolved = path.posix.join(dir, imp);
        // Try common extensions
        const found = files.some((f) =>
          f.path === resolved ||
          f.path === resolved + ".tsx" ||
          f.path === resolved + ".ts" ||
          f.path === resolved + ".css"
        );
        if (found) {
          console.log(`      ✓ import "${imp}"`);
        } else {
          console.log(`      ? import "${imp}" — 目标文件未在生成列表中（可能是第三方或模板文件）`);
        }
      }
    }
  }

  // 4c: export 检查
  console.log("\n  [Export 检查]");
  for (const file of files) {
    const planFile = plan.files.find((f) => f.path === file.path);
    if (!planFile) continue;
    for (const exp of planFile.exports) {
      const exportName = exp.replace("default ", "");
      const hasExport =
        file.content.includes(`export default`) ||
        file.content.includes(`export function ${exportName}`) ||
        file.content.includes(`export const ${exportName}`) ||
        file.content.includes(`export { ${exportName}`) ||
        file.content.includes(`export class ${exportName}`) ||
        file.content.includes(`export interface ${exportName}`) ||
        file.content.includes(`export type ${exportName}`);
      if (hasExport) {
        console.log(`    ✓ ${file.path} exports ${exp}`);
      } else {
        console.log(`    ✗ ${file.path} missing export: ${exp}`);
        errors++;
      }
    }
  }

  // Summary
  console.log(`\n  ─── 结果 ───`);
  console.log(`  总文件数: ${plan.files.length} planned, ${files.length} generated`);
  if (errors === 0) {
    console.log(`  ✓ 全部通过`);
  } else {
    console.log(`  ✗ ${errors} 个问题`);
  }

  return errors;
}

// ─── 汇总报告 ────────────────────────────────────────────────────────────────

function printSummary(
  spec: SpecResult,
  plan: CodePlan,
  files: CodegenFile[],
  totalTime: string,
  errors: number
) {
  hr("汇总报告");
  console.log(`  Prompt:     "${TEST_PROMPT}"`);
  console.log(`  Spec Title: ${spec.title}`);
  console.log(`  Plan Files: ${plan.files.length}`);
  console.log(`  Generated:  ${files.length}`);
  console.log(`  Total Time: ${totalTime}`);
  console.log(`  Total Chars: ${files.reduce((s, f) => s + f.content.length, 0)}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Output Dir: ${OUTPUT_DIR}`);
  console.log(`\n  Generated files:`);
  for (const f of files) {
    const lines = f.content.split("\n").length;
    console.log(`    ${f.path.padEnd(40)} ${f.content.length.toString().padStart(5)} chars  ${lines.toString().padStart(4)} lines`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const totalStart = Date.now();

  // Clean output dir
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Plan → 逐文件生成 集成测试                            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nLLM Provider: ${process.env.LLM_PROVIDER || "default"}`);
  console.log(`LLM Model:    ${process.env.LLM_MODEL || "default"}`);
  console.log(`LLM Base URL: ${process.env.LLM_BASE_URL || "default"}`);

  // Step 1
  const spec = await stepSpec();

  // Step 2
  const plan = await stepPlan(spec);

  // Step 3
  const files = await stepCodegen(spec, plan);

  // Step 4
  const errors = stepValidate(plan, files);

  // Summary
  printSummary(spec, plan, files, elapsed(totalStart), errors);

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message || err);
  if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
