import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";

// 从config加载，fallback到默认值
const CONFIG_PATH = path.resolve("config", "ozon-api.json");
let _cfg = {};
try { _cfg = JSON.parse(fss.readFileSync(CONFIG_PATH, "utf8")); } catch {}
const WAREHOUSE_ID = _cfg.warehouseId || 1020005009633310;
const CURRENCY = _cfg.currency || "CNY";
const NO_BRAND_ID = 126745801;
const INITIAL_STOCK = 100;
const KB = path.resolve("knowledge-base/products");

const CATEGORY_RULES = [
  { match: /авто|car|seat|trunk|车载|汽车|座椅|后备箱|缝隙/, catId: 82169566, typeId: 92186, typeName: "Сумка-органайзер автомобильная" },
  { match: /冰箱|保鲜|食品|kitchen|food|2800ml/, catId: 17027933, typeId: 970897618, typeName: "Коробка для продуктов" },
  { match: /粘毛|除毛|pet.*hair|lint|毛器|刮毛/, catId: 17027937, typeId: 970896147, typeName: "Органайзер для хранения вещей" },
  { match: /收纳|organiz|storage|хранен|分隔|wardrobe|抽屉/, catId: 17027937, typeId: 970896147, typeName: "Органайзер для хранения вещей" },
  { match: /垃圾袋/, catId: 82169566, typeId: 92186, typeName: "Сумка-органайзер автомобильная" },
];

function matchCat(text) {
  const low = (text || "").toLowerCase();
  for (const r of CATEGORY_RULES) if (r.match.test(low)) return r;
  return CATEGORY_RULES[3];
}

const RU = {
  "粘毛器": "Ролик для удаления шерсти с одежды и мебели",
  "滚筒粘毛器": "Ролик-липучка для чистки одежды от шерсти",
  "除毛器": "Щётка для удаления шерсти домашних животных",
  "刮毛器": "Скребок для удаления шерсти животных с мебели",
  "猫毛清理": "Щётка для удаления кошачьей шерсти",
  "后备箱": "Сетка-органайзер для багажника автомобиля",
  "网兜": "Сетка-органайзер для багажника автомобиля",
  "座椅缝隙": "Органайзер в щель автомобильного сиденья",
  "缝隙塞条": "Уплотнитель щели автомобильного сиденья",
  "保鲜盒": "Контейнер для хранения продуктов с крышкой",
  "收纳包": "Складная сумка-органайзер для багажника",
  "后备箱储物袋": "Сумка-органайзер в багажник автомобиля 600D",
  "抽屉分隔板": "Регулируемый разделитель для ящика",
  "车载垃圾袋": "Одноразовые мусорные пакеты для автомобиля",
  "封口机": "Портативный мини запайщик пакетов",
  "除霉": "Гель для удаления плесени",
  "汽车用品厂": "Многофункциональный автомобильный органайзер",
};

function toRu(name) {
  for (const [cn, ru] of Object.entries(RU)) {
    if ((name || "").includes(cn)) return ru;
  }
  return "";
}

function estimateDims(wg, longMm) {
  if (longMm > 0) return { d: longMm, w: Math.round(longMm * 0.55), h: Math.round(longMm * 0.25) };
  if (wg < 50) return { d: 200, w: 120, h: 50 };
  if (wg < 200) return { d: 250, w: 150, h: 80 };
  if (wg < 500) return { d: 300, w: 180, h: 100 };
  if (wg < 1000) return { d: 350, w: 220, h: 120 };
  return { d: 400, w: 280, h: 150 };
}

function cleanImgUrl(u) {
  if (!u || !/^https?:\/\//.test(u)) return "";
  return u.replace(/_\d+x\d+q?\d*\.jpg_?\.webp$/i, "").replace(/_.webp$/i, "").replace(/\?.+$/, "");
}

async function validateImg(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
    return r.ok && (r.headers.get("content-type") || "").startsWith("image/");
  } catch { return false; }
}

