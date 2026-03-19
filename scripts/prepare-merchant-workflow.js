import path from "node:path";
import {
  buildSupplierSearchPlan,
  buildSupplierInquiry,
  buildSupplierShortlistTemplate,
  buildSupplierResponseTemplate,
  detectProductProfile,
  ensureDir,
  getWorkflowPaths,
  loadAnalysis,
  normalizeDecision,
  parseArgs,
  shouldRequireSupplierResponse,
  refreshWorkflowArtifacts,
  slugifyProductName,
  timestamp,
  writeJson,
  writeText,
} from "./merchant-workflow-lib.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = getWorkflowPaths(process.cwd());
  const includeWatch = Boolean(args["include-watch"]);
  const { analysisPath, analysis } = await loadAnalysis(args.input, paths.outputDir);

  await ensureDir(paths.productsDir);
  await ensureDir(paths.queuesDir);
  await ensureDir(paths.knowledgeBaseDir);

  const eligibleProducts = analysis.products.filter((product) => {
    const decision = normalizeDecision(product.final_decision || product.go_or_no_go);
    if (decision === "Go") return true;
    return includeWatch && decision === "Watch";
  });

  let created = 0;

  for (const [index, product] of eligibleProducts.entries()) {
    const slug = slugifyProductName(product.name, index);
    const productDir = path.join(paths.productsDir, slug);
    const inquiryPath = path.join(productDir, "supplier-inquiry.md");
    const searchPlanPath = path.join(productDir, "supplier-search-plan.json");
    const shortlistTemplatePath = path.join(productDir, "supplier-shortlist.template.json");
    const responseTemplatePath = path.join(productDir, "supplier-response.template.json");
    const productJsonPath = path.join(productDir, "product.json");
    const profileInfo = detectProductProfile(product);

    const record = {
      id: `${timestamp()}-${slug}`,
      slug,
      source: {
        analysis_path: analysisPath,
        imported_at: new Date().toISOString(),
      },
      workflow: {
        current_stage: "supplier_research_pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      review: {
        status: "pending",
        notes: "",
        reviewed_at: "",
      },
      research: {
        product_profile: profileInfo.profile,
        risk_tags: profileInfo.risk_tags,
        requires_supplier_response: shouldRequireSupplierResponse({ product }),
        supplier_search_plan_path: searchPlanPath,
        supplier_shortlist_template_path: shortlistTemplatePath,
        supplier_inquiry_path: inquiryPath,
        supplier_response_template_path: responseTemplatePath,
        latest_supplier_response_path: "",
        supplier_responses: [],
        outreach: {
          status: "not_contacted",
          supplier_name: "",
          supplier_im_url: "",
          supplier_shop_url: "",
          search_summary_path: "",
          first_message_sent_at: "",
          last_contacted_at: "",
          follow_up_sent_count: 0,
          nudge_sent_count: 0,
        },
      },
      listing: {
        status: "not_ready",
        listing_brief_path: "",
      },
      paths: {
        product_json: productJsonPath,
      },
      product,
    };

    await ensureDir(productDir);
    await writeJson(searchPlanPath, buildSupplierSearchPlan(record));
    await writeJson(shortlistTemplatePath, buildSupplierShortlistTemplate(record));
    await writeText(inquiryPath, buildSupplierInquiry(record));
    await writeJson(responseTemplatePath, buildSupplierResponseTemplate(record));
    await writeJson(productJsonPath, record);
    created += 1;
  }

  await refreshWorkflowArtifacts(paths);

  console.log(`Imported analysis: ${analysisPath}`);
  console.log(`Products queued for supplier research: ${created}`);
  console.log(`Knowledge base: ${paths.knowledgeBaseDir}`);
  console.log(`Queues: ${paths.queuesDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
