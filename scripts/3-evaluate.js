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

const BIZ = JSON.parse(fs.readFileSync ? await fs.readFile(path.resolve("config", "business-rules.json"), "utf8") : "{}");
const s = BIZ.scoring || {};
const w = s.weights || {};
const RULES = {
  priceMinRub: s.price_min_rub || 300,
  priceMaxRub: s.price_max_rub || 5000,
  maxWeightKg: s.max_weight_kg || 1.2,
  maxLongEdgeCm: s.max_long_edge_cm || 45,
  exchangeRateRubPerCny: BIZ.pricing?.exchange_rate_rub_per_cny || 12.5,
  w_logistics: w.logistics || 20,
  w_margin: w.margin || 25,
  w_competition: w.competition || 15,
  w_compliance: w.compliance || 15,
  w_return: w.return_risk || 15,
  w_content: w.content || 10,
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

// 从知识库product.json提取评分所需的扁平化数据
function flattenProduct(product) {
  // 如果已经是扁平的种子格式，直接返回
  if (product.target_price_rub || product.supply_price_cny) return product;

  // 从candidates提取真实采集数据
  // 找第一个标题有效的candidate（过滤掉抓到首页/登录页的脏数据）
  const junkTitle = /阿里1688|1688首页|登录|密码|公司|有限|商行|经营部|厂$/;
  const best = product.candidates?.find(c => c.title && !junkTitle.test(c.title)) || product.candidates?.[0];
  if (!best) return product.seed || product;

  // 从1688价格提取供应价（取最低数字价格）
  const priceNums = (best.prices || [])
    .map(p => parseFloat(String(p).replace(/[¥￥,]/g, "")))
    .filter(n => n > 0 && n < 9999);
  // 取中位数（最低价通常是大批量价，不代表真实采购成本）
  const sorted = priceNums.sort((a, b) => a - b);
  const supplyCny = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  // 从属性提取重量
  const attrs = best.attributes || {};
  const rawAttrs = best.raw_attributes || [];
  const weightAttr = rawAttrs.find(a => /重量|weight/i.test(a.key));
  const weightKg = weightAttr ? parseFloat(weightAttr.value) || 0.3 : 0.3;

  // 估算Ozon售价 (供应价 * 汇率 * 8倍加价: 含运费、关税、Ozon佣金、利润)
  const markupForEstimate = s.markup_for_rub_estimate || 8;
  const targetRub = supplyCny ? Math.round(supplyCny * RULES.exchangeRateRubPerCny * markupForEstimate) : 0;

  // 判断是否易碎/认证风险
  const category = product.seed?.category || "";
  const isCrossBorder = rawAttrs.some(a => /跨境|出口/i.test(a.value));
  const hasImages = (best.images?.length || 0) >= 3;

  return {
    name: best.title || product.keyword || product.seed?.keyword || "",
    keyword: product.keyword || product.seed?.keyword || "",
    target_price_rub: targetRub,
    supply_price_cny: supplyCny,
    est_weight_kg: weightKg,
    package_long_edge_cm: 0,
    competition_level: "medium",
    certification_risk: /电子|电池|食品|化妆|药|toy/i.test(category) ? "high" : "low",
    return_risk: /服装|鞋|衣/i.test(category) ? "high" : "low",
    content_potential: hasImages ? "high" : "medium",
    fragility: /玻璃|陶瓷|ceramic|glass/i.test(category) ? "high" : "low",
    _is_cross_border: isCrossBorder,
    _candidate_count: product.candidates?.length || 0,
    _image_count: best.images?.length || 0,
  };
}

function evaluate(rawProduct) {
  const product = flattenProduct(rawProduct);
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
    // 扫描知识库，传入完整product数据（含candidates）
    const productsDir = path.join(KB_ROOT, "products");
    const dirs = await fs.readdir(productsDir).catch(() => []);
    for (const dir of dirs) {
      const pj = await readJson(path.join(productsDir, dir, "product.json"), null);
      if (pj?.candidates?.length) products.push(pj); // 只评有采集数据的产品
    }
  } else if (args.input) {
    const data = await readJson(path.resolve(args.input));
    products = data?.products || data?.seeds || (Array.isArray(data) ? data : []);
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

  // 在 --kb 模式下，给 No-Go 产品写 _skip 标记，Go/Watch 的清除标记
  if (args.kb) {
    const productsDir = path.join(KB_ROOT, "products");
    for (const r of results) {
      const slug = r.raw?.spu_id || r.raw?.slug;
      if (!slug) continue;
      const pPath = path.join(productsDir, slug, "product.json");
      try {
        const pj = await readJson(pPath, null);
        if (!pj) continue;
        if (r.decision === "No-Go") {
          pj._skip = true;
          pj._score = r.score;
        } else {
          delete pj._skip;
          pj._score = r.score;
          pj._decision = r.decision;
        }
        await writeJson(pPath, pj);
      } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 60)); }
    }
    console.log(`  已标记: ${results.filter(r => r.decision === "No-Go").length} 个 No-Go 跳过后续阶段`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
