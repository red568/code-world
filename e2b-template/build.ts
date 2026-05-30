import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

async function main() {
  console.log("Starting E2B template build (remote)...\n");

  const result = await Template.build(template, "vite-react-tailwind", {
    apiKey: process.env.E2B_API_KEY,
    cpuCount: 2,
    memoryMB: 1024,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log("\n✓ Template built successfully!");
  console.log("Template name: vite-react-tailwind");
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Build failed:", err.message || err);
  process.exit(1);
});
