import path from "node:path";
import fs from "node:fs/promises";
import {
  ensureDir,
  getWorkflowPaths,
  listProductRecords,
  parseArgs,
  readJson,
  timestamp,
  writeJson,
  writeText,
} from "./merchant-workflow-lib.js";

async function pickProduct(paths, slug) {
  const records = await listProductRecords(paths.productsDir);
  if (slug) {
    const match = records.find(({ record }) => record.slug === slug);
    if (!match) {
      throw new Error(`Unknown product slug: ${slug}`);
    }
    return match.record;
  }

  const queued = records.find(
    ({ record }) => record.workflow.current_stage === "supplier_research_pending",
  );
  if (!queued) {
    throw new Error("No product is waiting for supplier research.");
  }
  return queued.record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = getWorkflowPaths(process.cwd());
  const product = await pickProduct(paths, args.slug);
  const productDir = path.dirname(product.paths.product_json);

  const searchPlanPath = product.research.supplier_search_plan_path;
  const inquiryPath = product.research.supplier_inquiry_path;
  const shortlistTemplatePath = product.research.supplier_shortlist_template_path;
  const responseTemplatePath = product.research.supplier_response_template_path;

  const searchPlan = await readJson(searchPlanPath);
  const shortlistTemplate = await readJson(shortlistTemplatePath);
  const responseTemplate = await readJson(responseTemplatePath);
  const inquiryText = await fs.readFile(inquiryPath, "utf8");

  const packageId = `${timestamp()}-${product.slug}`;
  const stopRoot = path.join(paths.outputDir, "openclaw", packageId);
  const productStopDir = path.join(stopRoot, product.slug);

  await ensureDir(productStopDir);

  const stopManifest = {
    package_id: packageId,
    created_at: new Date().toISOString(),
    product_slug: product.slug,
    product_name: product.product.name,
    workflow_stage: product.workflow.current_stage,
    product_profile: product.research.product_profile || "",
    risk_tags: product.research.risk_tags || [],
    source_files: {
      product_json: product.paths.product_json,
      search_plan: searchPlanPath,
      inquiry_md: inquiryPath,
      shortlist_template: shortlistTemplatePath,
      response_template: responseTemplatePath,
    },
    output_files: {
      stop_markdown: path.join(productStopDir, "openclaw-stop.md"),
      stop_json: path.join(productStopDir, "openclaw-stop.json"),
      supplier_shortlist: path.join(productStopDir, "supplier-shortlist.template.json"),
      supplier_response: path.join(productStopDir, "supplier-response.template.json"),
      supplier_search_plan: path.join(productStopDir, "supplier-search-plan.json"),
    },
  };

  const stopMarkdown = [
    `# OpenClaw stop: ${product.product.name}`,
    "",
    "## Mission",
    "",
    "Find real suppliers for this product, shortlist them, ask the first round questions, and stop after recording the reply state.",
    "",
    "## Product",
    "",
    `- Slug: ${product.slug}`,
    `- Category: ${product.product.category || "unknown"}`,
    `- Profile: ${product.research.product_profile || "unknown"}`,
    `- Risk tags: ${(product.research.risk_tags || []).join(", ") || "none"}`,
    `- Current stage: ${product.workflow.current_stage}`,
    "",
    "## What to use",
    "",
    `- Search plan: ${path.basename(searchPlanPath)}`,
    `- Inquiry plan: ${path.basename(inquiryPath)}`,
    `- Shortlist template: ${path.basename(shortlistTemplatePath)}`,
    `- Response template: ${path.basename(responseTemplatePath)}`,
    "",
    "## Supplier discovery rules",
    "",
    `- Primary platform: ${searchPlan.channel_strategy.primary}`,
    `- Secondary platform: ${searchPlan.channel_strategy.secondary || "none"}`,
    `- Discovery order: ${(searchPlan.channel_strategy.discovery_order || []).join(" -> ") || "none"}`,
    `- Preferred contact channels: ${(searchPlan.channel_strategy.preferred_contact_channels || []).join(", ") || "none"}`,
    `- First pass target: ${searchPlan.supplier_discovery.first_pass_target}`,
    `- Shortlist target: ${searchPlan.supplier_discovery.shortlist_target}`,
    `- First-round outreach cap: ${searchPlan.execution_rule.first_round_contact_count}`,
    "",
    "## Platform notes",
    "",
    ...((searchPlan.channel_strategy.platform_notes || []).flatMap((item) => [
      `- ${item.platform}: ${item.positioning}`,
      ...item.supplier_signals.map((signal) => `- ${item.platform} signal: ${signal}`),
    ])),
    "",
    "## Selection criteria",
    "",
    ...searchPlan.ranking_rubric.map(
      (item) => `- ${item.factor}: ${item.weight} (${item.rule})`,
    ),
    "",
    "## Round 1 questions",
    "",
    ...inquiryText
      .split("\n")
      .filter((line) => line.startsWith("1.") || line.startsWith("2.") || line.startsWith("3.") || line.startsWith("4.") || line.startsWith("5.") || line.startsWith("6.") || line.startsWith("7.") || line.startsWith("8.") || line.startsWith("9.") || line.startsWith("10.")),
    "",
    "## Stop conditions",
    "",
    "- If login, captcha, or permission blocks appear, stop and report.",
    "- If the store cannot answer MOQ, price, weight, or dimensions, mark it as rejected.",
    "- After top 3 stores are contacted, stop and wait for human review.",
    "",
    "## Required outputs",
    "",
    "- supplier-shortlist.json",
    "- supplier-response.json",
    "- supplier-research-log.md",
    "- updated knowledge-base product record",
    "",
  ].join("\n");

  await writeJson(path.join(productStopDir, "openclaw-stop.json"), {
    ...stopManifest,
    search_plan: searchPlan,
    shortlist_template: shortlistTemplate,
    response_template: responseTemplate,
  });
  await writeText(path.join(productStopDir, "openclaw-stop.md"), stopMarkdown);
  await writeJson(path.join(productStopDir, "supplier-search-plan.json"), searchPlan);
  await writeJson(path.join(productStopDir, "supplier-shortlist.template.json"), shortlistTemplate);
  await writeJson(path.join(productStopDir, "supplier-response.template.json"), responseTemplate);
  await writeJson(path.join(productStopDir, "source-product.json"), product);

  const taskFile = {
    package_id: packageId,
    product_slug: product.slug,
    product_name: product.product.name,
    stage: "supplier_research_pending",
    platform: searchPlan.channel_strategy.primary,
    platforms: searchPlan.channel_strategy.discovery_order || [searchPlan.channel_strategy.primary],
    next_action: "discover-and-contact-suppliers",
    stop_after: "top-3-first-round-outreach",
    files: stopManifest.output_files,
  };

  await writeJson(path.join(productStopDir, "task.json"), taskFile);

  console.log(`OpenClaw stop package created: ${productStopDir}`);
  console.log(`Primary platform: ${searchPlan.channel_strategy.primary}`);
  console.log(`Profile: ${product.research.product_profile || "unknown"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
