import path from "node:path";
import {
  ensureDir,
  getWorkflowPaths,
  listProductRecords,
  readJson,
  timestamp,
  writeJson,
  writeText,
} from "./merchant-workflow-lib.js";
import { compactText, normalize, repairDeepMojibake } from "./shared-utils.js";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildIssues(record, knowledgeBase) {
  const issues = [];
  const stage = normalize(record?.workflow?.current_stage || "");
  const compareStatus = normalize(record?.research?.compare_status || "");

  if (stage === "supplier_compare_blocked" || compareStatus === "blocked") {
    issues.push("compare_blocked");
  }
  if (compareStatus === "failed") {
    issues.push("compare_failed");
  }

  if (!knowledgeBase) {
    issues.push("missing_knowledge_base");
    return issues;
  }

  if (!normalize(knowledgeBase.source_url || "")) issues.push("missing_source_url");
  if (!normalize(knowledgeBase.title_cn || "")) issues.push("missing_title_cn");
  if (!Number(knowledgeBase.price || 0)) issues.push("missing_price");
  if (
    !normalize(knowledgeBase.main_image || "") &&
    safeArray(knowledgeBase.images).filter(Boolean).length === 0
  ) {
    issues.push("missing_media");
  }
  if (Number(knowledgeBase.comparison_summary?.candidate_count || 0) < 3) {
    issues.push("less_than_three_competitors");
  }
  if (!normalize(knowledgeBase.comparison_summary?.selected_offer_source_url || "")) {
    issues.push("missing_selected_offer");
  }
  if (knowledgeBase.data_quality?.web_detail_valid === false) {
    issues.push("invalid_detail_page");
  }

  const title = normalize(knowledgeBase.title_cn || "");
  if (/[�]/.test(title) || /鍙|缂|鐩|鏀剁撼/.test(title) && !/[\u4e00-\u9fff]/u.test(title)) {
    issues.push("title_mojibake");
  }

  return Array.from(new Set(issues));
}

function classifyRecord(record, knowledgeBase, issues) {
  const stage = normalize(record?.workflow?.current_stage || "");
  const compareStatus = normalize(record?.research?.compare_status || "");

  if (stage === "rejected") return "rejected";
  if (stage === "supplier_compare_blocked" || compareStatus === "blocked") return "blocked";
  if (issues.some((issue) => issue === "title_mojibake")) return "polluted";
  if (issues.length > 0) return "weak";
  return "usable";
}

function buildMarkdown(report) {
  const lines = [
    "# Product KB Health",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "## Summary",
    `- Total: ${report.summary.total}`,
    `- Usable: ${report.summary.usable}`,
    `- Weak: ${report.summary.weak}`,
    `- Blocked: ${report.summary.blocked}`,
    `- Polluted: ${report.summary.polluted}`,
    `- Rejected: ${report.summary.rejected}`,
    "",
    "## Top Problems",
  ];

  for (const item of report.items.filter((entry) => entry.status !== "usable").slice(0, 15)) {
    lines.push(
      `- ${item.slug} | ${item.status} | ${item.stage} | ${item.issues.join(", ") || "none"} | ${compactText(item.title_cn || item.name || "", 80)}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  const paths = getWorkflowPaths(process.cwd());
  const automationDir = path.join(paths.outputDir, "automation");
  await ensureDir(automationDir);
  const manifestPath = path.join(paths.outputDir, "latest-product-kb-run.json");
  const manifest = await readJson(manifestPath, null);
  const auditAllRecords = process.argv.includes("--all-records");
  const allowedSlugs = !auditAllRecords && Array.isArray(manifest?.slugs)
    ? new Set(manifest.slugs.map((item) => normalize(item)).filter(Boolean))
    : null;

  const entries = await listProductRecords(paths.productsDir);
  const items = [];

  for (const { record } of entries) {
    const cleanRecord = repairDeepMojibake(record);
    if (allowedSlugs && !allowedSlugs.has(normalize(cleanRecord?.slug || ""))) {
      continue;
    }
    const kbPath =
      cleanRecord?.paths?.knowledge_base_path ||
      cleanRecord?.listing?.knowledge_base_path ||
      "";
    const knowledgeBase = kbPath ? repairDeepMojibake(await readJson(kbPath, null)) : null;
    const issues = buildIssues(cleanRecord, knowledgeBase);
    const status = classifyRecord(cleanRecord, knowledgeBase, issues);

    items.push({
      slug: cleanRecord.slug,
      name: normalize(cleanRecord?.product?.name || cleanRecord.slug),
      stage: normalize(cleanRecord?.workflow?.current_stage || ""),
      compare_status: normalize(cleanRecord?.research?.compare_status || ""),
      status,
      issues,
      knowledge_base_path: kbPath,
      blocked_snapshot_path: normalize(cleanRecord?.research?.blocked_snapshot_path || ""),
      title_cn: normalize(knowledgeBase?.title_cn || ""),
      source_url: normalize(knowledgeBase?.source_url || ""),
      candidate_count: Number(knowledgeBase?.comparison_summary?.candidate_count || 0),
      selected_offer_source_url: normalize(
        knowledgeBase?.comparison_summary?.selected_offer_source_url || "",
      ),
    });
  }

  const summary = {
    total: items.length,
    usable: items.filter((item) => item.status === "usable").length,
    weak: items.filter((item) => item.status === "weak").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    polluted: items.filter((item) => item.status === "polluted").length,
    rejected: items.filter((item) => item.status === "rejected").length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    manifestPath: manifest ? manifestPath : "",
    auditScope: allowedSlugs ? "latest-run" : "all-records",
    summary,
    items: items.sort((left, right) => left.slug.localeCompare(right.slug)),
  };

  const baseName = `${timestamp()}.product-kb-health`;
  const jsonPath = path.join(automationDir, `${baseName}.json`);
  const mdPath = path.join(automationDir, `${baseName}.md`);
  const latestJsonPath = path.join(paths.outputDir, "latest-product-kb-health.json");
  const latestMdPath = path.join(paths.outputDir, "latest-product-kb-health.md");

  await writeJson(jsonPath, report);
  await writeText(mdPath, buildMarkdown(report));
  await writeJson(latestJsonPath, report);
  await writeText(latestMdPath, buildMarkdown(report));

  console.log(
    JSON.stringify(
      {
        reportPath: jsonPath,
        markdownPath: mdPath,
        summary,
      },
      null,
      2,
    ),
  );

  if (summary.polluted > 0 || summary.blocked > 0 || summary.usable === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
