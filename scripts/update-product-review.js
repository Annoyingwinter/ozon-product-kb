import path from "node:path";
import {
  buildAutonomousProductSummary,
  buildListingBrief,
  getWorkflowPaths,
  listProductRecords,
  parseArgs,
  refreshWorkflowArtifacts,
  shouldRequireSupplierResponse,
  writeJson,
  writeText,
} from "./merchant-workflow-lib.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = getWorkflowPaths(process.cwd());
  const slug = String(args.slug || "").trim();

  if (!slug) {
    throw new Error("Missing required argument: --slug <product-slug>");
  }

  const entries = await listProductRecords(paths.productsDir);
  const match = entries.find(({ record }) => record.slug === slug);
  if (!match) {
    throw new Error(`Unknown product slug: ${slug}`);
  }

  const record = match.record;
  const approve = Boolean(args.approve);
  const reject = Boolean(args.reject);

  if (approve === reject) {
    throw new Error("Use exactly one of --approve or --reject.");
  }

  record.review.status = approve ? "approved" : "rejected";
  record.review.notes = String(args.notes || "");
  record.review.reviewed_at = new Date().toISOString();
  record.workflow.current_stage = approve ? "approved_for_listing" : "rejected";
  record.workflow.updated_at = new Date().toISOString();

  if (approve) {
    const hasHumanSupplierResponse = Array.isArray(record.research?.supplier_responses)
      && record.research.supplier_responses.some((entry) => !entry?.data?.auto_generated_from_chat);
    const needsSupplierResponse = shouldRequireSupplierResponse(record);

    if (needsSupplierResponse && !hasHumanSupplierResponse) {
      throw new Error("Cannot approve without a human supplier response. Run workflow:ingest after a real reply first.");
    }

    if (!hasHumanSupplierResponse && !needsSupplierResponse) {
      const autonomousSummaryPath = path.join(path.dirname(record.paths.product_json), "autonomous-summary.md");
      await writeText(autonomousSummaryPath, buildAutonomousProductSummary(record));
      record.research.autonomous_summary_path = autonomousSummaryPath;
      record.research.autonomous_approval = true;
      record.research.autonomous_approval_reason = "low-complexity product; supplier response not required";
    }

    const listingBriefPath = path.join(path.dirname(record.paths.product_json), "listing-brief.md");
    await writeText(listingBriefPath, buildListingBrief(record));
    record.listing.status = "ready_for_draft";
    record.listing.listing_brief_path = listingBriefPath;
  } else {
    record.listing.status = "blocked";
    record.listing.listing_brief_path = "";
  }

  await writeJson(record.paths.product_json, record);
  await refreshWorkflowArtifacts(paths);

  console.log(`${approve ? "Approved" : "Rejected"} product: ${slug}`);
  if (record.listing.listing_brief_path) {
    console.log(`Listing brief: ${record.listing.listing_brief_path}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
