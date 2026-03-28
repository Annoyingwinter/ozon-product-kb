import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkflowPaths, slugifyProductName } from "./merchant-workflow-lib.js";
import { buildKnowledgeBaseSkeleton, refreshKnowledgeBaseArtifacts } from "./product-kb-workflow-lib.js";
import { ensureDir, normalize, readJson, repairDeepMojibake, timestamp, writeJson } from "./shared-utils.js";

const DEFAULT_OUTPUT_DIR = path.resolve("output");
const DEFAULT_APPROVE_LIMIT = 5;
const DEFAULT_PLATFORM = "ozon";

function parseArgs(argv) {
  const args = {
    input: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    approveLimit: DEFAULT_APPROVE_LIMIT,
    platform: DEFAULT_PLATFORM,
    writeKb: true,
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
    } else if (current === "--approve-limit" && next) {
      args.approveLimit = Math.max(1, Number(next));
      index += 1;
    } else if (current === "--platform" && next) {
      args.platform = String(next).toLowerCase();
      index += 1;
    } else if (current === "--no-write-kb") {
      args.writeKb = false;
    }
  }

  if (!args.input) {
    throw new Error("Missing required argument: --input <selector-analysis.json>");
  }

  return args;
}

function buildSiblingPaths(analysisPath) {
  const base = analysisPath.replace(/\.analysis\.json$/i, "");
  return {
    manifestPath: `${base}.json`,
    analysisPath,
    inputPath: `${base}.input.json`,
    searchPath: `${base}.search.json`,
    reportPath: `${base}.report.md`,
  };
}

function toIsoNow() {
  return new Date().toISOString();
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map((value) => normalize(value)).filter(Boolean)));
}

function normalizeKeywordSet(...groups) {
  return new Set(
    groups
      .flat()
      .map((value) => normalize(value).toLowerCase())
      .filter(Boolean),
  );
}

function countFilledAttributes(attributes = {}) {
  return Object.values(attributes).filter((value) => {
    if (Array.isArray(value)) return value.map((item) => normalize(item)).filter(Boolean).length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(normalize(value));
  }).length;
}

function isReadableText(value, minimumLength = 8) {
  const text = normalize(value);
  if (text.length < minimumLength) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/(captcha|login|sign in|submit feedback|similar search|survey\.)/i.test(text)) return false;
  return true;
}

function buildReviewNotes(gateReview) {
  if (gateReview.status === "usable") {
    return "Approved by OZ Chief Listing Officer. Core listing gates passed.";
  }
  if (gateReview.status === "weak") {
    return `Weak listing candidate. Missing soft signals: ${gateReview.weak_failures.join(", ")}.`;
  }
  return `Rejected by hard gate: ${gateReview.hard_failures.join(", ")}.`;
}

function buildBulletPoints(product, offer) {
  const items = [
    normalize(product?.why_it_can_sell || ""),
    normalize(product?.category || ""),
    normalize(offer?.normalizedAttributes?.material || ""),
    normalize(offer?.normalizedAttributes?.feature || ""),
    normalize(offer?.normalizedAttributes?.style || ""),
    normalize(offer?.normalizedAttributes?.size || ""),
    normalize(offer?.normalizedAttributes?.color || ""),
    normalize(offer?.normalizedAttributes?.applicable_target || ""),
    Array.isArray(offer?.normalizedAttributes?.compatible_models)
      ? normalize(offer.normalizedAttributes.compatible_models.slice(0, 2).join(", "))
      : "",
  ].filter(Boolean);

  return Array.from(new Set(items)).slice(0, 6);
}

function buildSearchPlan(slug, product) {
  return {
    slug,
    source_platform: "1688",
    shortlist_target: 3,
    search_keywords: Array.isArray(product?.matched_keywords)
      ? product.matched_keywords.filter(Boolean)
      : [],
    created_from: "oz-chief-listing-officer",
  };
}

