import fs from "node:fs/promises";
import path from "node:path";
import {
  getWorkflowPaths,
  listProductRecords,
  parseArgs,
  refreshWorkflowArtifacts,
  shouldRequireSupplierResponse,
  writeJson,
} from "./merchant-workflow-lib.js";

async function inferFirstMessageSentAt(record) {
  const existing = record.research?.outreach?.first_message_sent_at;
  if (existing) return existing;

  const candidates = [
    record.research?.outreach?.search_summary_path || "",
    record.research?.outreach?.last_contacted_at || "",
    record.workflow?.updated_at || "",
    record.workflow?.created_at || "",
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (/T\d{2}-\d{2}-\d{2}/.test(candidate)) {
      return candidate;
    }

    try {
      const stats = await fs.stat(candidate);
      return stats.mtime.toISOString();
    } catch {
      continue;
    }
  }

  return new Date().toISOString();
}

async function reconcileRecord(record) {
  let changed = false;
  const outreach = (record.research.outreach = record.research.outreach || {});
  const requiresSupplierResponse = shouldRequireSupplierResponse(record);

  if (record.research.requires_supplier_response !== requiresSupplierResponse) {
    record.research.requires_supplier_response = requiresSupplierResponse;
    changed = true;
  }

  if (outreach.status === "waiting_reply") {
    outreach.status = "contacted_waiting_reply";
    changed = true;
  }

  if (record.workflow.current_stage === "supplier_contacted_waiting_reply") {
    if (outreach.status !== "replied" && outreach.status !== "contacted_waiting_reply") {
      outreach.status = "contacted_waiting_reply";
      changed = true;
    }

    if (!outreach.first_message_sent_at) {
      outreach.first_message_sent_at = await inferFirstMessageSentAt(record);
      changed = true;
    }

    if (!outreach.last_contacted_at && outreach.first_message_sent_at) {
      outreach.last_contacted_at = outreach.first_message_sent_at;
      changed = true;
    }
  }

  if (record.workflow.current_stage === "human_review_pending" && outreach.status !== "replied") {
    outreach.status = "replied";
    changed = true;
  }

  if (
    Array.isArray(record.research.supplier_responses) &&
    record.research.supplier_responses.length > 0 &&
    !record.research.latest_supplier_response_path
  ) {
    const latest = record.research.supplier_responses.at(-1);
    if (latest?.path) {
      record.research.latest_supplier_response_path = latest.path;
      changed = true;
    }
  }

  if (!outreach.follow_up_sent_count && outreach.follow_up_sent_count !== 0) {
    outreach.follow_up_sent_count = 0;
    changed = true;
  }

  if (!outreach.nudge_sent_count && outreach.nudge_sent_count !== 0) {
    outreach.nudge_sent_count = 0;
    changed = true;
  }

  if (changed) {
    record.workflow.updated_at = new Date().toISOString();
  }

  return changed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = getWorkflowPaths(process.cwd());
  const slug = String(args.slug || "").trim();
  const dryRun = Boolean(args["dry-run"]);

  const entries = await listProductRecords(paths.productsDir);
  const targets = slug ? entries.filter(({ record }) => record.slug === slug) : entries;

  if (slug && targets.length === 0) {
    throw new Error(`Unknown product slug: ${slug}`);
  }

  let repaired = 0;
  const updatedSlugs = [];

  for (const { record } of targets) {
    const changed = await reconcileRecord(record);
    if (!changed) continue;
    repaired += 1;
    updatedSlugs.push(record.slug);

    if (!dryRun) {
      await writeJson(record.paths.product_json, record);
    }
  }

  if (!dryRun) {
    await refreshWorkflowArtifacts(paths);
  }

  console.log(
    JSON.stringify(
      {
        repaired,
        dryRun,
        updatedSlugs,
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
