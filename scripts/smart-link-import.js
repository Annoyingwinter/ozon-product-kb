#!/usr/bin/env node
/**
 * 智能链接导入 — 粘贴任意平台链接，自动抓取或搜平替
 *
 * 流程:
 *   1. 识别链接平台 (1688/拼多多/淘宝/义乌购/速卖通/其他)
 *   2. 能直接抓 → 抓取详情数据
 *   3. 抓不到 → 提取商品名 → 1688搜平替
 *   4. 平替也没有 → 义乌购搜平替
 *   5. 都没有 → 报告"无可用货源"
 *
 * 用法:
 *   node scripts/smart-link-import.js --url "https://detail.1688.com/offer/xxx.html"
 *   node scripts/smart-link-import.js --url "https://mobile.yangkeduo.com/goods2.html?goods_id=xxx"
 *   node scripts/smart-link-import.js --url "https://item.taobao.com/item.htm?id=xxx"
 */
import fs from "node:fs/promises";
import path from "node:path";
import { normalize, readJson, writeJson, slug, timestamp, KB_ROOT, ensureDir } from "./lib/shared.js";
import { mobileSearch1688, mobileDetail1688 } from "./source-1688-mobile.js";
import { searchYiwugo, detailYiwugo } from "./source-yiwugo.js";

const STORAGE_STATE = path.resolve(".profiles", "1688", "storage-state.json");

// ── 平台识别 ──
function detectPlatform(url) {
  const u = String(url || "").toLowerCase();
  if (/detail\.1688\.com|m\.1688\.com|offer\/\d+/i.test(u)) return { platform: "1688", canScrape: true };
  if (/yangkeduo|pinduoduo|pdd/i.test(u)) return { platform: "pdd", canScrape: false };
  if (/taobao\.com|tmall\.com/i.test(u)) return { platform: "taobao", canScrape: false };
  if (/yiwugo\.com/i.test(u)) return { platform: "yiwugo", canScrape: true };
  if (/aliexpress/i.test(u)) return { platform: "aliexpress", canScrape: false };
  if (/jd\.com/i.test(u)) return { platform: "jd", canScrape: false };
  if (/amazon/i.test(u)) return { platform: "amazon", canScrape: false };
  if (/ozon\.ru/i.test(u)) return { platform: "ozon", canScrape: false };
  return { platform: "unknown", canScrape: false };
}

// ── 提取商品ID ──
function extractProductId(url, platform) {
  const u = String(url || "");
  if (platform === "1688") {
    const m = u.match(/offer\/(\d+)/i) || u.match(/offerId=(\d+)/i);
    return m?.[1] || "";
  }
  if (platform === "pdd") {
    const m = u.match(/goods_id=(\d+)/i);
    return m?.[1] || "";
  }
  if (platform === "taobao") {
    const m = u.match(/[?&]id=(\d+)/i);
    return m?.[1] || "";
  }
  if (platform === "yiwugo") {
    const m = u.match(/detail\/(\d+)/i);
    return m?.[1] || "";
  }
  return "";
}

// ── 从URL抓取商品标题（用于搜平替）──
async function fetchTitleFromUrl(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    const html = await r.text();
    // 从HTML提取标题
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let title = normalize(titleMatch?.[1] || "");
    // 清洗平台名
    title = title
      .replace(/[-_|–—].*?(拼多多|淘宝|天猫|京东|AliExpress|Ozon|Amazon).*$/i, "")
      .replace(/\s*-\s*商品详情.*$/i, "")
      .replace(/【.*?】/g, "")
      .trim();
    return title;
  } catch {
    return "";
  }
}

