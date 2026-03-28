import crypto from "node:crypto";
import path from "node:path";
import {
  ensureDir,
  findLatestAnalysisFile,
  getWorkflowPaths,
  listProductRecords,
  loadAnalysis,
  normalizeDecision,
  readJson,
  slugifyProductName,
  writeJson,
  writeText,
} from "./merchant-workflow-lib.js";
import { normalize, compactText, parseNumber, repairDeepMojibake } from "./shared-utils.js";

const KB_SCHEMA_VERSION = "ozon-kb-v1";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function baseKeyword(value) {
  return normalize(value)
    .replace(/[()（）【】\[\]]/g, " ")
    .replace(/[\/+|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSpuId(slug) {
  return `SPU-${String(slug || "product").replace(/[^a-z0-9]+/gi, "-").toUpperCase()}`;
}

function buildSkuId(spuId) {
  return `${spuId}-DEFAULT`;
}

function computeImageHash(images = []) {
  const payload = safeArray(images).map((item) => normalize(item)).filter(Boolean).join("|");
  if (!payload) return "";
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function deriveDangerousGoods(product) {
  const haystack = normalize(
    `${product?.name || ""} ${product?.category || ""} ${safeArray(product?.risk_notes).join(" ")}`,
  ).toLowerCase();
  return /(battery|usb|充电|电池|液体|液态|磁|磁吸|led)/i.test(haystack);
}

function deriveRestrictedCategory(product) {
  const haystack = normalize(
    `${product?.name || ""} ${product?.category || ""} ${safeArray(product?.risk_notes).join(" ")}`,
  ).toLowerCase();
  return /(adult|情趣|刀|刃|液体|磁|电池|化学|食品接触|food)/i.test(haystack);
}

function buildBulletPoints(product) {
  const points = [];
  const why = compactText(product?.why_it_can_sell || "", 300);
  if (why) {
    const segments = why
      .split(/[。；;，,]/)
      .map((item) => normalize(item))
      .filter(Boolean);
    points.push(...segments.slice(0, 4));
  }
  if (product?.seasonality) {
    points.push(`Seasonality: ${product.seasonality}`);
  }
  if (product?.competition_level) {
    points.push(`Competition: ${product.competition_level}`);
  }
  return Array.from(new Set(points.filter(Boolean))).slice(0, 6);
}

function buildSeedAttributes(product) {
  const attributes = {};
  if (product?.category) attributes.source_category = product.category;
  if (product?.seasonality) attributes.seasonality = product.seasonality;
  if (product?.fragility) attributes.fragility = product.fragility;
  if (product?.competition_level) attributes.competition_level = product.competition_level;
  if (product?.content_potential) attributes.content_potential = product.content_potential;
  return attributes;
}

function buildSearchKeywords(product) {
  const name = baseKeyword(product?.name || "");
  const category = baseKeyword(product?.category || "");
  const simplifiedName = name
    .replace(/[()（）\[\]【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compactName = simplifiedName.replace(/\s+/g, "");
  const nameWords = simplifiedName.split(/\s+/).filter(Boolean);
  const tailWords = nameWords.length > 1 ? nameWords.slice(-2).join(" ") : "";
  const seeds = [
    name,
    simplifiedName,
    compactName && compactName !== simplifiedName ? compactName : "",
    `${simplifiedName} 1688`,
    `${simplifiedName} 工厂`,
    `${simplifiedName} 现货`,
    tailWords,
    category ? `${category} ${simplifiedName}` : "",
    category && tailWords ? `${category} ${tailWords}` : "",
    category,
  ];
  return Array.from(new Set(seeds.map((item) => normalize(item)).filter((item) => item.length >= 2))).slice(0, 8);
}

export function buildKnowledgeBaseSkeleton(productRecord) {
  const product = repairDeepMojibake(productRecord?.product || {});
  const spuId = buildSpuId(productRecord.slug);
  const skuId = buildSkuId(spuId);
  const images = [];

  return {
    schema_version: KB_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source_platform: "1688",
    source_url: "",
    source_platform_urls: [],
    spu_id: spuId,
    sku_id: skuId,
    group_id: spuId,
    variant_theme: "",
    variant_values: {},
    brand: "",
    model: "",
    vendor_code: skuId,
    barcode: "",
    title_cn: normalize(product.name || ""),
    title_en: "",
    title_ru: "",
    description: compactText(product.why_it_can_sell || "", 1000),
    bullet_points: buildBulletPoints(product),
    price: parseNumber(product.supply_price_cny, 0),
    old_price: 0,
    currency: "CNY",
    stock: null,
    min_order_qty: 0,
    package_quantity: 1,
    vat: "",
    weight: parseNumber(product.est_weight_kg, 0),
    length: parseNumber(product.package_long_edge_cm, 0),
    width: 0,
    height: 0,
    category_path: normalize(product.category || ""),
    category_id_source: "",
    ozon_category_id: "",
    attributes: buildSeedAttributes(product),
    main_image: "",
    images,
    video_url: "",
    image_count: 0,
    image_hash: computeImageHash(images),
    white_background: null,
    is_adult: false,
    is_fragile: String(product.fragility || "").toLowerCase() === "high",
    dangerous_goods: deriveDangerousGoods(product),
    country_of_origin: "CN",
    certificate_files: [],
    brand_authorization: "",
    customs_code: "",
    restricted_category_flag: deriveRestrictedCategory(product),
    competitor_offers: [],
    comparison_summary: {
      compared_at: "",
      candidate_count: 0,
      selected_offer_source_url: "",
      price_min: 0,
      price_max: 0,
      price_avg: 0,
      notes: [],
    },
  };
}

export function build1688ComparePlan(productRecord) {
  const product = repairDeepMojibake(productRecord?.product || {});
  return {
    slug: productRecord.slug,
    product_name: normalize(product.name || ""),
    product_category: normalize(product.category || ""),
    source_platform: "1688",
    shortlist_target: 3,
    search_keywords: buildSearchKeywords(product),
    compare_dimensions: [
      "title_relevance",
      "price",
      "min_order_qty",
      "package_or_carton_info",
      "attributes",
      "images",
      "detail_completeness",
    ],
    ozon_required_fields: [
      "spu_id",
      "sku_id",
      "source_platform",
      "source_url",
      "brand",
      "model",
      "vendor_code",
      "barcode",
      "title_cn",
      "title_en",
      "title_ru",
      "description",
      "bullet_points",
      "price",
      "old_price",
      "currency",
      "stock",
      "min_order_qty",
      "package_quantity",
      "vat",
      "weight",
      "length",
      "width",
      "height",
      "category_path",
      "category_id_source",
      "ozon_category_id",
      "attributes",
      "main_image",
      "images",
      "video_url",
      "image_count",
      "image_hash",
      "white_background",
      "is_adult",
      "is_fragile",
      "dangerous_goods",
      "country_of_origin",
      "certificate_files",
      "brand_authorization",
      "customs_code",
      "restricted_category_flag",
      "group_id",
      "variant_theme",
      "variant_values",
    ],
  };
}

export function buildProductKnowledgeRecord({ product, analysisPath, index }) {
  const cleanProduct = repairDeepMojibake(product || {});
  const slug = slugifyProductName(cleanProduct.name, index);
  const paths = {
    product_json: "",
    compare_plan_path: "",
    compare_summary_path: "",
    competitor_offers_path: "",
    knowledge_base_path: "",
  };

  const record = {
    id: `${new Date().toISOString()}-${slug}`,
    slug,
    source: {
      analysis_path: analysisPath,
      imported_at: new Date().toISOString(),
    },
    workflow: {
      current_stage: "supplier_compare_pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    review: {
      status: "pending",
      notes: "",
      reviewed_at: "",
    },
    research: {
      source_platform: "1688",
      compare_status: "pending",
      compare_plan_path: "",
      compare_summary_path: "",
      competitor_offers_path: "",
      compared_at: "",
      shortlist_count: 0,
      last_error: "",
    },
    listing: {
      status: "not_ready",
      knowledge_base_path: "",
      listing_brief_path: "",
    },
    paths,
    product: cleanProduct,
    knowledge_base: null,
  };

  return record;
}

export function finalizeProductRecordPaths(record, productDir) {
  record.paths.product_json = path.join(productDir, "product.json");
  record.paths.compare_plan_path = path.join(productDir, "1688-search-plan.json");
  record.paths.compare_summary_path = path.join(productDir, "1688-compare.summary.json");
  record.paths.competitor_offers_path = path.join(productDir, "1688-competitor-offers.json");
  record.paths.knowledge_base_path = path.join(productDir, "ozon-knowledge.json");
  record.research.compare_plan_path = record.paths.compare_plan_path;
  record.research.compare_summary_path = record.paths.compare_summary_path;
  record.research.competitor_offers_path = record.paths.competitor_offers_path;
  record.listing.knowledge_base_path = record.paths.knowledge_base_path;
  return record;
}

function summarizeCategoryMapping(products) {
  const seen = new Map();
  for (const item of products) {
    const sourcePath = normalize(item.category_path || item.attributes?.source_category || "");
    if (!sourcePath) continue;
    if (!seen.has(sourcePath)) {
      seen.set(sourcePath, {
        source_category_path: sourcePath,
        source_platform: item.source_platform || "1688",
        ozon_category_id: item.ozon_category_id || "",
        ozon_category_name: "",
        mapping_status: item.ozon_category_id ? "mapped" : "pending",
      });
    }
  }
  return Array.from(seen.values());
}

function summarizeCategories(products) {
  return summarizeCategoryMapping(products).map((item, index) => ({
    id: `SRC-CAT-${index + 1}`,
    source_category_path: item.source_category_path,
    source_platform: item.source_platform,
  }));
}

function summarizeAttributes(products) {
  const byCategory = new Map();
  for (const item of products) {
    const category = normalize(item.category_path || item.attributes?.source_category || "uncategorized");
    const attrs = item.attributes && typeof item.attributes === "object" ? item.attributes : {};
    if (!byCategory.has(category)) {
      byCategory.set(category, new Map());
    }
    const bucket = byCategory.get(category);
    for (const [key, value] of Object.entries(attrs)) {
      const name = normalize(key);
      if (!name) continue;
      const existing = bucket.get(name) || { attribute_name: name, value_type: "string", required: false };
      if (Array.isArray(value)) existing.value_type = "array";
      bucket.set(name, existing);
    }
  }

  return Array.from(byCategory.entries()).map(([category_path, values]) => ({
    source_category_path: category_path,
    attributes: Array.from(values.values()),
  }));
}

function summarizeAttributeValues(products) {
  const buckets = new Map();
  for (const item of products) {
    const attrs = item.attributes && typeof item.attributes === "object" ? item.attributes : {};
    for (const [key, value] of Object.entries(attrs)) {
      const name = normalize(key);
      if (!name) continue;
      if (!buckets.has(name)) buckets.set(name, new Set());
      const set = buckets.get(name);
      const values = Array.isArray(value) ? value : [value];
      for (const candidate of values) {
        const normalized = normalize(candidate);
        if (normalized) set.add(normalized);
      }
    }
  }

  return Array.from(buckets.entries()).map(([attribute_name, values]) => ({
    attribute_name,
    values: Array.from(values).slice(0, 100),
  }));
}

function buildUploadRulesMarkdown() {
  return [
    "# Ozon Upload Rules",
    "",
    "## Required product coverage",
    "- Identification: spu_id, sku_id, source_platform, source_url, vendor_code, barcode",
    "- Selling: price, currency, stock, min_order_qty, package_quantity, dimensions, weight",
    "- Category and attributes: category_path, ozon_category_id, attributes",
    "- Media: main_image, images, image_count, image_hash",
    "- Compliance: dangerous_goods, country_of_origin, certificate_files, customs_code",
    "",
    "## Field policy",
    "- Leave unknown fields blank but keep the key in JSON.",
    "- Prefer values extracted from 1688 detail pages over search-card snippets.",
    "- One product must contain at least three comparable 1688 offers before it can be marked knowledge_base_ready.",
    "- Images should be URL-based and deduplicated before export.",
    "",
    "## Variant policy",
    "- group_id must stay stable across all variants.",
    "- variant_theme stays blank unless the detail page clearly exposes a variant dimension such as color or size.",
    "- variant_values must be an object, even when empty.",
    "",
  ].join("\n");
}

function buildRestrictedRulesMarkdown() {
  return [
    "# Restricted Category Rules",
    "",
    "- dangerous_goods should be true for battery, liquid, magnetic, chemical, or similar transport-sensitive goods.",
    "- restricted_category_flag should be true when the source page suggests adult, blade, strong magnet, battery, liquid, food-contact, or certification-heavy categories.",
    "- certificate_files should hold uploaded or referenced compliance documents when available; otherwise keep an empty array.",
    "- brand_authorization stays blank unless a page explicitly provides brand authorization evidence.",
    "",
  ].join("\n");
}

function buildLiveStatusMarkdown(status) {
  return [
    "# Live Status",
    "",
    `Generated at: ${status.generatedAt}`,
    "",
    "## Selection",
    `- Analysis file: ${status.selection.analysisPath || "none"}`,
    `- Total analyzed: ${status.selection.total}`,
    `- Go: ${status.selection.Go}`,
    `- Watch: ${status.selection.Watch}`,
    `- No-Go: ${status.selection["No-Go"]}`,
    "",
    "## Knowledge Base Workflow",
    `- Compare pending: ${status.workflow.supplier_compare_pending}`,
    `- Compare blocked: ${status.workflow.supplier_compare_blocked}`,
    `- Knowledge base ready: ${status.workflow.knowledge_base_ready}`,
    `- Approved for listing: ${status.workflow.approved_for_listing}`,
    `- Rejected: ${status.workflow.rejected}`,
    "",
    "## Queues",
    `- Compare queue: ${status.queues.compare.count}`,
    `- Blocked queue: ${status.queues.blocked.count}`,
    `- Review queue: ${status.queues.review.count}`,
    `- Listing queue: ${status.queues.listing.count}`,
    `- Follow-up queue: ${status.queues.followUp.count} (disabled)`,
    "",
    "## Recent Activity",
    ...status.recentActivity.map(
      (item, index) =>
        `${index + 1}. ${item.at} | ${item.slug} | ${item.stage} | ${item.detail || ""}`,
    ),
    "",
  ].join("\n");
}

function buildSelectionCounts(analysis) {
  const counts = { total: 0, Go: 0, Watch: 0, "No-Go": 0, Other: 0 };
  for (const product of analysis?.products || []) {
    const decision = normalizeDecision(product.final_decision || product.go_or_no_go);
    counts.total += 1;
    if (decision === "Go") counts.Go += 1;
    else if (decision === "Watch") counts.Watch += 1;
    else if (decision === "No-Go") counts["No-Go"] += 1;
    else counts.Other += 1;
  }
  return counts;
}

export async function refreshKnowledgeBaseArtifacts(paths = getWorkflowPaths(process.cwd()), filters = {}) {
  const productEntries = await listProductRecords(paths.productsDir);
  const analysisPathFilter = normalize(filters.analysisPath || "");
  const pipelineFilter = normalize(filters.pipeline || "");
  const slugFilter = Array.isArray(filters.slugs)
    ? new Set(filters.slugs.map((item) => normalize(item)).filter(Boolean))
    : null;
  const records = productEntries
    .map(({ record }) => repairDeepMojibake(record))
    .filter((record) => {
      if (!record) return false;
      if (analysisPathFilter && normalize(record?.source?.analysis_path || "") !== analysisPathFilter) {
        return false;
      }
      if (pipelineFilter && normalize(record?.workflow?.pipeline || "") !== pipelineFilter) {
        return false;
      }
      if (slugFilter && slugFilter.size > 0 && !slugFilter.has(normalize(record?.slug || ""))) {
        return false;
      }
      return true;
    });
  const productKnowledge = [];

  for (const record of records) {
    const stage = record?.workflow?.current_stage || "";
    if (!["knowledge_base_ready", "approved_for_listing"].includes(stage)) {
      continue;
    }
    const kbPath = record?.paths?.knowledge_base_path || record?.listing?.knowledge_base_path || "";
    const kb = kbPath ? await readJson(kbPath, null) : null;
    if (kb) {
      productKnowledge.push(kb);
    } else if (record?.knowledge_base) {
      productKnowledge.push(record.knowledge_base);
    }
  }

  const compareQueue = records
    .filter((record) => record?.workflow?.current_stage === "supplier_compare_pending")
    .map((record) => ({
      slug: record.slug,
      name: normalize(record?.product?.name || record.slug),
      source_platform: "1688",
      comparePlanPath: record?.paths?.compare_plan_path || "",
      knowledgeBasePath: record?.paths?.knowledge_base_path || "",
      productJsonPath: record?.paths?.product_json || "",
    }));

  const blockedQueue = records
    .filter((record) => record?.workflow?.current_stage === "supplier_compare_blocked")
    .map((record) => ({
      slug: record.slug,
      name: normalize(record?.product?.name || record.slug),
      blockedSnapshotPath: record?.research?.blocked_snapshot_path || "",
      compareSummaryPath: record?.paths?.compare_summary_path || "",
      productJsonPath: record?.paths?.product_json || "",
      lastError: normalize(record?.research?.last_error || ""),
    }));

  const reviewQueue = records
    .filter((record) => record?.workflow?.current_stage === "knowledge_base_ready")
    .map((record) => ({
      slug: record.slug,
      name: normalize(record?.product?.name || record.slug),
      compareSummaryPath: record?.paths?.compare_summary_path || "",
      knowledgeBasePath: record?.paths?.knowledge_base_path || "",
      productJsonPath: record?.paths?.product_json || "",
    }));

  const listingQueue = records
    .filter((record) => record?.workflow?.current_stage === "approved_for_listing")
    .map((record) => ({
      slug: record.slug,
      name: normalize(record?.product?.name || record.slug),
      knowledgeBasePath: record?.paths?.knowledge_base_path || "",
      productJsonPath: record?.paths?.product_json || "",
    }));

  const analysisPath = await findLatestAnalysisFile(paths.outputDir).catch(() => "");
  const analysis = analysisPath ? await readJson(analysisPath, null) : null;

  const index = {
    generatedAt: new Date().toISOString(),
    counts: {
      total: records.length,
      supplier_compare_pending: compareQueue.length,
      supplier_compare_blocked: blockedQueue.length,
      knowledge_base_ready: reviewQueue.length,
      approved_for_listing: listingQueue.length,
      rejected: records.filter((record) => record?.workflow?.current_stage === "rejected").length,
    },
    products: records.map((record) => ({
      slug: record.slug,
      name: normalize(record?.product?.name || record.slug),
      currentStage: record?.workflow?.current_stage || "",
      compareStatus: record?.research?.compare_status || "",
      knowledgeBasePath: record?.paths?.knowledge_base_path || "",
      compareSummaryPath: record?.paths?.compare_summary_path || "",
      sourceDecision: record?.product?.source_decision || "",
      finalDecision: record?.product?.final_decision || "",
    })),
  };

  const liveStatus = {
    generatedAt: new Date().toISOString(),
    files: {
      analysisPath,
      indexPath: paths.indexPath,
      researchQueuePath: paths.researchQueuePath,
      blockedQueuePath: paths.blockedQueuePath,
      followUpQueuePath: paths.followUpQueuePath,
      reviewQueuePath: paths.reviewQueuePath,
      listingQueuePath: paths.listingQueuePath,
      blockedArtifactsDir: paths.blockedArtifactsDir,
      liveStatusJsonPath: paths.liveStatusJsonPath,
      liveStatusMdPath: paths.liveStatusMdPath,
    },
    selection: {
      analysisPath,
      ...buildSelectionCounts(analysis),
    },
    workflow: index.counts,
    queues: {
      compare: {
        count: compareQueue.length,
        sample: compareQueue.slice(0, 5),
      },
      blocked: {
        count: blockedQueue.length,
        sample: blockedQueue.slice(0, 5),
      },
      followUp: {
        count: 0,
        sample: [],
      },
      review: {
        count: reviewQueue.length,
        sample: reviewQueue.slice(0, 5),
      },
      listing: {
        count: listingQueue.length,
        sample: listingQueue.slice(0, 5),
      },
    },
    recentActivity: records
      .map((record) => ({
        slug: record.slug,
        stage: record?.workflow?.current_stage || "",
        at: record?.workflow?.updated_at || record?.workflow?.created_at || "",
        detail:
          record?.workflow?.current_stage === "knowledge_base_ready"
            ? "1688 comparison complete, knowledge base ready for review"
            : record?.workflow?.current_stage === "supplier_compare_pending"
              ? "Waiting for 1688 comparison"
              : record?.workflow?.current_stage === "supplier_compare_blocked"
                ? normalize(record?.research?.last_error || "1688 comparison blocked")
              : record?.workflow?.current_stage || "",
      }))
      .filter((item) => item.at)
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
      .slice(0, 10),
  };

  await writeJson(paths.indexPath, index);
  await writeJson(paths.researchQueuePath, compareQueue);
  await writeJson(paths.blockedQueuePath, blockedQueue);
  await writeJson(paths.followUpQueuePath, []);
  await writeJson(paths.reviewQueuePath, reviewQueue);
  await writeJson(paths.listingQueuePath, listingQueue);
  await writeJson(path.join(paths.knowledgeBaseDir, "products.json"), productKnowledge);
  await writeJson(path.join(paths.knowledgeBaseDir, "categories.json"), summarizeCategories(productKnowledge));
  await writeJson(path.join(paths.knowledgeBaseDir, "category_mapping.json"), summarizeCategoryMapping(productKnowledge));
  await writeJson(path.join(paths.knowledgeBaseDir, "ozon_attributes.json"), summarizeAttributes(productKnowledge));
  await writeJson(
    path.join(paths.knowledgeBaseDir, "ozon_attribute_values.json"),
    summarizeAttributeValues(productKnowledge),
  );
  await writeText(path.join(paths.knowledgeBaseDir, "upload_rules.md"), buildUploadRulesMarkdown());
  await writeText(path.join(paths.knowledgeBaseDir, "restricted_rules.md"), buildRestrictedRulesMarkdown());
  await writeJson(paths.liveStatusJsonPath, liveStatus);
  await writeText(paths.liveStatusMdPath, buildLiveStatusMarkdown(liveStatus));
}

export async function loadPreparedKnowledgeRecords(inputPath, outputDir) {
  return loadAnalysis(inputPath, outputDir);
}