function buildCompetitorOffers(product, primaryOffer, offers) {
  const primaryUrl = normalize(primaryOffer?.source_url || product?.source_url || "");
  const productKeywords = normalizeKeywordSet(product?.matched_keywords || [], primaryOffer?.keyword_hits || []);
  const productCategory = normalize(product?.category || primaryOffer?.category_path || "").toLowerCase();
  const scored = [];

  for (const rawOffer of Array.isArray(offers) ? offers : []) {
    const offer = repairDeepMojibake(rawOffer || {});
    const sourceUrl = normalize(offer?.source_url || "");
    if (!sourceUrl) continue;

    let score = 0;
    if (sourceUrl === primaryUrl) score += 1000;

    const offerKeywords = normalizeKeywordSet(offer?.keyword_hits || []);
    for (const keyword of productKeywords) {
      if (offerKeywords.has(keyword)) score += 30;
    }

    const offerCategory = normalize(offer?.category_path || "").toLowerCase();
    if (productCategory && offerCategory) {
      if (offerCategory.includes(productCategory) || productCategory.includes(offerCategory)) {
        score += 18;
      }
    }

    if (normalize(offer?.shop_name || "") && normalize(offer?.shop_name || "") !== normalize(product?.supplier_name || "")) {
      score += 6;
    }
    if (Array.isArray(offer?.images) && offer.images.filter(Boolean).length >= 3) score += 6;
    if (Number(offer?.price || 0) > 0) score += 5;
    if (Number(offer?.weight_kg || 0) > 0) score += 4;
    if (Number(offer?.min_order_qty || 0) > 0) score += 3;

    scored.push({ offer, score });
  }

  const deduped = new Map();
  for (const item of scored.sort((left, right) => right.score - left.score)) {
    const sourceUrl = normalize(item.offer?.source_url || "");
    if (!sourceUrl || deduped.has(sourceUrl)) continue;
    deduped.set(sourceUrl, item.offer);
  }

  const selected = Array.from(deduped.values()).slice(0, 5);
  if (primaryUrl && !selected.some((item) => normalize(item?.source_url || "") === primaryUrl) && primaryOffer) {
    selected.unshift(primaryOffer);
  }

  return selected
    .map((offer) => repairDeepMojibake(offer))
    .filter((offer) => normalize(offer?.source_url || ""));
}

