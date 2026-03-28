import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./shared-utils.js";

const DEFAULT_OUTPUT_DIR = path.resolve("output");

function parseArgs(argv) {
  const args = {
    input: "",
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--input" && next) {
      args.input = path.resolve(next);
      index += 1;
    } else if (current === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      index += 1;
    }
  }

  return args;
}

async function findLatestReview(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".review.json")) continue;
    if (!entry.name.startsWith("oz-chief-")) continue;
    const fullPath = path.join(outputDir, entry.name);
    const stats = await fs.stat(fullPath);
    files.push({ fullPath, mtimeMs: stats.mtimeMs });
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files[0]?.fullPath || "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reviewPath = args.input || (await findLatestReview(args.outputDir));
  if (!reviewPath) {
    throw new Error("No chief review file found. Run the pipeline first or pass --input.");
  }

  const review = await readJson(reviewPath, null);
  if (!review) {
    throw new Error(`Invalid chief review file: ${reviewPath}`);
  }

  const approved = Array.isArray(review.approved) ? review.approved : [];
  const weak = Array.isArray(review.weak) ? review.weak : [];
  const polluted = Array.isArray(review.polluted) ? review.polluted : [];
  const usable = approved.length;

  const audit = {
    generatedAt: new Date().toISOString(),
    input: reviewPath,
    usable,
    weak: weak.length,
    polluted: polluted.length,
    healthy: usable >= 5,
    quarantined_polluted: polluted.length,
    approvedSlugs: approved.map((item) => item.slug),
    weakSlugs: weak.map((item) => item.slug),
    pollutedSlugs: polluted.map((item) => item.slug),
  };

  const outputPath = path.join(args.outputDir, `oz-chief-audit-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeJson(outputPath, audit);

  console.log(`Audit: ${outputPath}`);
  console.log(`Usable: ${usable}`);
  console.log(`Weak: ${weak.length}`);
  console.log(`Polluted: ${polluted.length}`);

  if (!audit.healthy) {
    throw new Error("Chief audit is not healthy enough for publish-ready use.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
