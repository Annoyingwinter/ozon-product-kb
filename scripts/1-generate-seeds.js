#!/usr/bin/env node
/**
 * Stage 1: 种子商品生成
 * 用 LLM 替代 alphashop 网页聊天，纯 API 调用
 *
 * 用法: node scripts/1-generate-seeds.js [--category 家居] [--count 12]
 * 输出: output/seeds-<timestamp>.json
 */
import path from "node:path";
import { parseCliArgs, writeJson, timestamp, OUTPUT_ROOT } from "./lib/shared.js";
import { llmJson } from "./lib/llm.js";

const OZON_RULES = {
  marketplace: "Ozon Russia",
  priceMinRub: 1000,
  priceMaxRub: 4000,
  maxWeightKg: 1.2,
  maxLongEdgeCm: 45,
  exchangeRateRubPerCny: 12.5,
};

function buildPrompt(opts) {
  const category = opts.category || "家居、车品、收纳、宠物、小工具、季节型轻小件";
  const targetUsers = opts.targetUsers || "俄罗斯家庭用户、车主、宠物主人、礼品消费人群";
  const count = opts.count || 12;

  return [
    `你是${OZON_RULES.marketplace}的跨境选品运营，请严格按 Ozon 的经营逻辑进行筛选。`,
    `任务目标：筛选适合 Ozon 俄罗斯站的轻小件、高复购潜力、低售后、可跨境履约的商品。`,
    `重点类目：${category}`,
    `目标人群：${targetUsers}`,
    `硬性约束：售价区间 ${OZON_RULES.priceMinRub}-${OZON_RULES.priceMaxRub} RUB，单件重量 <= ${OZON_RULES.maxWeightKg} kg，最长边 <= ${OZON_RULES.maxLongEdgeCm} cm，低售后，低破损，低认证风险。`,
    "运营判断优先级：价格带适配 > 履约与物流友好 > 毛利空间 > 竞争度 > 退货风险 > 内容传播性。",
    "请优先选择：轻小件、标准化、非强品牌依赖、图片容易表达、俄语卖点容易本地化、适合平台推荐分发的商品。",
    "请谨慎或剔除：易碎大件、复杂电子类、强认证/清关风险、尺码复杂、高退货、高售后产品。",
    `请输出 ${count} 个候选商品。`,
    "必须只输出 JSON，不要 Markdown，不要解释。",
    `JSON 结构：
{
  "selection_brief": {
    "platform": "Ozon",
    "price_band_rub": "${OZON_RULES.priceMinRub}-${OZON_RULES.priceMaxRub}",
    "core_strategy": ["..."],
    "warnings": ["..."]
  },
  "products": [
    {
      "name": "中文商品名",
      "keyword": "1688/拼多多搜索关键词",
      "category": "品类",
      "target_users": "目标用户",
      "target_price_rub": 0,
      "supply_price_cny": 0,
      "est_weight_kg": 0,
      "package_long_edge_cm": 0,
      "fragility": "low|medium|high",
      "certification_risk": "low|medium|high",
      "return_risk": "low|medium|high",
      "competition_level": "low|medium|high",
      "content_potential": "low|medium|high",
      "seasonality": "stable|seasonal",
      "why_it_can_sell": "为什么能卖",
      "risk_notes": ["风险点"],
      "go_or_no_go": "Go|Watch|No-Go"
    }
  ],
  "recommended_actions": ["..."]
}`,
  ].join("\n");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    category: "",
    targetUsers: "",
    count: "12",
    dryRun: false,
  });

  console.log("[Stage 1] 生成种子商品列表...");
  const prompt = buildPrompt(args);

  if (args.dryRun) {
    console.log("[dry-run] Prompt length:", prompt.length, "chars");
    console.log(prompt.slice(0, 300) + "...");
    return;
  }

  const result = await llmJson(prompt, {
    system: "你是一个专业的 Ozon 俄罗斯站跨境电商选品顾问。基于你对中国供应链和俄罗斯消费市场的了解，给出真实可操作的选品建议。只输出 JSON。",
    maxTokens: 8192,
  });

  const outputPath = path.join(OUTPUT_ROOT, `seeds-${timestamp()}.json`);
  await writeJson(outputPath, result);

  const products = result.products || [];
  console.log(`[Stage 1] 完成: ${products.length} 个种子商品`);
  console.log(`  Go: ${products.filter(p => p.go_or_no_go === "Go").length}`);
  console.log(`  Watch: ${products.filter(p => p.go_or_no_go === "Watch").length}`);
  console.log(`  No-Go: ${products.filter(p => p.go_or_no_go === "No-Go").length}`);
  console.log(`  输出: ${outputPath}`);

  return result;
}

main().catch((err) => { console.error(err); process.exit(1); });