function buildCompareSummary(slug, product, competitorOffers) {
  const prices = competitorOffers
    .map((offer) => Number(offer?.price || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const selectedOffer = competitorOffers[0] || null;

  return {
    slug,
    compared_at: toIsoNow(),
    candidate_count: competitorOffers.length,
    selected_offer_source_url: normalize(selectedOffer?.source_url || product?.source_url || ""),
    price_min: prices.length ? Math.min(...prices) : 0,
    price_max: prices.length ? Math.max(...prices) : 0,
    price_avg: prices.length ? Number((prices.reduce((sum, value) => sum + value, 0) / prices.length).toFixed(2)) : 0,
    shortlist: competitorOffers.map((offer, index) => ({
      rank: index + 1,
      source_url: normalize(offer?.source_url || ""),
      shop_name: normalize(offer?.shop_name || ""),
      offer_title: normalize(offer?.offer_title || offer?.raw_search_title || product?.name || ""),
      price: Number(offer?.price || 0),
      min_order_qty: Number(offer?.min_order_qty || 0),
    })),
    notes: ["Shortlist assembled from the same 1688 search cluster for Ozon listing review."],
  };
}

function buildKnowledgeBase(record, primaryOffer, competitorOffers, compareSummary) {
  const kb = buildKnowledgeBaseSkeleton(record);
  const selectedOffer = primaryOffer || competitorOffers[0] || null;
  const images = uniqueStrings(
    competitorOffers.flatMap((offer) => (Array.isArray(offer?.images) ? offer.images : [])),
  ).slice(0, 12);
  const imageHash = images.length
    ? crypto.createHash("sha1").update(images.join("|")).digest("hex")
    : "";

  return {
    ...kb,
    generated_at: toIsoNow(),
    source_platform: "1688",
    source_url: normalize(selectedOffer?.source_url || record?.product?.source_url || ""),
    source_platform_urls: uniqueStrings(
      competitorOffers.map((offer) => offer?.source_url).concat(record?.product?.source_url || ""),
    ),
    brand: normalize(selectedOffer?.normalizedAttributes?.brand || ""),
    model: normalize(selectedOffer?.normalizedAttributes?.model || ""),
    vendor_code: normalize(selectedOffer?.normalizedAttributes?.vendor_code || kb.vendor_code),
    barcode: normalize(selectedOffer?.normalizedAttributes?.barcode || ""),
    title_cn: normalize(record?.product?.name || kb.title_cn),
    description: normalize(selectedOffer?.description || record?.product?.why_it_can_sell || kb.description),
    bullet_points: buildBulletPoints(record?.product, selectedOffer),
    price: Number(record?.product?.supply_price_cny || selectedOffer?.price || 0),
    old_price: 0,
    min_order_qty: Number(record?.product?.source_min_order_qty || selectedOffer?.min_order_qty || 0),
    weight: Number(record?.product?.est_weight_kg || selectedOffer?.weight_kg || kb.weight || 0),
    length:
      Number(record?.product?.package_long_edge_cm || 0) ||
      Number(selectedOffer?.package_dimensions_cm?.length || 0),
    width: Number(selectedOffer?.package_dimensions_cm?.width || 0),
    height: Number(selectedOffer?.package_dimensions_cm?.height || 0),
    category_path: normalize(record?.product?.category || selectedOffer?.category_path || kb.category_path),
    attributes: {
      ...kb.attributes,
      ...(selectedOffer?.normalizedAttributes || {}),
      source_category: normalize(record?.product?.category || ""),
      seasonality: normalize(record?.product?.seasonality || ""),
      fragility: normalize(record?.product?.fragility || ""),
      competition_level: normalize(record?.product?.competition_level || ""),
      content_potential: normalize(record?.product?.content_potential || ""),
    },
    main_image: normalize(selectedOffer?.main_image || images[0] || ""),
    images,
    image_count: images.length,
    image_hash: imageHash,
    is_fragile: String(record?.product?.fragility || "").toLowerCase() === "high",
    country_of_origin: normalize(selectedOffer?.normalizedAttributes?.country_of_origin || "CN"),
    competitor_offers: competitorOffers,
    comparison_summary: compareSummary,
    data_quality: {
      title_source: "chief-review",
      description_source: selectedOffer?.description ? "1688-detail" : "selection-analysis",
      web_detail_valid: true,
      inferred_fields: [],
    },
  };
}

function buildGateReview(product, knowledgeBase, compareSummary, competitorOffers) {
  const uniqueImages = uniqueStrings(knowledgeBase?.images || []);
  const bulletPoints = Array.isArray(knowledgeBase?.bullet_points)
    ? knowledgeBase.bullet_points.filter((item) => isReadableText(item, 6))
    : [];
  const weight = Number(knowledgeBase?.weight || product?.est_weight_kg || 0);
  const longEdge = Math.max(
    Number(knowledgeBase?.length || 0),
    Number(knowledgeBase?.width || 0),
    Number(knowledgeBase?.height || 0),
  );
  const sourceSignal = Number(product?.source_signal_score || 0);
  const certificationRisk = String(product?.certification_risk || "").toLowerCase();
  const returnRisk = String(product?.return_risk || "").toLowerCase();
  const filledAttributes = countFilledAttributes(knowledgeBase?.attributes || {});
  const uniqueSupplierCount = new Set(
    competitorOffers.map((offer) => normalize(offer?.shop_name || "")).filter(Boolean),
  ).size;

  const hardGates = {
    final_decision_go: String(product?.final_decision || "") === "Go",
    has_source_url: Boolean(normalize(knowledgeBase?.source_url || "")),
    compare_has_three_candidates: Number(compareSummary?.candidate_count || 0) >= 3,
    compare_has_selected_offer: Boolean(normalize(compareSummary?.selected_offer_source_url || "")),
    title_ready: isReadableText(knowledgeBase?.title_cn || "", 8),
    description_ready: isReadableText(knowledgeBase?.description || "", 20),
    bullet_points_ready: bulletPoints.length >= 2,
    attributes_ready: filledAttributes >= 3,
    price_ready: Number(knowledgeBase?.price || 0) > 0,
    currency_ready: Boolean(normalize(knowledgeBase?.currency || "")),
    weight_known_and_fit: weight === 0 || weight <= 1.2,
    size_known_and_fit: longEdge === 0 || longEdge <= 45,
    has_main_image: Boolean(normalize(knowledgeBase?.main_image || "")),
    has_enough_images:
      uniqueImages.length >= 3 &&
      Number(knowledgeBase?.image_count || 0) >= 3 &&
      uniqueImages.length >= Math.min(Number(knowledgeBase?.image_count || 0), 3),
    dangerous_goods_safe: knowledgeBase?.dangerous_goods !== true,
    restricted_category_safe: knowledgeBase?.restricted_category_flag !== true,
    certification_not_high: certificationRisk !== "high",
    return_not_high: returnRisk !== "high",
  };

  const weakSignals = {
    source_signal_ok: sourceSignal >= 65,
    sales_signal_present: Number(product?.source_sales_count || 0) > 0,
    moq_not_extreme:
      Number(product?.source_min_order_qty || 0) > 0 &&
      Number(product?.source_min_order_qty || 0) <= 50,
    has_supplier_name: Boolean(normalize(product?.supplier_name || "")),
    category_present: Boolean(normalize(product?.category || "")),
    sell_price_in_band:
      Number(product?.target_price_rub || 0) >= 1000 &&
      Number(product?.target_price_rub || 0) <= 4000,
    multi_supplier_view: uniqueSupplierCount >= 2,
  };

  const hardFailures = Object.entries(hardGates)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);

  const weakFailures = Object.entries(weakSignals)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);

  const status = hardFailures.length > 0 ? "polluted" : weakFailures.length > 0 ? "weak" : "usable";

  return {
    status,
    hard_gates: hardGates,
    weak_signals: weakSignals,
    hard_failures: hardFailures,
    weak_failures: weakFailures,
  };
}

