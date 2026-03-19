import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getWorkflowPaths,
  listProductRecords,
  parseArgs,
  readJson,
  timestamp,
  writeJson,
} from "./merchant-workflow-lib.js";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 300000;
const DEFAULT_CYCLES = 0;

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function pickTargetRecord(paths, slug) {
  const records = await listProductRecords(paths.productsDir);
  if (slug) {
    const match = records.find(({ record }) => record.slug === slug);
    if (!match) {
      throw new Error(`Unknown product slug: ${slug}`);
    }
    return match.record;
  }

  const queued = records.find(
    ({ record }) => record.workflow.current_stage === "supplier_contacted_waiting_reply",
  );
  if (!queued) {
    throw new Error("No product is waiting for supplier reply.");
  }
  return queued.record;
}

async function runObservationCycle(baseDir, slug, summaryPath, outputDir) {
  const scriptPath = path.join(baseDir, "scripts", "watch-1688-supplier-reply.js");
  const args = [
    scriptPath,
    "--slug",
    slug,
    "--observe-only",
    "--wait-reply-ms",
    "0",
  ];

  if (summaryPath) {
    args.push("--summary", summaryPath);
  }

  const { stdout } = await execFileAsync("node", args, {
    cwd: baseDir,
    maxBuffer: 10 * 1024 * 1024,
  });

  const cycleId = `monitor-cycle-${timestamp()}`;
  const cyclePath = path.join(outputDir, `${cycleId}.stdout.json`);
  await writeJson(cyclePath, {
    captured_at: new Date().toISOString(),
    slug,
    summary_path: summaryPath,
    stdout: stdout || "",
  });

  return cyclePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = process.cwd();
  const paths = getWorkflowPaths(baseDir);
  const slug = String(args.slug || "").trim();
  const intervalMs = parseNumber(args["interval-ms"], DEFAULT_INTERVAL_MS);
  const maxCycles = parseNumber(args.cycles, DEFAULT_CYCLES);
  const outputDir = path.join(paths.outputDir, "playwright", `1688-monitor-${timestamp()}`);

  const record = await pickTargetRecord(paths, slug);
  const summaryPath = record.research?.outreach?.search_summary_path || "";

  let cycles = 0;
  let latestRecord = record;
  const loop = maxCycles > 0 ? maxCycles : Infinity;

  while (cycles < loop) {
    cycles += 1;
    await runObservationCycle(baseDir, latestRecord.slug, summaryPath, outputDir);

    const refreshedRecords = await listProductRecords(paths.productsDir);
    const refreshed = refreshedRecords.find(({ record: item }) => item.slug === latestRecord.slug)?.record;
    if (!refreshed) {
      throw new Error(`Lost product record during monitoring: ${latestRecord.slug}`);
    }

    latestRecord = refreshed;
    const lastCapture = Array.isArray(latestRecord.research?.chat_captures)
      ? latestRecord.research.chat_captures.at(-1)
      : null;

    if (lastCapture?.has_human_reply) {
      await writeJson(path.join(outputDir, "monitor-result.json"), {
        slug: latestRecord.slug,
        status: "human_reply_detected",
        cycles,
        finished_at: new Date().toISOString(),
        knowledgePath: latestRecord.paths.product_json,
        latestSupplierResponsePath: latestRecord.research?.latest_supplier_response_path || "",
      });
      console.log(
        JSON.stringify(
          {
            slug: latestRecord.slug,
            status: "human_reply_detected",
            cycles,
            knowledgePath: latestRecord.paths.product_json,
            latestSupplierResponsePath: latestRecord.research?.latest_supplier_response_path || "",
          },
          null,
          2,
        ),
      );
      return;
    }

    if (cycles >= loop) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  await writeJson(path.join(outputDir, "monitor-result.json"), {
    slug: latestRecord.slug,
    status: "still_waiting",
    cycles,
    finished_at: new Date().toISOString(),
    knowledgePath: latestRecord.paths.product_json,
    latestSupplierResponsePath: latestRecord.research?.latest_supplier_response_path || "",
  });

  console.log(
    JSON.stringify(
      {
        slug: latestRecord.slug,
        status: "still_waiting",
        cycles,
        knowledgePath: latestRecord.paths.product_json,
        latestSupplierResponsePath: latestRecord.research?.latest_supplier_response_path || "",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