async function main() {
  const dirs = fss.readdirSync(KB);
  const results = [];

  for (const d of dirs) {
    const pp = path.join(KB, d, "product.json");
    if (!fss.existsSync(pp)) continue;
    const p = JSON.parse(fss.readFileSync(pp, "utf8"));
    const stage = p.workflow?.current_stage || "";
    if (!stage.includes("approved") && !stage.includes("listing")) continue;

    const prod = p.product || {};
    const gaps = [];
    const cat = matchCat(prod.name + " " + prod.category);

    // Images
    let rawImgs = [];
    try {
      const oz = JSON.parse(fss.readFileSync(path.join(KB, d, "ozon-knowledge.json"), "utf8"));
      if (oz.main_image) rawImgs.push(oz.main_image);
      if (oz.images) rawImgs.push(...oz.images);
    } catch {}
    if (rawImgs.length === 0) {
      try {
        const comp = JSON.parse(fss.readFileSync(path.join(KB, d, "1688-competitor-offers.json"), "utf8"));
        for (const o of (Array.isArray(comp) ? comp : [comp])) {
          if (o.image_urls) rawImgs.push(...o.image_urls);
        }
      } catch {}
    }
    const cleaned = [...new Set(rawImgs.map(cleanImgUrl).filter(Boolean))];
    const valid = [];
    for (const img of cleaned.slice(0, 12)) {
      if (await validateImg(img)) valid.push(img);
      if (valid.length >= 6) break;
    }
    if (valid.length === 0) gaps.push("缺可用图片");

    // Weight
    let wg = Math.round((prod.est_weight_kg || 0) * 1000);
    if (wg < 5) { wg = 200; gaps.push("重量为估算值(200g)"); }

    // Dims
    const longMm = Math.round((prod.package_long_edge_cm || 0) * 10);
    const dims = estimateDims(wg, longMm);
    if (longMm <= 0) gaps.push("尺寸为估算值");

    // Price — 跨境定价公式
    // 成本 = 采购价 + 国际运费(按重量) + 包装
    // 售价 = 成本 / (1 - Ozon佣金率) × 利润倍率
    const supply = prod.supply_price_cny || 0;
    const targetRub = prod.target_price_rub || 0;
    const SHIPPING_PER_KG = 20;    // 国际运费 ¥20/kg（CEL陆运均价）
    const PACKAGING_COST = 4;       // 包装成本 ¥4/件
    const OZON_COMMISSION = 0.18;   // Ozon佣金 18%
    const PROFIT_MULTIPLIER = 1.5;  // 利润倍率 1.5x（在扣除佣金后）
    const MIN_PRICE_CNY = 30;       // 最低售价 ¥30 CNY（低于这个不划算）

    const shippingCost = ((prod.est_weight_kg || 0.3) * SHIPPING_PER_KG);
    const totalCost = supply + shippingCost + PACKAGING_COST;
    // 售价 = 成本 × 利润倍率 / (1 - 佣金率)
    let price = supply > 0
      ? Math.ceil(totalCost * PROFIT_MULTIPLIER / (1 - OZON_COMMISSION))
      : (targetRub > 0 ? Math.ceil(targetRub / 12.5) : 0);
    if (price < MIN_PRICE_CNY) {
      price = MIN_PRICE_CNY;
      gaps.push("价格已上调至最低¥" + MIN_PRICE_CNY);
    }
    const oldPrice = Math.ceil(price * 1.3); // 划线价=售价×1.3

    // Russian title
    let titleRu = "";
    try {
      const t = JSON.parse(fss.readFileSync(path.join(KB, d, "listing-title.ru.json"), "utf8"));
      titleRu = t.selected_title_ru || t.product_name_ru || "";
    } catch {}
    if (!titleRu) {
      titleRu = toRu(prod.name || "");
      if (titleRu) gaps.push("俄文标题为AI翻译");
    }
    const title = titleRu || prod.name || d;
    const lang = titleRu ? "ru" : "zh-待俄文化";

    const blockers = gaps.filter(g => g.includes("缺可用图片"));
    const status = blockers.length === 0 ? "可提交" : "待补全";

    const mapping = {
      slug: d, status, gaps,
      offer_id: d,
      title_override: title, title_lang: lang,
      description_override: title,
      price_override: price + ".00",
      old_price_override: oldPrice + ".00",
      currency_code: CURRENCY,
      initial_stock: INITIAL_STOCK,
      warehouse_id: WAREHOUSE_ID,
      primary_image_override: valid[0] || "MISSING",
      images_override: valid,
      images_validated: true,
      weight_override_g: wg,
      depth_override_mm: dims.d,
      width_override_mm: dims.w,
      height_override_mm: dims.h,
      dimensions_estimated: longMm <= 0,
      import_fields: {
        description_category_id: cat.catId,
        type_id: cat.typeId,
        attributes: [
          { id: 9048, value: title },
          { id: 85, dictionary_value_id: NO_BRAND_ID, value: "Нет бренда" },
          { id: 8229, dictionary_value_id: cat.typeId, value: cat.typeName },
        ],
      },
    };

    fss.writeFileSync(path.join(KB, d, "ozon-import-mapping.json"), JSON.stringify(mapping, null, 2));
    results.push(mapping);
  }

  const ok = results.filter(m => m.status === "可提交");
  const ng = results.filter(m => m.status !== "可提交");
  console.log("=== 最终上架报告 ===");
  console.log("总计:", results.length, "| 可提交:", ok.length, "| 待补全:", ng.length);
  console.log("币种: CNY | 仓库:", WAREHOUSE_ID, "| 库存: 100\n");

  for (const m of results) {
    const icon = m.status === "可提交" ? "✅" : "🟡";
    console.log(`${icon} ${m.slug} [${m.status}]`);
    console.log(`  ${m.title_override.slice(0, 55)} [${m.title_lang}]`);
    console.log(`  ${m.price_override}/${m.old_price_override} CNY | ${m.weight_override_g}g | ${m.depth_override_mm}×${m.width_override_mm}×${m.height_override_mm}mm${m.dimensions_estimated ? "(估)" : ""}`);
    console.log(`  图片: ${m.images_override.length}张已验证 | 类目: ${m.import_fields.description_category_id}/${m.import_fields.type_id}`);
    if (m.gaps.length) console.log(`  备注: ${m.gaps.join(" | ")}`);
    console.log("");
  }
}

main();