// ── 1688 cookie加载 ──
async function load1688Cookie() {
  try {
    const state = JSON.parse(await fs.readFile(STORAGE_STATE, "utf8"));
    const now = Date.now() / 1000;
    const cookies = (state.cookies || [])
      .filter(c => String(c.domain || "").includes("1688.com"))
      .filter(c => !c.expires || c.expires > now);
    if (cookies.length < 3) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch { return null; }
}

// ── 核心导入逻辑 ──
export async function smartImport(url, onLog = console.log) {
  const { platform, canScrape } = detectPlatform(url);
  const productId = extractProductId(url, platform);

  onLog(`[识别] 平台: ${platform} | ID: ${productId || "无"} | 可直接抓取: ${canScrape ? "是" : "否"}`);

  let productData = null;
  let source = "";

  // ── Step 1: 直接抓取 ──
  if (canScrape) {
    if (platform === "1688" && productId) {
      onLog(`[抓取] 1688详情页: ${productId}`);
      const cookie = await load1688Cookie();
      if (cookie) {
        try {
          const detail = await mobileDetail1688(productId, cookie);
          if (detail.page_type !== "captcha" && detail.offer_title) {
            productData = detail;
            source = "1688-direct";
            onLog(`[成功] 1688抓取成功: ${detail.offer_title?.slice(0, 40)}`);
          } else {
            onLog(`[失败] 1688详情页验证码或无数据`);
          }
        } catch (e) { onLog(`[失败] 1688抓取异常: ${e.message}`); }
      } else {
        onLog(`[跳过] 无1688登录态，无法直接抓取`);
      }
    }

    if (platform === "yiwugo" && productId) {
      onLog(`[抓取] 义乌购详情页: ${productId}`);
      try {
        const detail = await detailYiwugo(productId);
        if (detail.offer_title) {
          productData = detail;
          source = "yiwugo-direct";
          onLog(`[成功] 义乌购抓取成功: ${detail.offer_title?.slice(0, 40)}`);
        }
      } catch (e) { onLog(`[失败] 义乌购抓取异常: ${e.message}`); }
    }
  }

  // ── Step 2: 抓不到 → 提取标题 → 搜平替 ──
  if (!productData) {
    onLog(`[平替] 尝试提取商品标题...`);
    let searchKeyword = await fetchTitleFromUrl(url);

    if (!searchKeyword) {
      // 从URL本身猜关键词
      const urlParts = url.match(/[\u4e00-\u9fff]{2,}/g);
      searchKeyword = urlParts?.join(" ") || "";
    }

    if (!searchKeyword) {
      onLog(`[失败] 无法从链接提取商品名称`);
      return { success: false, reason: "cannot_extract_title", url, platform };
    }

    onLog(`[平替] 提取到关键词: "${searchKeyword.slice(0, 30)}"`);

    // Step 2a: 1688搜平替
    const cookie = await load1688Cookie();
    if (cookie) {
      onLog(`[搜索] 1688搜索平替: "${searchKeyword.slice(0, 20)}"`);
      try {
        const results = await mobileSearch1688(searchKeyword, cookie);
        if (!results.hasCaptcha && results.items.length > 0) {
          const bestMatch = results.items[0];
          onLog(`[找到] 1688平替: ${bestMatch.title?.slice(0, 40)} (¥${bestMatch.price})`);

          // 抓详情
          if (bestMatch.offerId) {
            try {
              const detail = await mobileDetail1688(bestMatch.offerId, cookie);
              if (detail.offer_title) {
                productData = { ...bestMatch, ...detail };
                source = "1688-alternative";
                onLog(`[成功] 1688平替详情抓取成功`);
              }
            } catch { productData = bestMatch; source = "1688-alternative-basic"; }
          } else {
            productData = bestMatch;
            source = "1688-alternative-basic";
          }
        } else {
          onLog(`[未找到] 1688无匹配结果`);
        }
      } catch (e) { onLog(`[失败] 1688搜索异常: ${e.message}`); }
    }

    // Step 2b: 义乌购搜平替
    if (!productData) {
      onLog(`[搜索] 义乌购搜索平替: "${searchKeyword.slice(0, 20)}"`);
      try {
        const results = await searchYiwugo(searchKeyword);
        if (results.length > 0) {
          const bestMatch = results[0];
          onLog(`[找到] 义乌购平替: ${bestMatch.title?.slice(0, 40)} (${bestMatch.priceText})`);

          if (bestMatch.offerId) {
            try {
              const detail = await detailYiwugo(bestMatch.offerId);
              if (detail.offer_title) {
                productData = { ...bestMatch, ...detail };
                source = "yiwugo-alternative";
                onLog(`[成功] 义乌购平替详情抓取成功`);
              }
            } catch { productData = bestMatch; source = "yiwugo-alternative-basic"; }
          } else {
            productData = bestMatch;
            source = "yiwugo-alternative-basic";
          }
        } else {
          onLog(`[未找到] 义乌购也无匹配结果`);
        }
      } catch (e) { onLog(`[失败] 义乌购搜索异常: ${e.message}`); }
    }
  }

  // ── Step 3: 都没找到 ──
  if (!productData) {
    onLog(`[结果] 无可用货源。建议换个关键词或手动查找。`);
    return { success: false, reason: "no_source_found", url, platform };
  }

  // ── Step 4: 保存到知识库 ──
  const title = productData.offer_title || productData.title || "Imported Product";
  const productSlug = slug(title);
  const productDir = path.join(KB_ROOT, "products", productSlug);
  await ensureDir(productDir);

  const productJson = {
    spu_id: productSlug,
    source_platform: source.split("-")[0],
    source_url: url,
    import_source: source,
    imported_at: new Date().toISOString(),
    keyword: title,
    candidates: [{
      rank: 1,
      title: productData.offer_title || productData.title || "",
      source_url: productData.detail_url || productData.offerUrl || url,
      prices: productData.price_text ? [productData.price_text] : [],
      attributes: productData.source_attributes
        ? Object.fromEntries(productData.source_attributes.map(a => [a.name, a.value]))
        : (productData.normalized_attributes || {}),
      images: productData.image_urls || [],
      main_image: (productData.image_urls || [])[0] || productData.imageUrl || "",
      shop_name: productData.shop_name || productData.shopName || "",
    }],
    seed: {
      name: title,
      category: "",
      target_users: "",
      why_it_can_sell: `从${platform}导入`,
      target_price_rub: 0,
      supply_price_cny: productData.price || parseFloat(productData.price_text?.replace(/[^\d.]/g, "") || "0"),
      est_weight_kg: (productData.weight_g || 0) / 1000 || 0.3,
    },
  };

  await writeJson(path.join(productDir, "product.json"), productJson);

  onLog(`[保存] ${productDir}`);
  onLog(`[结果] 导入成功!`);
  onLog(`  标题: ${title.slice(0, 50)}`);
  onLog(`  来源: ${source}`);
  onLog(`  价格: ${productData.price_text || productData.priceText || "未知"}`);
  onLog(`  图片: ${(productData.image_urls || []).length}张`);

  return {
    success: true,
    slug: productSlug,
    title,
    source,
    platform,
    originalUrl: url,
    data: productJson,
  };
}

// CLI入口
if (process.argv[1]?.endsWith("smart-link-import.js")) {
  const urlArg = process.argv.find((a, i) => process.argv[i - 1] === "--url") || process.argv[2];
  if (!urlArg) {
    console.log("用法: node scripts/smart-link-import.js --url <链接>");
    process.exit(1);
  }
  smartImport(urlArg).then(r => {
    if (!r.success) process.exit(1);
  });
}
