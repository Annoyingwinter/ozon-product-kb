#!/usr/bin/env node
/**
 * Stage 2a: 1688 数据采集
 * Playwright 搜索+详情页抓取，从旧项目提炼核心逻辑
 *
 * 用法: node scripts/2a-scrape-1688.js --input output/seeds-xxx.json [--limit 3] [--headless]
 * 输出: knowledge-base/products/<slug>/product.json
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseCliArgs, readJson, writeJson, normalize, parseNumber,
  convertWeightToKg, slug, timestamp, KB_ROOT, ensureDir,
} from "./lib/shared.js";
import { launchBrowser, gotoSafe, detectPageType, waitForCaptcha, saveSession, closeBrowser } from "./lib/browser.js";

const PROFILE_DIR = path.resolve(".profiles", "1688", "browser-user-data");
const STORAGE_STATE = path.resolve(".profiles", "1688", "storage-state.json");
const TOP_N = 3;

// ─── 属性映射表 ───
const ATTR_MAP = [
  [/品牌|brand/i, "brand"], [/型号|model/i, "model"],
  [/货号|款号|商家编码|vendor/i, "vendor_code"], [/条码|ean|upc|gtin|barcode/i, "barcode"],
  [/材质|面料|成分|material/i, "material"], [/颜色|color/i, "color"],
  [/尺寸|规格|尺码|size/i, "size"], [/适用|compatible/i, "compatible_models"],
  [/风格|style/i, "style"], [/功能|feature/i, "feature"],
  [/电源|供电|power/i, "power_supply"], [/产地|country/i, "country_of_origin"],
  [/净重|重量|weight/i, "weight_raw"], [/包装尺寸|package size/i, "package_size_raw"],
];

function encodeFor1688(keyword) {
  if (process.platform !== "win32") return encodeURIComponent(keyword);
  try {
    const escaped = keyword.replace(/'/g, "''");
    return execFileSync("powershell.exe", [
      "-NoProfile", "-Command",
      `Add-Type -AssemblyName System.Web; [System.Web.HttpUtility]::UrlEncode('${escaped}', [System.Text.Encoding]::GetEncoding(936))`,
    ], { encoding: "utf8", windowsHide: true }).trim() || encodeURIComponent(keyword);
  } catch { return encodeURIComponent(keyword); }
}

// ─── 搜索页采集 ───
async function searchAndCollect(page, keyword) {
  const encoded = encodeFor1688(keyword);
  const url = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encoded}`;
  await gotoSafe(page, url, { wait: 3500, timeout: 60_000 });

  const pageType = await detectPageType(page);
  if (pageType === "captcha") {
    console.warn(`    [1688] 验证码，跳过: ${keyword}`);
    return [];
  }
  if (pageType === "login") {
    console.warn(`    [1688] 需要登录，跳过: ${keyword}`);
    return [];
  }

  return page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(document.querySelectorAll(".search-offer-item, .major-offer"));
    return cards.slice(0, 20).map((card, idx) => {
      const anchors = [
        card.tagName === "A" ? card : null,
        ...Array.from(card.querySelectorAll("a")),
      ].filter(Boolean);
      const allHrefs = anchors.map(a => a.href || "").filter(Boolean);
      // 1688详情页URL的多种格式
      const offerA = anchors.find(a => {
        const href = a.href || "";
        return /detail\.1688\.com\/offer\/\d+/i.test(href) ||
               /offerId=\d+/i.test(href) ||
               /offerIds?=\d+/i.test(href) ||
               (/1688\.com/i.test(href) && /\d{10,}/.test(href));
      });
      // 如果card本身是链接且包含长数字串(offer ID)
      const cardHref = card.tagName === "A" ? (card.href || "") : "";
      const bestHref = offerA?.href || cardHref || allHrefs.find(h => /\d{10,}/.test(h) && /1688/i.test(h)) || "";

      const img = card.querySelector("img");
      const priceEl = card.querySelector('[class*="price"]');
      const titleEl = card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='subject'], [class*='name']");
      return {
        title: clean(titleEl?.textContent || offerA?.textContent || img?.alt || ""),
        offerUrl: bestHref,
        shopName: clean(anchors.find(a => /\.1688\.com/i.test(a.href || "") && !/detail\.1688/i.test(a.href || ""))?.textContent || ""),
        imageUrl: img?.getAttribute("data-lazy-src") || img?.src || "",
        priceText: clean(priceEl?.textContent || ""),
        _debug_hrefs: allHrefs.slice(0, 5),
      };
    }).filter(c => c.title && c.title.length >= 4);
  });
}

// ─── 详情页抓取 ───
async function scrapeDetail(page, url) {
  await gotoSafe(page, url, { wait: 4000 });
  const pageType = await detectPageType(page);
  if (pageType === "captcha") { console.warn(`    [1688] 详情页验证码，跳过`); return null; }
  if (pageType === "login") return null;

  return page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const blocked = /公司|有限公司|商行|工厂|经营部|批发部|阿里1688|1688首页|登录|密码/;

    // ─── 标题: 多策略取最佳 ───
    const titleCandidates = [
      document.querySelector('[class*="title-text"], [class*="detail-title"], [class*="mod-detail-title"]')?.textContent,
      document.querySelector('h1[class*="title"]')?.textContent,
      document.querySelector('h1')?.textContent,
      document.querySelector('[class*="subject"]')?.textContent,
      document.title?.replace(/[-_|].*1688.*$|阿里巴巴.*$/i, ""),
    ].map(v => clean(v || "")).filter(v => v.length >= 4 && !blocked.test(v));
    const title = titleCandidates[0] || clean(document.title);

    // ─── 价格: 只取数字价格，过滤法律文本 ───
    const priceEls = document.querySelectorAll(
      '[class*="price-num"], [class*="price-now"], [class*="price-value"], [class*="price-text"], [class*="price"] > span'
    );
    let prices = Array.from(priceEls)
      .map(el => clean(el.textContent))
      .filter(v => /^[¥￥]?\s*\d/.test(v) && v.length < 30);
    // 回退: 从更宽泛的价格元素中提取
    if (!prices.length) {
      const allPriceEls = document.querySelectorAll('[class*="price"]');
      for (const el of allPriceEls) {
        const text = clean(el.textContent);
        const match = text.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
        if (match && text.length < 50) prices.push(`¥${match[1]}`);
      }
    }
    prices = [...new Set(prices)].slice(0, 5);

    // ─── 属性 ───
    const attrSelectors = [
      "table tr",
      "[class*='attr'] [class*='item']",
      "[class*='attribute'] li",
      "[class*='detail-attr'] li",
      "[class*='obj-leading'] li",
    ];
    const rows = Array.from(document.querySelectorAll(attrSelectors.join(",")));
    const attrs = [];
    for (const row of rows) {
      const cells = row.querySelectorAll("td, th");
      if (cells.length >= 2) {
        const key = clean(cells[0].textContent);
        const value = clean(cells[1].textContent);
        if (key.length >= 1 && key.length <= 20 && value.length >= 1 && value.length <= 100) {
          attrs.push({ key, value });
        }
        continue;
      }
      const text = clean(row.textContent);
      const match = text.match(/^(.{1,20})[：:]\s*(.{1,100})$/);
      if (match) attrs.push({ key: match[1], value: match[2] });
    }

    // ─── 图片: 获取高清原图 ───
    const images = Array.from(new Set(
      Array.from(document.querySelectorAll("img"))
        .map(img => img.getAttribute("data-lazy-src") || img.getAttribute("data-src") || img.src || "")
        .filter(url => /^https?:/i.test(url))
        .filter(url => !/svg|avatar|icon|logo|sprite|\.gif|gw\.alicdn/i.test(url))
        .filter(url => !/tps-\d+-\d+/i.test(url))
        // webp→jpg: .jpg_.webp → .jpg
        .map(url => url.replace(/\.(jpg|jpeg|png)_\.webp$/i, '.$1'))
        // 缩略图→原图: _284x284q90.jpg → .jpg
        .map(url => url.replace(/_\d+x\d+q?\d*\.(jpg|jpeg|png)$/i, '.$1'))
        .filter(url => !/\b(32|48|64|72)x\1\b/.test(url))
    )).slice(0, 15);

    // ─── 起批量 ───
    const moqText = clean(document.querySelector('[class*="step-amount"], [class*="min-order"]')?.textContent || "");
    const moqMatch = moqText.match(/(\d+)\s*(?:个|件|套|起)/);

    return {
      title,
      prices,
      attributes: attrs,
      images,
      url: location.href,
      min_order_qty: moqMatch ? parseInt(moqMatch[1]) : 1,
    };
  });
}

function normalizeAttributes(rawAttrs) {
  const result = {};
  for (const { key, value } of rawAttrs) {
    for (const [regex, field] of ATTR_MAP) {
      if (regex.test(key)) { result[field] = normalize(value); break; }
    }
  }
  return result;
}

function deriveDetailUrl(candidate) {
  const href = normalize(candidate.offerUrl);
  if (/detail\.1688\.com\/offer\/\d+/i.test(href)) return href;
  const m1 = href.match(/offerId=(\d+)/i);
  if (m1) return `https://detail.1688.com/offer/${m1[1]}.html`;
  const m2 = href.match(/offerIds?=(\d+)/i);
  if (m2) return `https://detail.1688.com/offer/${m2[1]}.html`;
  // 从URL中提取10+位数字(offer ID)
  const m3 = href.match(/(\d{10,})/);
  if (m3) return `https://detail.1688.com/offer/${m3[1]}.html`;
  // 最后尝试从debug hrefs中找
  for (const h of (candidate._debug_hrefs || [])) {
    const m = h.match(/(\d{10,})/);
    if (m && /1688/i.test(h)) return `https://detail.1688.com/offer/${m[1]}.html`;
  }
  return "";
}

// ─── 主流程 ───
async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    input: "", limit: "5", headless: false, topN: String(TOP_N),
  });
  if (!args.input) throw new Error("需要 --input <seeds.json>");

  const seeds = await readJson(path.resolve(args.input));
  const products = (seeds?.products || seeds?.seeds || seeds || [])
    .filter(p => (p.go_or_no_go || "Go") !== "No-Go");
  const limit = parseInt(args.limit) || 5;
  const topN = parseInt(args.topN) || TOP_N;

  console.log(`[Stage 2a] 1688采集: ${Math.min(products.length, limit)} 个商品, 每个取Top${topN}`);

  const { context, browser, mode } = await launchBrowser(PROFILE_DIR, { headless: !!args.headless, storageStatePath: STORAGE_STATE });
  console.log(`  浏览器模式: ${mode}`);

  const results = [];
  for (const product of products.slice(0, limit)) {
    const keyword = product.keyword || product.name;
    console.log(`\n  搜索: "${keyword}"`);
    const page = await context.newPage();

    try {
      const candidates = await searchAndCollect(page, keyword);
      console.log(`    找到 ${candidates.length} 个候选`);
      if (candidates.length) {
        const sample = candidates[0];
        console.log(`    样本: title="${sample.title?.slice(0,30)}" url="${sample.offerUrl?.slice(0,60)}" hrefs=${JSON.stringify(sample._debug_hrefs?.slice(0,2))}`);
      }

      const topCandidates = candidates.slice(0, topN);
      const details = [];

      for (const candidate of topCandidates) {
        const detailUrl = deriveDetailUrl(candidate);
        if (!detailUrl) continue;
        console.log(`    抓取详情: ${detailUrl.slice(0, 60)}...`);
        const detail = await scrapeDetail(page, detailUrl);
        if (detail) {
          const attrs = normalizeAttributes(detail.attributes);
          details.push({
            ...detail,
            normalized_attributes: attrs,
            search_title: candidate.title,
            shop_name: candidate.shopName,
            search_price: candidate.priceText,
          });
        }
      }

      // 保存到知识库
      const productSlug = slug(keyword);
      const productDir = path.join(KB_ROOT, "products", productSlug);
      const productJson = {
        spu_id: productSlug,
        source_platform: "1688",
        seed: product,
        keyword,
        scraped_at: new Date().toISOString(),
        candidates: details.map((d, i) => ({
          rank: i + 1,
          title: d.title,
          source_url: d.url,
          prices: d.prices,
          attributes: d.normalized_attributes,
          raw_attributes: d.attributes,
          images: d.images,
          main_image: d.images[0] || "",
          shop_name: d.shop_name,
        })),
      };

      await writeJson(path.join(productDir, "product.json"), productJson);
      results.push({ keyword, slug: productSlug, candidateCount: details.length });
      console.log(`    ✓ 保存: ${productDir}`);
    } catch (err) {
      console.error(`    ✗ 失败: ${err.message}`);
      results.push({ keyword, error: err.message });
    } finally {
      await page.close().catch(() => {});
    }

    // 人类节奏
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000)); // 5-10秒间隔防反爬
  }

  await saveSession(context, STORAGE_STATE);
  await closeBrowser({ context, browser });

  const outputPath = path.join("output", `scrape-1688-${timestamp()}.json`);
  await writeJson(outputPath, { source: "1688", results });
  console.log(`\n[Stage 2a] 完成: ${results.filter(r => !r.error).length}/${results.length} 成功`);
}

main().catch(err => { console.error(err); process.exit(1); });
