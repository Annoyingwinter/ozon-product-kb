import fs from "node:fs/promises";
import { timestamp, ensureDir } from "./shared-utils.js";
import path from "node:path";

const DEFAULT_PLATFORM = "ozon";
const DEFAULT_OUTPUT_DIR = path.resolve("output");

const PLATFORM_DEFAULTS = {
  ozon: {
    marketplace: "Ozon Russia",
    priceMinRub: 1000,
    priceMaxRub: 4000,
    maxWeightKg: 1.2,
    maxLongEdgeCm: 45,
    logisticsWeight: 20,
    marginWeight: 25,
    competitionWeight: 15,
    complianceWeight: 15,
    returnWeight: 15,
    contentWeight: 10,
    exchangeRateRubPerCny: 12.5,
  },
};

function parseArgs(argv) {
  const args = {
    input: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    platform: DEFAULT_PLATFORM,
    productGoal: "筛选适合 Ozon 俄罗斯站的轻小件、高复购、低售后候选品",
    category: "",
    targetUsers: "",
    priceMinRub: undefined,
    priceMaxRub: undefined,
    maxWeightKg: undefined,
    maxLongEdgeCm: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--input" && next) {
      args.input = path.resolve(next);
      i += 1;
    } else if (current === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (current === "--platform" && next) {
      args.platform = next.toLowerCase();
      i += 1;
    } else if (current === "--product-goal" && next) {
      args.productGoal = next;
      i += 1;
    } else if (current === "--category" && next) {
      args.category = next;
      i += 1;
    } else if (current === "--target-users" && next) {
      args.targetUsers = next;
      i += 1;
    } else if (current === "--price-min-rub" && next) {
      args.priceMinRub = Number(next);
      i += 1;
    } else if (current === "--price-max-rub" && next) {
      args.priceMaxRub = Number(next);
      i += 1;
    } else if (current === "--max-weight-kg" && next) {
      args.maxWeightKg = Number(next);
      i += 1;
    } else if (current === "--max-long-edge-cm" && next) {
      args.maxLongEdgeCm = Number(next);
      i += 1;
    }
  }

  if (!args.input) {
    throw new Error("Missing required argument: --input <json-or-csv-file>");
  }

  return args;
}

function getRules(args) {
  const base = PLATFORM_DEFAULTS[args.platform] || PLATFORM_DEFAULTS[DEFAULT_PLATFORM];
  return {
    ...base,
    priceMinRub: args.priceMinRub ?? base.priceMinRub,
    priceMaxRub: args.priceMaxRub ?? base.priceMaxRub,
    maxWeightKg: args.maxWeightKg ?? base.maxWeightKg,
    maxLongEdgeCm: args.maxLongEdgeCm ?? base.maxLongEdgeCm,
    category: args.category,
    targetUsers: args.targetUsers,
    productGoal: args.productGoal,
  };
}





function parseLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("high") || normalized.includes("高")) return "high";
  if (normalized.includes("medium") || normalized.includes("mid") || normalized.includes("中")) {
    return "medium";
  }
  if (normalized.includes("low") || normalized.includes("低")) return "low";
  if (normalized.includes("stable") || normalized.includes("常青") || normalized.includes("稳定")) {
    return "stable";
  }
  if (normalized.includes("season")) return "seasonal";
  return normalized;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value) {
  if (typeof value === "number") return value;
  const normalized = String(value ?? "")
    .replace(/[,\s]/g, "")
    .replace(/[^\d.-]/g, "");
  const result = Number(normalized);
  return Number.isFinite(result) ? result : 0;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[|;,，；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProduct(row) {
  return {
    name: String(row.name || row.product_name || "").trim(),
    category: String(row.category || "").trim(),
    target_price_rub: toNumber(row.target_price_rub ?? row.price_rub ?? row.sell_price_rub),
    supply_price_cny: toNumber(row.supply_price_cny ?? row.cost_cny ?? row.purchase_price_cny),
    est_weight_kg: toNumber(row.est_weight_kg ?? row.weight_kg),
    package_long_edge_cm: toNumber(row.package_long_edge_cm ?? row.long_edge_cm),
    fragility: parseLevel(row.fragility),
    certification_risk: parseLevel(row.certification_risk ?? row.compliance_risk),
    return_risk: parseLevel(row.return_risk),
    competition_level: parseLevel(row.competition_level ?? row.competition),
    content_potential: parseLevel(row.content_potential),
    seasonality: parseLevel(row.seasonality),
    search_trend: parseLevel(row.search_trend),
    why_it_can_sell: String(row.why_it_can_sell || row.reason || "").trim(),
    risk_notes: splitList(row.risk_notes),
    source: String(row.source || "").trim(),
    source_url: String(row.source_url || "").trim(),
  };
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV input must contain a header row and at least one data row.");
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

async function loadCandidates(inputPath) {
  const raw = await fs.readFile(inputPath, "utf8");
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === ".json") {
    const parsed = JSON.parse(raw);
    const products = Array.isArray(parsed) ? parsed : parsed.products;
    if (!Array.isArray(products)) {
      throw new Error("JSON input must be an array or an object with a products array.");
    }
    return {
      raw,
      selectionBrief: parsed.selection_brief || null,
      recommendedActions: Array.isArray(parsed.recommended_actions)
        ? parsed.recommended_actions
        : [],
      products: products.map(normalizeProduct),
    };
  }

  if (ext === ".csv") {
    return {
      raw,
      selectionBrief: null,
      recommendedActions: [],
      products: parseCsv(raw).map(normalizeProduct),
    };
  }

  throw new Error(`Unsupported input type: ${ext || "unknown"}. Use .json or .csv.`);
}

function scorePrice(product, rules) {
  const price = Number(product.target_price_rub || 0);
  if (!price) return 45;
  if (price >= rules.priceMinRub && price <= rules.priceMaxRub) return 100;

  const distance =
    price < rules.priceMinRub
      ? (rules.priceMinRub - price) / Math.max(rules.priceMinRub, 1)
      : (price - rules.priceMaxRub) / Math.max(rules.priceMaxRub, 1);

  return clamp(Math.round(100 - distance * 140), 15, 95);
}

function scoreMargin(product, rules) {
  const targetPrice = Number(product.target_price_rub || 0);
  const supplyPriceCny = Number(product.supply_price_cny || 0);
  if (!targetPrice || !supplyPriceCny) return 55;

  const convertedSupplyRub = supplyPriceCny * rules.exchangeRateRubPerCny;
  const roughMarginRate = (targetPrice - convertedSupplyRub) / targetPrice;

  if (roughMarginRate >= 0.65) return 95;
  if (roughMarginRate >= 0.5) return 85;
  if (roughMarginRate >= 0.35) return 70;
  if (roughMarginRate >= 0.2) return 50;
  return 20;
}

function scoreLogistics(product, rules) {
  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  const fragility = parseLevel(product.fragility);
  let score = 100;

  if (weight > rules.maxWeightKg) {
    score -= Math.min(50, Math.round(((weight - rules.maxWeightKg) / rules.maxWeightKg) * 45));
  }
  if (longEdge > rules.maxLongEdgeCm) {
    score -= Math.min(35, Math.round(((longEdge - rules.maxLongEdgeCm) / rules.maxLongEdgeCm) * 30));
  }
  if (fragility === "medium") score -= 18;
  if (fragility === "high") score -= 40;

  return clamp(score, 5, 100);
}

function scoreRisk(product, field) {
  const level = parseLevel(product[field]);
  if (level === "low") return 95;
  if (level === "medium") return 60;
  if (level === "high") return 20;
  return 55;
}

function scoreCompetition(product) {
  const level = parseLevel(product.competition_level);
  if (level === "low") return 92;
  if (level === "medium") return 60;
  if (level === "high") return 22;
  return 55;
}

function scoreContent(product) {
  const level = parseLevel(product.content_potential);
  if (level === "high") return 90;
  if (level === "medium") return 65;
  if (level === "low") return 40;
  return 55;
}

function scoreSearchTrend(product) {
  const level = parseLevel(product.search_trend);
  if (level === "high") return 88;
  if (level === "medium" || level === "stable") return 65;
  if (level === "low") return 40;
  return 55;
}

function deriveDecision(totalScore, product) {
  const fragile = parseLevel(product.fragility) === "high";
  const cert = parseLevel(product.certification_risk) === "high";
  const returns = parseLevel(product.return_risk) === "high";

  if (cert || (fragile && returns) || totalScore < 45) return "No-Go";
  if (totalScore >= 72) return "Go";
  return "Watch";
}

function analyzeProducts(products, rules) {
  return products.map((product) => {
    const scoreBreakdown = {
      price_fit: scorePrice(product, rules),
      margin_potential: scoreMargin(product, rules),
      logistics_friendliness: scoreLogistics(product, rules),
      competition: scoreCompetition(product),
      compliance_risk: scoreRisk(product, "certification_risk"),
      return_risk: scoreRisk(product, "return_risk"),
      content_potential: scoreContent(product),
      search_trend: scoreSearchTrend(product),
    };

    const totalScore = Math.round(
      (scoreBreakdown.logistics_friendliness * rules.logisticsWeight +
        scoreBreakdown.margin_potential * rules.marginWeight +
        scoreBreakdown.competition * rules.competitionWeight +
        scoreBreakdown.compliance_risk * rules.complianceWeight +
        scoreBreakdown.return_risk * rules.returnWeight +
        scoreBreakdown.content_potential * rules.contentWeight +
        scoreBreakdown.search_trend * 10) /
        (rules.logisticsWeight +
          rules.marginWeight +
          rules.competitionWeight +
          rules.complianceWeight +
          rules.returnWeight +
          rules.contentWeight +
          10),
    );

    const issueSummary = [];
    if (scoreBreakdown.logistics_friendliness < 60) issueSummary.push("物流履约压力偏高");
    if (scoreBreakdown.margin_potential < 60) issueSummary.push("利润空间偏弱");
    if (scoreBreakdown.competition < 45) issueSummary.push("竞争过于拥挤");
    if (scoreBreakdown.compliance_risk < 45) issueSummary.push("认证或清关风险高");
    if (scoreBreakdown.return_risk < 45) issueSummary.push("退款或售后压力大");
    if (scoreBreakdown.search_trend < 50) issueSummary.push("需求趋势偏弱");

    return {
      ...product,
      score_breakdown: scoreBreakdown,
      total_score: totalScore,
      final_decision: deriveDecision(totalScore, product),
      issue_summary: issueSummary,
    };
  });
}

function buildRecommendedActions(products) {
  const goProducts = products.filter((item) => item.final_decision === "Go");
  const watchProducts = products.filter((item) => item.final_decision === "Watch");

  const actions = [];
  if (goProducts.length > 0) {
    actions.push(`优先把 ${goProducts.slice(0, 3).map((item) => item.name).join("、")} 做成首批测款清单。`);
  }
  if (watchProducts.length > 0) {
    actions.push(`对 ${watchProducts.slice(0, 3).map((item) => item.name).join("、")} 重点复核物流体积和合规要求。`);
  }
  actions.push("首批测款建议控制在 10-20 个 SKU，先看点击率、转化率、退款率和广告成本。");
  return actions;
}

function buildSelectionBrief(rules) {
  return {
    platform: "Ozon",
    price_band_rub: `${rules.priceMinRub}-${rules.priceMaxRub}`,
    core_strategy: [
      "优先轻小件、标准化、低售后产品。",
      "优先俄语卖点容易本地化、图片表达简单的品类。",
      "先保履约和利润，再谈爆款扩量。",
    ],
    warnings: [
      "避免强认证、易碎大件、复杂电子品、尺码问题重的产品。",
      "如果价格低于目标带但毛利不足，不要因为看起来好卖就强上。",
    ],
  };
}

function buildMarkdownReport(args, rules, enrichedResult) {
  const products = [...enrichedResult.products].sort((a, b) => b.total_score - a.total_score);
  const goProducts = products.filter((item) => item.final_decision === "Go");
  const watchProducts = products.filter((item) => item.final_decision === "Watch");
  const noGoProducts = products.filter((item) => item.final_decision === "No-Go");

  const lines = [
    "# Ozon Candidate Report",
    "",
    "## Task",
    "",
    `- Marketplace: ${rules.marketplace}`,
    `- Goal: ${args.productGoal}`,
    `- Price band: ${rules.priceMinRub}-${rules.priceMaxRub} RUB`,
    `- Max weight: ${rules.maxWeightKg} kg`,
    `- Max long edge: ${rules.maxLongEdgeCm} cm`,
    `- Category focus: ${rules.category || "not specified"}`,
    `- Target users: ${rules.targetUsers || "not specified"}`,
    "",
    "## Summary",
    "",
    `- Go: ${goProducts.length}`,
    `- Watch: ${watchProducts.length}`,
    `- No-Go: ${noGoProducts.length}`,
    "",
  ];

  if (enrichedResult.selection_brief) {
    lines.push("## Strategy", "");
    for (const item of enrichedResult.selection_brief.core_strategy || []) lines.push(`- ${item}`);
    if ((enrichedResult.selection_brief.warnings || []).length > 0) {
      lines.push("", "## Warnings", "");
      for (const item of enrichedResult.selection_brief.warnings) lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push("## Products", "");
  for (const product of products) {
    lines.push(`### ${product.name || "Unnamed product"}`);
    lines.push("");
    lines.push(`- Decision: ${product.final_decision}`);
    lines.push(`- Total score: ${product.total_score}`);
    lines.push(`- Category: ${product.category || "n/a"}`);
    lines.push(`- Target price: ${product.target_price_rub || "n/a"} RUB`);
    lines.push(`- Supply price: ${product.supply_price_cny || "n/a"} CNY`);
    lines.push(`- Weight: ${product.est_weight_kg || "n/a"} kg`);
    lines.push(`- Long edge: ${product.package_long_edge_cm || "n/a"} cm`);
    lines.push(`- Fragility: ${product.fragility || "n/a"}`);
    lines.push(`- Certification risk: ${product.certification_risk || "n/a"}`);
    lines.push(`- Return risk: ${product.return_risk || "n/a"}`);
    lines.push(`- Competition: ${product.competition_level || "n/a"}`);
    lines.push(`- Content potential: ${product.content_potential || "n/a"}`);
    lines.push(`- Search trend: ${product.search_trend || "n/a"}`);
    lines.push(`- Why it can sell: ${product.why_it_can_sell || "n/a"}`);
    if (product.issue_summary.length > 0) {
      lines.push(`- Main issues: ${product.issue_summary.join("; ")}`);
    }
    if (product.risk_notes.length > 0) {
      lines.push(`- Risk notes: ${product.risk_notes.join("; ")}`);
    }
    if (product.source || product.source_url) {
      lines.push(`- Source: ${[product.source, product.source_url].filter(Boolean).join(" / ")}`);
    }
    lines.push(
      `- Score breakdown: price ${product.score_breakdown.price_fit}, margin ${product.score_breakdown.margin_potential}, logistics ${product.score_breakdown.logistics_friendliness}, competition ${product.score_breakdown.competition}, compliance ${product.score_breakdown.compliance_risk}, return ${product.score_breakdown.return_risk}, content ${product.score_breakdown.content_potential}, trend ${product.score_breakdown.search_trend}`,
    );
    lines.push("");
  }

  lines.push("## Recommended Actions", "");
  for (const item of enrichedResult.recommended_actions) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function saveArtifacts(outputDir, basename, manifest, enrichedResult, report, sourceText) {
  const basePath = path.join(outputDir, basename);
  await fs.writeFile(`${basePath}.json`, JSON.stringify(manifest, null, 2), "utf8");
  await fs.writeFile(`${basePath}.analysis.json`, JSON.stringify(enrichedResult, null, 2), "utf8");
  await fs.writeFile(`${basePath}.report.md`, report, "utf8");
  await fs.writeFile(`${basePath}.input.txt`, sourceText, "utf8");
  return `${basePath}.analysis.json`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = getRules(args);

  await ensureDir(args.outputDir);

  const loaded = await loadCandidates(args.input);
  const enrichedProducts = analyzeProducts(loaded.products, rules);

  const enrichedResult = {
    selection_brief: loaded.selectionBrief || buildSelectionBrief(rules),
    products: enrichedProducts,
    recommended_actions:
      loaded.recommendedActions.length > 0
        ? loaded.recommendedActions
        : buildRecommendedActions(enrichedProducts),
    ozon_operating_rules: {
      marketplace: rules.marketplace,
      price_band_rub: `${rules.priceMinRub}-${rules.priceMaxRub}`,
      max_weight_kg: rules.maxWeightKg,
      max_long_edge_cm: rules.maxLongEdgeCm,
    },
  };

  const basename = `ozon-evaluator-${timestamp()}`;
  const report = buildMarkdownReport(args, rules, enrichedResult);
  const manifest = {
    startedAt: new Date().toISOString(),
    platform: args.platform,
    input: args.input,
    outputDir: args.outputDir,
    productCount: enrichedProducts.length,
    goCount: enrichedProducts.filter((item) => item.final_decision === "Go").length,
    watchCount: enrichedProducts.filter((item) => item.final_decision === "Watch").length,
    noGoCount: enrichedProducts.filter((item) => item.final_decision === "No-Go").length,
  };

  const savedPath = await saveArtifacts(
    args.outputDir,
    basename,
    manifest,
    enrichedResult,
    report,
    loaded.raw,
  );

  console.log(`Saved analysis: ${savedPath}`);
  console.log(`Processed products: ${enrichedProducts.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
