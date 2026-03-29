#!/usr/bin/env node
/**
 * Stage 5: Ozon 上架草稿生成
 * 输出格式: ozon-kb-v2-direct-listing (对齐 ITEM-aircup-demo 范例)
 *
 * 合并: product.json(采集) + inferred.json(AI推理) + evaluate结果
 * 输出: listing.json — 包含 ozon_api_ready 载荷，可直接喂 Ozon Seller API
 *
 * 用法: node scripts/5-draft-listing.js [--slug <slug>] [--all]
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { parseCliArgs, readJson, writeJson, normalize, parseNumber, KB_ROOT, OUTPUT_ROOT, timestamp } from "./lib/shared.js";

function pickImages(product) {
  const imgs1688 = product.candidates?.[0]?.images || [];
  const imgsPdd = product.pdd?.candidates?.[0]?.images || [];
  return [...new Set([...imgs1688, ...imgsPdd])].filter(Boolean).slice(0, 10);
}

function imageHash(images) {
  return crypto.createHash("sha1").update(images.join("|")).digest("hex");
}

function buildCompetitorOffers(product) {
  const offers = [];
  // 1688 候选 (排名2+的作为竞品)
  for (const c of (product.candidates || []).slice(1)) {
    offers.push({
      source_platform: "1688",
      source_url: c.source_url || "",
      offer_title: c.title || "",
      shop_name: c.shop_name || "",
      shop_url: "",
      price: parseNumber(String(c.prices?.[0] || "").replace(/[^\d.]/g, "")),
      price_text: c.prices?.[0] || "",
      currency: "CNY",
      min_order_qty: 1,
      main_image: c.main_image || "",
      images: c.images || [],
      image_count: (c.images || []).length,
      category_path: "",
      normalizedAttributes: c.attributes || {},
      weight_kg: 0,
      page_type: "detail",
    });
  }
  // 拼多多候选
  for (const c of (product.pdd?.candidates || []).slice(1)) {
    offers.push({
      source_platform: "pdd",
      source_url: c.source_url || "",
      offer_title: c.title || "",
      shop_name: c.shop_name || "",
      shop_url: "",
      price: parseNumber(String(c.price || "").replace(/[^\d.]/g, "")),
      price_text: c.price || "",
      currency: "CNY",
      min_order_qty: 1,
      main_image: c.main_image || "",
      images: c.images || [],
      image_count: (c.images || []).length,
      category_path: "",
      normalizedAttributes: c.attributes || {},
      weight_kg: 0,
      page_type: "detail",
    });
  }
  return offers;
}

function buildComparisonSummary(competitors) {
  const prices = competitors.map(c => c.price).filter(p => p > 0);
  return {
    compared_at: new Date().toISOString(),
    candidate_count: competitors.length,
    price_min: prices.length ? Math.min(...prices) : 0,
    price_max: prices.length ? Math.max(...prices) : 0,
    price_avg: prices.length ? Number((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)) : 0,
    notes: [],
  };
}

function buildListing(product, inferred) {
  const seed = product.seed || {};
  const best1688 = product.candidates?.[0] || {};
  const bestPdd = product.pdd?.candidates?.[0] || {};
  const images = pickImages(product);
  const attrs = inferred.attributes || {};
  const compliance = inferred.compliance || {};
  const competitors = buildCompetitorOffers(product);
  const comparison = buildComparisonSummary(competitors);

  const spuId = product.spu_id || product.keyword || "";
  const vendorCode = attrs.vendor_code || best1688.attributes?.vendor_code || spuId;
  const weightKg = parseNumber(attrs.weight_kg || seed.est_weight_kg);
  const lengthCm = parseNumber(attrs.length || seed.package_long_edge_cm);
  const widthCm = parseNumber(attrs.width || 0);
  const heightCm = parseNumber(attrs.height || 0);
  const priceRub = parseNumber(seed.target_price_rub);
  const oldPriceRub = priceRub ? Math.round(priceRub * 1.32) : 0;
  const titleRu = inferred.title_ru || "";
  const descRu = inferred.description_ru || "";
  const bulletsRu = inferred.bullet_points_ru || [];

  return {
    // ─── 元数据 ───
    schema_version: "ozon-kb-v2-direct-listing",
    generated_at: new Date().toISOString(),

    // ─── 来源追溯 ───
    source_platform: product.source_platform || "1688+pdd",
    source_url: best1688.source_url || bestPdd.source_url || "",
    source_platform_urls: [
      best1688.source_url, bestPdd.source_url,
    ].filter(Boolean),

    // ─── 基础识别 ───
    spu_id: spuId,
    sku_id: `${spuId}-001`,
    group_id: spuId,
    variant_theme: "",
    variant_values: {},
    brand: attrs.brand || best1688.attributes?.brand || "",
    model: attrs.model || "",
    vendor_code: vendorCode,
    barcode: attrs.barcode || "",

    // ─── 多语言内容 ───
    title_cn: best1688.title || bestPdd.title || seed.name || "",
    title_en: inferred.title_en || "",
    title_ru: titleRu,
    description: seed.why_it_can_sell || "",
    bullet_points: bulletsRu,

    // ─── 销售信息 ───
    price: priceRub,
    old_price: oldPriceRub,
    currency: "RUB",
    stock: 0,
    min_order_qty: 1,
    package_quantity: 1,
    vat: "0",

    // ─── 物流尺寸 ───
    weight: weightKg,
    length: lengthCm,
    width: widthCm,
    height: heightCm,

    // ─── 类目 ───
    category_path: seed.category || "",
    category_id_source: "ai-inferred",
    ozon_category_id: null,
    ozon_type_id: null,

    // ─── 属性 ───
    attributes: {
      source_category: seed.category || "",
      seasonality: seed.seasonality || "stable",
      fragility: seed.fragility || "low",
      competition_level: seed.competition_level || "medium",
      content_potential: seed.content_potential || "medium",
      material: attrs.material || best1688.attributes?.material || "",
      color: attrs.color || best1688.attributes?.color || "",
      size: attrs.size || best1688.attributes?.size || "",
      power_supply: attrs.power_supply || "",
      country_of_origin: attrs.country_of_origin || "CN",
    },

    // ─── 媒体 ───
    main_image: images[0] || "",
    images,
    video_url: "",
    image_count: images.length,
    image_hash: images.length ? imageHash(images) : "",
    white_background: false,

    // ─── 合规 ───
    is_adult: compliance.is_adult || false,
    is_fragile: compliance.is_fragile || false,
    dangerous_goods: compliance.dangerous_goods || false,
    country_of_origin: attrs.country_of_origin || "CN",
    certificate_files: [],
    brand_authorization: "",
    customs_code: "",
    restricted_category_flag: compliance.restricted_category || false,

    // ─── 供应商 ───
    supplier: {
      name: best1688.shop_name || bestPdd.shop_name || "",
      platform: product.source_platform || "1688",
      shop_url: "",
      contact: "",
    },

    // ─── 竞品对比 ───
    competitor_offers: competitors,
    comparison_summary: comparison,

    // ─── 数据质量追踪 ───
    data_quality: {
      title_source: best1688.title ? "1688-scraped" : bestPdd.title ? "pdd-scraped" : "seed",
      description_source: "ai-inferred",
      web_detail_valid: !!(best1688.source_url || bestPdd.source_url),
      inferred_fields: Object.keys(attrs).filter(k => attrs[k]),
    },

    // ─── 评分分析 ───
    analysis: {
      product_profile: seed.category || "",
      fragility: seed.fragility || "low",
      certification_risk: seed.certification_risk || "low",
      return_risk: seed.return_risk || "low",
      competition_level: seed.competition_level || "medium",
      content_potential: seed.content_potential || "medium",
      seasonality: seed.seasonality || "stable",
      target_price_rub: priceRub,
      supply_price_cny: parseNumber(seed.supply_price_cny),
      total_score: 0, // 由 evaluate 阶段填入
      final_decision: seed.go_or_no_go || "Review",
    },

    // ─── Ozon API 就绪载荷 ───
    ozon_api_ready: {
      ready_for_product_import: !!(titleRu && images.length),
      ready_for_price_import: priceRub > 0,
      ready_for_stock_import: false,
      offer_id: vendorCode,
      category_id: null,
      type_id: null,
      warehouse_id: null,
      currency_code: "RUB",
      dimensions: {
        weight_g: Math.round(weightKg * 1000),
        depth_mm: Math.round(lengthCm * 10),
        width_mm: Math.round(widthCm * 10),
        height_mm: Math.round(heightCm * 10),
      },
      price_payload: {
        price: String(priceRub),
        old_price: String(oldPriceRub),
        min_price: String(Math.round(priceRub * 0.92)),
        currency_code: "RUB",
      },
      stock_payload: {
        warehouse_id: null,
        offer_id: vendorCode,
        stock: 0,
      },
      product_import_payload_template: {
        offer_id: vendorCode,
        name: titleRu,
        description: descRu,
        barcode: attrs.barcode || "",
        category_id: null,
        type_id: null,
        price: String(priceRub),
        old_price: String(oldPriceRub),
        currency_code: "RUB",
        primary_image: images[0] || "",
        images,
        dimensions: {
          weight_g: Math.round(weightKg * 1000),
          depth_mm: Math.round(lengthCm * 10),
          width_mm: Math.round(widthCm * 10),
          height_mm: Math.round(heightCm * 10),
        },
        attributes: [
          attrs.brand ? { attribute_name: "Brand", attribute_id: 85, value_type: "string", value: attrs.brand } : null,
          attrs.material ? { attribute_name: "Material", attribute_id: 8229, value_type: "string", value: attrs.material } : null,
          attrs.color ? { attribute_name: "Color", attribute_id: 10096, value_type: "string", value: attrs.color } : null,
          attrs.power_supply ? { attribute_name: "Power supply", attribute_id: 9048, value_type: "string", value: attrs.power_supply } : null,
          { attribute_name: "Country of origin", attribute_id: 4383, value_type: "string", value: attrs.country_of_origin || "CN" },
        ].filter(Boolean),
      },
      listing_copy: {
        title_ru: titleRu,
        description_ru: descRu,
        bullet_points_ru: bulletsRu,
      },
    },

    // ─── SEO ───
    seo_keywords_ru: inferred.seo_keywords_ru || [],
  };
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
    const all = await fs.readdir(productsDir).catch(() => []);
    for (const s of all) {
      const hasInferred = await readJson(path.join(productsDir, s, "inferred.json"), null);
      const hasListing = await readJson(path.join(productsDir, s, "listing.json"), null);
      if (hasInferred && !hasListing) slugs.push(s);
    }
  }

  console.log(`[Stage 5] 生成上架草稿 (ozon-kb-v2): ${slugs.length} 个商品`);

  const listings = [];
  for (const s of slugs) {
    const product = await readJson(path.join(productsDir, s, "product.json"), null);
    const inferred = await readJson(path.join(productsDir, s, "inferred.json"), null);
    if (!product || !inferred) {
      console.log(`  跳过 ${s}: 缺少数据`);
      continue;
    }

    const listing = buildListing(product, inferred);
    await writeJson(path.join(productsDir, s, "listing.json"), listing);
    listings.push(listing);

    const readyFlags = [
      listing.ozon_api_ready.ready_for_product_import ? "商品✓" : "商品✗",
      listing.ozon_api_ready.ready_for_price_import ? "价格✓" : "价格✗",
      listing.ozon_api_ready.ready_for_stock_import ? "库存✗" : "库存✗",
    ].join(" ");
    console.log(`  ✓ ${s}: [${readyFlags}] ${listing.title_ru?.slice(0, 40) || listing.title_cn?.slice(0, 20)}`);
  }

  if (listings.length) {
    const batchPath = path.join(OUTPUT_ROOT, `listings-batch-${timestamp()}.json`);
    await writeJson(batchPath, { schema_version: "ozon-kb-v2-direct-listing", count: listings.length, listings });
    console.log(`\n[Stage 5] 完成: ${listings.length} 个草稿`);
    console.log(`  批量输出: ${batchPath}`);

    // 就绪统计
    const productReady = listings.filter(l => l.ozon_api_ready.ready_for_product_import).length;
    const priceReady = listings.filter(l => l.ozon_api_ready.ready_for_price_import).length;
    console.log(`  商品信息就绪: ${productReady}/${listings.length}`);
    console.log(`  价格信息就绪: ${priceReady}/${listings.length}`);
    console.log(`  需手动填入: category_id, type_id, warehouse_id, 真实图片链接`);
  } else {
    console.log("\n[Stage 5] 无可处理的商品");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
