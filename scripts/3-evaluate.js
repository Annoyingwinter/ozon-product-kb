#!/usr/bin/env node
/**
 * Stage 3: 评分筛选
 * 基于 Ozon 运营规则对采集到的商品评分排序
 * 从旧项目 ozon-evaluator.js 核心逻辑提炼
 *
 * 用法: node scripts/3-evaluate.js --input output/seeds-xxx.json
 * 或:   node scripts/3-evaluate.js --kb (扫描整个知识库)
 */
import path from "node:path";
import fs from "node:fs/promises";
import { parseCliArgs, readJson, writeJson, normalize, parseNumber, timestamp, KB_ROOT, OUTPUT_ROOT } from "./lib/shared.js";

const RULES = {
  priceMinRub: 1000,
  priceMaxRub: 4000,
  maxWeightKg: 1.2,
  maxLongEdgeCm: 45,
  exchangeRateRubPerCny: 12.5,
  // 权重 (总和100)
  w_logistics: 20,
  w_margin: 25,
  w_competition: 15,
  w_compliance: 15,
  w_return: 15,
  w_content: 10,
};

function parseLevel(v) {
  const s = String(v || "").toLowerCase();
  if (/high|高/.test(s)) return "high";
  if (/medium|mid|中/.test(s)) return "medium";
  if (/low|低/.test(s)) return "low";
  return "";
}

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function scorePrice(p) {
  const price = parseNumber(p.target_price_rub);
  if (!price) return 45;
  if (price >= RULES.priceMinRub && price <= RULES.priceMaxRub) return 100;
  const dist = price < RULES.priceMinRub
    ? (RULES.priceMinRub - price) / RULES.priceMinRub
    : (price - RULES.priceMaxRub) / RULES.priceMaxRub;
  return clamp(Math.round(100 - dist * 140), 15, 95);
}

function scoreMargin(p) {
  const target = parseNumber(p.target_price_rub);
  const supply = parseNumber(p.supply_price_cny);
  if (!target || !supply) return 55;
  const converted = supply * RULES.exchangeRateRubPerCny;
  const margin = (target - converted) / target;
  if (margin >= 0.65) return 95;
  if (margin >= 0.5) return 85;
  if (margin >= 0.35) return 70;
  if (margin >= 0.2) return 50;
  return 20;
}

function scoreLogistics(p) {
  const weight = parseNumber(p.est_weight_kg);
  const edge = parseNumber(p.package_long_edge_cm);
  const fragility = parseLevel(p.fragility);
  let s = 100;
  if (weight > RULES.maxWeightKg) s -= Math.min(50, Math.round(((weight - RULES.maxWeightKg) / RULES.maxWeightKg) * 45));
  if (edge > RULES.maxLongEdgeCm) s -= Math.min(35, Math.round(((edge - RULES.maxLongEdgeCm) / RULES.maxLongEdgeCm) * 30));
  if (fragility === "medium") s -= 18;
  if (fragility === "high") s -= 40;
  return clamp(s, 5, 100);
}

function scoreLevel(level) {
  if (level === "low") return 95;
  if (level === "medium") return 60;
  if (level === "high") return 20;
  return 55;
}

function evaluate(product) {
  const s_price = scorePrice(product);
  const s_margin = scoreMargin(product);
  const s_logistics = scoreLogistics(product);
  const s_competition = scoreLevel(parseLevel(product.competition_level));
  const s_compliance = scoreLevel(parseLevel(product.certification_risk));
  const s_return = scoreLevel(parseLevel(product.return_risk));
  const s_content = scoreLevel(parseLevel(product.content_potential) === "high" ? "low" : parseLevel(product.content_potential) === "low" ? "high" : "medium");

  const weighted = (
    s_logistics * RULES.w_logistics +
    s_margin * RULES.w_margin +
    s_competition * RULES.w_competition +
    s_compliance * RULES.w_compliance +
    s_return * RULES.w_return +
    s_content * RULES.w_content
  ) / 100;

  // 价格适配作为门槛调节
  const final = Math.round(weighted * (s_price / 100));
  const decision = final >= 70 ? "Go" : final >= 50 ? "Watch" : "No-Go";

  return {
    name: product.name || product.keyword || "",
    score: final,
    decision,
    breakdown: { s_price, s_margin, s_logistics, s_competition, s_compliance, s_return, s_content },
    raw: product,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), { input: "", kb: false });

  let products = [];
  if (args.kb) {
    // 扫描知识库
    const productsDir = path.join(KB_ROOT, "products");
    const dirs = await fs.readdir(productsDir).catch(() => []);
    for (const dir of dirs) {
      const pj = await readJson(path.join(productsDir, dir, "product.json"), null);
      if (pj?.seed) products.push(pj.seed);
    }
  } else if (args.input) {
    const data = await readJson(path.resolve(args.input));
    products = data?.products || data || [];
  } else {
    throw new Error("需要 --input <seeds.json> 或 --kb");
  }

  console.log(`[Stage 3] 评分: ${products.length} 个商品`);

  const results = products.map(evaluate);
  results.sort((a, b) => b.score - a.score);

  // 输出表格
  console.log("\n  排名  | 分数 | 决策    | 商品名");
  console.log("  ------|------|---------|-----");
  results.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(4)}  | ${String(r.score).padStart(4)} | ${r.decision.padEnd(7)} | ${r.name.slice(0, 30)}`);
  });

  const go = results.filter(r => r.decision === "Go");
  const watch = results.filter(r => r.decision === "Watch");
  console.log(`\n  Go: ${go.length}, Watch: ${watch.length}, No-Go: ${results.length - go.length - watch.length}`);

  const outputPath = path.join(OUTPUT_ROOT, `evaluate-${timestamp()}.json`);
  await writeJson(outputPath, {
    evaluated_at: new Date().toISOString(),
    summary: { total: results.length, go: go.length, watch: watch.length },
    results,
  });
  console.log(`  输出: ${outputPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
