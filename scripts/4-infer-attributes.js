#!/usr/bin/env node
/**
 * Stage 4: AI 属性推理
 * 读取知识库中的中文商品数据，用 LLM 推理出 Ozon 所需的俄文属性
 *
 * 用法: node scripts/4-infer-attributes.js [--slug <product-slug>] [--all]
 */
import path from "node:path";
import fs from "node:fs/promises";
import { parseCliArgs, readJson, writeJson, KB_ROOT } from "./lib/shared.js";
import { llmJson } from "./lib/llm.js";

const OZON_SCHEMA_PROMPT = `你是一个 Ozon 俄罗斯站上架专家。根据以下中文商品数据，推理生成 Ozon 上架所需的完整属性。

要求：
1. 所有面向消费者的文本(标题/描述/卖点)必须是俄语
2. 标题格式: 品类名 + 核心卖点 + 关键规格 (60-150字符)
3. 描述: 2-3段俄语，突出使用场景和优势
4. 卖点: 5个bullet points，每个30-80字符
5. 属性尽量完整，缺失的合理推理

输出严格 JSON 格式:
{
  "title_ru": "俄语标题",
  "title_en": "英文标题(备用)",
  "description_ru": "俄语描述",
  "bullet_points_ru": ["卖点1", "卖点2", "卖点3", "卖点4", "卖点5"],
  "ozon_category_suggestion": "Ozon seller后台的商品类型名称（必须是真实存在的Ozon type_name，如：Защита колена, Галстук, Повязка на голову, Брюки, Совок для туалета, Губка, Когтеточка, Степлер, Наколенники строительные, Автомобильное зарядное устройство, Ролик для чистки одежды, Сумка через плечо, Крючок для дома）",
  "ozon_type_name": "上面ozon_category_suggestion中最后一级的精确类型名（单个词组）",
  "attributes": {
    "brand": "",
    "model": "",
    "color": "",
    "material": "",
    "size": "",
    "weight_kg": 0,
    "country_of_origin": "CN",
    "vendor_code": "",
    "barcode": ""
  },
  "compliance": {
    "is_adult": false,
    "is_fragile": false,
    "dangerous_goods": false,
    "certificate_required": false,
    "restricted_category": false
  },
  "seo_keywords_ru": ["关键词1", "关键词2", "关键词3"],
  "confidence": 0.0
}`;

function buildProductContext(product) {
  const parts = [`商品关键词: ${product.keyword || product.seed?.name || ""}`];

  // 从1688数据中提取
  if (product.candidates?.length) {
    const best = product.candidates[0];
    parts.push(`1688标题: ${best.title || ""}`);
    parts.push(`1688价格: ${best.prices?.join(", ") || best.search_price || ""}`);
    if (best.attributes && typeof best.attributes === "object") {
      parts.push(`属性: ${JSON.stringify(best.attributes)}`);
    }
    if (best.images?.length) {
      parts.push(`图片数: ${best.images.length}`);
    }
  }

  // 从拼多多数据中补充
  if (product.pdd?.candidates?.length) {
    const pdd = product.pdd.candidates[0];
    parts.push(`拼多多标题: ${pdd.title || ""}`);
    parts.push(`拼多多价格: ${pdd.price || ""}`);
    parts.push(`拼多多销量: ${pdd.sales || ""}`);
    if (pdd.attributes && typeof pdd.attributes === "object") {
      parts.push(`拼多多属性: ${JSON.stringify(pdd.attributes)}`);
    }
    if (pdd.variants?.length) {
      parts.push(`变体: ${JSON.stringify(pdd.variants)}`);
    }
  }

  // 种子数据
  if (product.seed) {
    parts.push(`品类: ${product.seed.category || ""}`);
    parts.push(`目标用户: ${product.seed.target_users || ""}`);
    parts.push(`卖点: ${product.seed.why_it_can_sell || ""}`);
    parts.push(`目标售价(RUB): ${product.seed.target_price_rub || ""}`);
    parts.push(`预估重量(kg): ${product.seed.est_weight_kg || ""}`);
  }

  return parts.filter(Boolean).join("\n");
}

async function inferAttributes(product) {
  const context = buildProductContext(product);
  const prompt = `${OZON_SCHEMA_PROMPT}\n\n--- 商品数据 ---\n${context}\n\n请基于以上数据推理 Ozon 上架属性，只输出 JSON:`;

  return llmJson(prompt, {
    system: "你是 Ozon 俄罗斯站的上架运营专家，精通俄语和跨境电商。基于中文供应链数据推理出完整的俄文上架信息。只输出 JSON。",
    maxTokens: 4096,
  });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), { slug: "", all: false });

  const productsDir = path.join(KB_ROOT, "products");
  let slugs = [];

  if (args.all) {
    slugs = await fs.readdir(productsDir).catch(() => []);
  } else if (args.slug) {
    slugs = [args.slug];
  } else {
    // 默认处理所有还没推理过的
    const all = await fs.readdir(productsDir).catch(() => []);
    for (const s of all) {
      const inferred = await readJson(path.join(productsDir, s, "inferred.json"), null);
      if (!inferred) slugs.push(s);
    }
  }

  console.log(`[Stage 4] AI属性推理: ${slugs.length} 个商品`);

  // 过滤出需要推理的产品
  const tasks = [];
  for (const s of slugs) {
    const productPath = path.join(productsDir, s, "product.json");
    const product = await readJson(productPath, null);
    if (!product) continue;
    if (!product.candidates?.length) continue;
    if (product._skip) continue; // 评分 No-Go 的跳过
    if (!args.all) {
      const existing = await readJson(path.join(productsDir, s, "inferred.json"), null);
      if (existing) continue;
    }
    tasks.push({ slug: s, product });
  }

  console.log(`[Stage 4] AI属性推理: ${tasks.length} 个商品 (并发3路)`);

  // 并发执行，最多3路同时
  const CONCURRENCY = 3;
  let success = 0;
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      const { slug, product } = tasks[i];
      const label = `  [${i + 1}/${tasks.length}] ${slug}`;
      try {
        const inferred = await Promise.race([
          inferAttributes(product),
          new Promise((_, reject) => setTimeout(() => reject(new Error("超时(90s)")), 90_000)),
        ]);
        await writeJson(path.join(productsDir, slug, "inferred.json"), {
          ...inferred,
          inferred_at: new Date().toISOString(),
          source_slug: slug,
        });
        console.log(`${label} ✓ ${inferred.title_ru?.slice(0, 50) || "(无标题)"}`);
        success++;
      } catch (err) {
        console.error(`${label} ✗ ${err.message?.slice(0, 60)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));

  console.log(`\n[Stage 4] 完成: ${success}/${tasks.length} 成功`);
}

main().catch(err => { console.error(err); process.exit(1); });
