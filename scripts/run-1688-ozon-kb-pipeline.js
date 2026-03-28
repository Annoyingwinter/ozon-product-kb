import { spawn } from "node:child_process";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    limit: 5,
    approveLimit: 5,
    seedFile: "",
    searchSnapshotFile: "",
    keywords: "",
    outputDir: path.resolve("output"),
    headless: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--limit" && next) {
      args.limit = Math.max(1, Number(next));
      index += 1;
    } else if (current === "--approve-limit" && next) {
      args.approveLimit = Math.max(1, Number(next));
      index += 1;
    } else if (current === "--seed-file" && next) {
      args.seedFile = path.resolve(next);
      index += 1;
    } else if (current === "--search-snapshot-file" && next) {
      args.searchSnapshotFile = path.resolve(next);
      index += 1;
    } else if (current === "--keywords" && next) {
      args.keywords = next;
      index += 1;
    } else if (current === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      index += 1;
    } else if (current === "--headless") {
      args.headless = true;
    }
  }

  return args;
}

function buildSelectorArgs(args) {
  const commandArgs = [
    "scripts/select-1688-for-ozon.js",
    "--limit",
    String(Math.max(args.limit, args.approveLimit)),
    "--detail-limit",
    String(Math.max(args.limit * 3, 12)),
    "--output-dir",
    args.outputDir,
  ];

  if (args.seedFile) {
    commandArgs.push("--seed-file", args.seedFile);
  }
  if (args.searchSnapshotFile) {
    commandArgs.push("--search-snapshot-file", args.searchSnapshotFile);
  }
  if (args.keywords) {
    commandArgs.push("--keywords", args.keywords);
  }
  if (args.headless) {
    commandArgs.push("--headless");
  }

  return commandArgs;
}

function parseSavedAnalysisPath(stdout) {
  const match = String(stdout || "").match(/Saved analysis:\s*(.+)/i);
  if (!match?.[1]) {
    throw new Error(`Could not find selector output path in stdout:\n${stdout}`);
  }
  return match[1].trim();
}

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

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}.\n${stderr || stdout || "No output."}`,
        ),
      );
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("[pipeline] Starting 1688 selector...");
  const selector = await runStreaming("node", buildSelectorArgs(args));
  const analysisPath = parseSavedAnalysisPath(selector.stdout);

  console.log("[pipeline] Starting OZ Chief Listing Officer review...");
  await runStreaming("node", [
    "scripts/ozon-chief-listing-officer.js",
    "--input",
    analysisPath,
    "--approve-limit",
    String(args.approveLimit),
    "--output-dir",
    args.outputDir,
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
