import path from "node:path";
import { promises as fs } from "node:fs";
import {
  getWorkflowPaths,
  listProductRecords,
  parseArgs,
  readJson,
  refreshWorkflowArtifacts,
  timestamp,
  writeJson,
} from "./merchant-workflow-lib.js";

async function ingestOne(record, responsePath) {
  const response = await readJson(responsePath);
  if (!response) {
    throw new Error(`Invalid supplier response file: ${responsePath}`);
  }

  const archivedResponsePath = path.join(path.dirname(record.paths.product_json), `supplier-response.${timestamp()}.json`);
  await writeJson(archivedResponsePath, response);

  record.research.latest_supplier_response_path = archivedResponsePath;
  record.research.supplier_responses.push({
    ingested_at: new Date().toISOString(),
    path: archivedResponsePath,
    data: response,
  });
  record.workflow.current_stage = "human_review_pending";
  record.workflow.updated_at = new Date().toISOString();

  await writeJson(record.paths.product_json, record);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = getWorkflowPaths(process.cwd());
  const productEntries = await listProductRecords(paths.productsDir);
  const bySlug = new Map(productEntries.map(({ record }) => [record.slug, record]));

  if (args.slug && args.input) {
    const record = bySlug.get(args.slug);
    if (!record) {
      throw new Error(`Unknown product slug: ${args.slug}`);
    }

    await ingestOne(record, path.resolve(args.input));
    await refreshWorkflowArtifacts(paths);
    console.log(`Ingested supplier response for: ${args.slug}`);
    return;
  }

  if (args["input-dir"]) {
    const inputDir = path.resolve(args["input-dir"]);
    const entries = await fs.readdir(inputDir, { withFileTypes: true });
    let updated = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const slug = path.basename(entry.name, ".json");
      const record = bySlug.get(slug);
      if (!record) continue;
      await ingestOne(record, path.join(inputDir, entry.name));
      updated += 1;
    }

    await refreshWorkflowArtifacts(paths);
    console.log(`Ingested supplier responses: ${updated}`);
    return;
  }

  throw new Error("Use --slug <product-slug> --input <response.json> or --input-dir <dir>.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