function buildListingBrief(record, kb, review) {
  const product = record.product || {};
  const lines = [
    `# Listing brief: ${product.name || record.slug}`,
    "",
    "## Judgment",
    "",
    `- Chief review: ${review.status}`,
    `- Decision: ${product.final_decision || ""}`,
    `- Estimated Ozon price: ${product.target_price_rub || 0} RUB`,
    `- Source price: ${product.supply_price_cny || 0} CNY`,
    `- Weight: ${product.est_weight_kg || 0} kg`,
    `- Long edge: ${product.package_long_edge_cm || 0} cm`,
    "",
    "## Supplier",
    "",
    `- Supplier: ${product.supplier_name || ""}`,
    `- Source URL: ${product.source_url || ""}`,
    `- MOQ: ${product.source_min_order_qty || 0}`,
    "",
    "## Selling angle",
    "",
    `- Why it can sell: ${product.why_it_can_sell || ""}`,
    `- Content potential: ${product.content_potential || ""}`,
    "",
    "## Assets",
    "",
    `- Main image: ${kb.main_image || ""}`,
    `- Image count: ${kb.image_count || 0}`,
    "",
  ];
  return lines.join("\n");
}

function isModuleEntry() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const siblingPaths = buildSiblingPaths(args.input);
  const analysis = await readJson(siblingPaths.analysisPath, null);
  const searchSnapshot = await readJson(siblingPaths.searchPath, null);
  const runManifest = await readJson(siblingPaths.manifestPath, null);

  if (!analysis || !Array.isArray(analysis.products)) {
    throw new Error(`Invalid analysis file: ${siblingPaths.analysisPath}`);
  }
  if (!searchSnapshot || !Array.isArray(searchSnapshot.offers)) {
    throw new Error(`Missing selector search snapshot: ${siblingPaths.searchPath}`);
  }

  await ensureDir(args.outputDir);

  const allOffers = repairDeepMojibake(searchSnapshot.offers || []);
  const offerBySourceUrl = new Map(
    allOffers.map((offer) => [normalize(offer?.source_url || ""), offer]),
  );

  const reviewed = analysis.products
    .map((rawProduct, index) => {
      const product = repairDeepMojibake(rawProduct || {});
      const slug = slugifyProductName(product?.name || `item-${index + 1}`, index);
      const offer = offerBySourceUrl.get(normalize(product?.source_url || "")) || null;
      const competitorOffers = buildCompetitorOffers(product, offer, allOffers);
      const compareSummary = buildCompareSummary(slug, product, competitorOffers);
      const previewRecord = { slug, product };
      const knowledgeBase = buildKnowledgeBase(previewRecord, offer, competitorOffers, compareSummary);
      const gateReview = buildGateReview(product, knowledgeBase, compareSummary, competitorOffers);

      return {
        rank: index + 1,
        slug,
        product,
        offer,
        competitor_offers: competitorOffers,
        compare_summary: compareSummary,
        knowledge_base: knowledgeBase,
        gate_review: gateReview,
        note: buildReviewNotes(gateReview),
      };
    })
    .sort((left, right) => {
      if (left.gate_review.status !== right.gate_review.status) {
        const order = { usable: 0, weak: 1, polluted: 2 };
        return order[left.gate_review.status] - order[right.gate_review.status];
      }
      return Number(right.product?.total_score || 0) - Number(left.product?.total_score || 0);
    });

  const approved = reviewed
    .filter((item) => item.gate_review.status === "usable")
    .slice(0, args.approveLimit);
  const weak = reviewed.filter((item) => item.gate_review.status === "weak");
  const polluted = reviewed.filter((item) => item.gate_review.status === "polluted");

  const chiefRunId = `oz-chief-${timestamp()}`;
  const paths = getWorkflowPaths(process.cwd());
  const writtenProducts = [];

  if (args.writeKb) {
    for (const item of approved) {
      const slug = item.slug;
      const dir = path.join(paths.productsDir, slug);
      const productJsonPath = path.join(dir, "product.json");
      const comparePlanPath = path.join(dir, "1688-search-plan.json");
      const compareSummaryPath = path.join(dir, "1688-compare.summary.json");
      const competitorOffersPath = path.join(dir, "1688-competitor-offers.json");
      const knowledgeBasePath = path.join(dir, "ozon-knowledge.json");
      const chiefReviewPath = path.join(dir, "oz-chief-review.json");
      const listingBriefPath = path.join(dir, "listing-brief.md");

      const record = {
        id: `${toIsoNow()}-${slug}`,
        slug,
        source: {
          analysis_path: siblingPaths.analysisPath,
          imported_at: toIsoNow(),
          chief_input_manifest: siblingPaths.manifestPath,
        },
        workflow: {
          current_stage: "approved_for_listing",
          created_at: toIsoNow(),
          updated_at: toIsoNow(),
          pipeline: "direct-1688-selector",
          run_id: chiefRunId,
        },
        review: {
          status: "approved",
          notes: item.note,
          reviewed_at: toIsoNow(),
        },
        research: {
          source_platform: "1688",
          compare_status: "completed",
          compare_plan_path: comparePlanPath,
          compare_summary_path: compareSummaryPath,
          competitor_offers_path: competitorOffersPath,
          compared_at: toIsoNow(),
          shortlist_count: item.competitor_offers.length,
          last_error: "",
          blocked_snapshot_path: "",
          chief_review_path: chiefReviewPath,
        },
        listing: {
          status: "approved_for_listing",
          knowledge_base_path: knowledgeBasePath,
          listing_brief_path: listingBriefPath,
        },
        paths: {
          product_json: productJsonPath,
          compare_plan_path: comparePlanPath,
          compare_summary_path: compareSummaryPath,
          competitor_offers_path: competitorOffersPath,
          knowledge_base_path: knowledgeBasePath,
          chief_review_path: chiefReviewPath,
        },
        product: item.product,
        knowledge_base: item.knowledge_base,
      };

      await ensureDir(dir);
      await writeJson(comparePlanPath, buildSearchPlan(slug, item.product));
      await writeJson(compareSummaryPath, item.compare_summary);
      await writeJson(competitorOffersPath, item.competitor_offers);
      await writeJson(knowledgeBasePath, item.knowledge_base);
      await writeJson(chiefReviewPath, {
        slug,
        status: item.gate_review.status,
        note: item.note,
        gate_review: item.gate_review,
        compare_summary: item.compare_summary,
        approved_at: toIsoNow(),
      });
      await fs.writeFile(listingBriefPath, buildListingBrief(record, item.knowledge_base, item.gate_review), "utf8");
      await writeJson(productJsonPath, record);
      writtenProducts.push({
        slug,
        dir,
        productJsonPath,
        knowledgeBasePath,
        chiefReviewPath,
      });
    }

    await refreshKnowledgeBaseArtifacts(paths, {});
  }

  const reviewManifest = {
    generatedAt: toIsoNow(),
    runId: chiefRunId,
    input: siblingPaths,
    sourceRun: runManifest,
    approveLimit: args.approveLimit,
    counts: {
      total: reviewed.length,
      usable: approved.length,
      weak: weak.length,
      polluted: polluted.length,
    },
    approved: approved.map((item) => ({
      slug: item.slug,
      name: item.product?.name || "",
      total_score: item.product?.total_score || 0,
      source_url: item.product?.source_url || "",
      note: item.note,
    })),
    weak: weak.map((item) => ({
      slug: item.slug,
      name: item.product?.name || "",
      failures: item.gate_review.weak_failures,
      note: item.note,
    })),
    polluted: polluted.map((item) => ({
      slug: item.slug,
      name: item.product?.name || "",
      failures: item.gate_review.hard_failures,
      note: item.note,
    })),
    writtenProducts,
  };

  const outputBase = path.join(args.outputDir, `${chiefRunId}`);
  await writeJson(`${outputBase}.review.json`, reviewManifest);
  await fs.writeFile(
    `${outputBase}.review.md`,
    [
      "# OZ Chief Listing Officer",
      "",
      `Run ID: ${chiefRunId}`,
      `Input: ${siblingPaths.analysisPath}`,
      "",
      `Usable: ${approved.length}`,
      `Weak: ${weak.length}`,
      `Polluted: ${polluted.length}`,
      "",
      "## Approved",
      ...approved.map(
        (item) =>
          `- ${item.slug} | ${item.product?.name || ""} | score ${item.product?.total_score || 0} | ${item.note}`,
      ),
      "",
      "## Weak",
      ...weak.map(
        (item) =>
          `- ${item.slug} | ${(item.gate_review.weak_failures || []).join(", ") || "none"} | ${item.note}`,
      ),
      "",
      "## Polluted",
      ...polluted.map(
        (item) =>
          `- ${item.slug} | ${(item.gate_review.hard_failures || []).join(", ") || "none"} | ${item.note}`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`Chief review: ${outputBase}.review.json`);
  console.log(`Approved products: ${approved.length}`);
}

if (isModuleEntry()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
