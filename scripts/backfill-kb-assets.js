#!/usr/bin/env node
import { spawn } from "node:child_process";

function runStreaming(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.\n${stderr || stdout || "No output."}`));
    });
  });
}

async function main() {
  console.log("[backfill] Generating listing assets for existing knowledge-base records...");
  await runStreaming("node", ["scripts/ozon-listing-draft-flow.js", "--force"]);

  console.log("[backfill] Generating Ozon import mappings for approved/listing-ready records...");
  await runStreaming("node", ["scripts/_batch-mapping.js"]);

  console.log("[backfill] Completed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
