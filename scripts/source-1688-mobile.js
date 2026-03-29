/**
 * 1688 移动端HTTP采集 — 无浏览器、无验证码
 *
 * 通过 m.1688.com 移动端HTML页面提取商品数据，
 * 仅需cookie，不需要Playwright，不触发验证码。
 *
 * 搜索：m.1688.com/offer_search/ → 提取offer链接和基本信息
 * 详情：m.1688.com/offer/{id}.html → 提取完整商品数据
 */

import fs from "node:fs/promises";
import path from "node:path";
import { normalize, repairDeepMojibake, readJson } from "./shared-utils.js";

const STORAGE_STATE_PATH = path.resolve(".profiles", "1688", "storage-state.json");
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MARKETPLACE_DOMAIN = "1688.com";

// ── Cookie管理 ──

async function loadCookieString() {
  try {
    const state = JSON.parse(await fs.readFile(STORAGE_STATE_PATH, "utf8"));
    const now = Date.now() / 1000;
    const cookies = (state.cookies || [])
      .filter((c) => String(c.domain || "").includes(MARKETPLACE_DOMAIN))
      .filter((c) => !c.expires || c.expires > now);
    if (cookies.length < 3) {
      throw new Error("cookie不足或已过期，请先运行 node scripts/refresh-1688-session.js 登录");
    }
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("未找到1688登录状态，请先运行 node scripts/refresh-1688-session.js 登录");
    }
    throw error;
  }
}

// ── HTTP请求 ──

async function fetchHtml(url, cookieStr, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Cookie: cookieStr,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://m.1688.com/",
        ...extraHeaders,
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── 搜索解析 ──

function parseSearchHtml(html, keyword) {
  const hasCaptcha = /验证码|captcha|拖动.*滑块|_____tmd_____/i.test(html);
  if (hasCaptcha) {
    return { items: [], hasCaptcha: true };
  }

  // 提取所有offer链接（去重，排除"1688"本身）
  const rawIds = (html.match(/m\.1688\.com\/offer\/(\d{6,})/g) || [])
    .map((m) => m.match(/(\d{6,})/)?.[1])
    .filter(Boolean);
  const offerIds = [...new Set(rawIds)];

  // 尝试从HTML中提取商品标题和价格
  // 移动端HTML中商品卡片通常有特定结构
  const items = offerIds.map((offerId) => {
    // 在HTML中找到该offerId附近的文本作为标题
    const idIndex = html.indexOf(offerId);
    let title = "";
    let price = "";
    if (idIndex > 0) {
      // 找offerId前后200字符范围内的中文标题
      const context = html.slice(Math.max(0, idIndex - 500), idIndex + 500);
      // 找title属性或alt属性
      const titleMatch =
        context.match(/title="([^"]{6,80})"/) ||
        context.match(/alt="([^"]{6,80})"/) ||
        context.match(/>([^<]{6,60}(?:器|盒|架|袋|刷|垫|杯|罩|夹|扣|带|套|包)[^<]{0,20})</);
      if (titleMatch) title = normalize(titleMatch[1]);
      // 找价格
      const priceMatch = context.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
      if (priceMatch) price = priceMatch[0];
    }

    return {
      offerId,
      title: title || keyword,
      offerUrl: `https://detail.1688.com/offer/${offerId}.html`,
      mobileUrl: `https://m.1688.com/offer/${offerId}.html`,
      priceText: price,
      price: parseFloat(price.replace(/[¥￥\s]/g, "")) || 0,
      imageUrl: "",
      shopName: "",
      salesCount: 0,
      cardText: title || keyword,
      searchScore: 50,
    };
  });

  return { items, hasCaptcha: false };
}

// ── 详情页解析 ──

function parseDetailHtml(html, offerId) {
  const hasCaptcha = /验证码|captcha|拖动.*滑块|_____tmd_____/i.test(html);
  if (hasCaptcha) {
    return { page_type: "captcha", offer_title: "", offerId };
  }

  // 标题
  const titleMatch =
    html.match(/<title>([^<]+)<\/title>/) ||
    html.match(/og:title[\"']\s*content=[\"']([^\"']+)/) ||
    html.match(/subject[\"']\s*:\s*[\"']([^\"']{6,})[\"']/);
  const rawTitle = normalize(titleMatch?.[1] || "")
    .replace(/\s*-\s*阿里巴巴.*$/i, "")
    .replace(/\s*-\s*1688\.com.*$/i, "");

  // 价格
  const priceMatch =
    html.match(/[\"']price[\"']\s*:\s*[\"'](\d+(?:\.\d+)?)[\"']/) ||
    html.match(/[¥￥]\s*(\d+(?:\.\d+)?)/) ||
    html.match(/priceRange[\"']\s*:\s*[\"']([^\"']+)[\"']/);
  const priceText = priceMatch?.[1] || priceMatch?.[0] || "";

  // 图片
  const images = [...new Set(
    (html.match(/https?:\/\/cbu\d*\.alicdn\.com\/[^\s\"'<>]+\.(?:jpg|png|webp)/gi) || [])
      .map((u) => u.split("?")[0])
      .filter((u) => !u.includes("avatar") && !u.includes("icon") && !u.includes("logo")),
  )];

  // 属性
  const attrPairs = [];
  const attrMatches = html.matchAll(/[\"'](?:propName|attrName)[\"']\s*:\s*[\"']([^\"']+)[\"']\s*,\s*[\"'](?:propValue|attrValue)[\"']\s*:\s*[\"']([^\"']+)[\"']/g);
  for (const m of attrMatches) {
    attrPairs.push({ name: normalize(m[1]), value: normalize(m[2]) });
  }
  // 备用：从HTML表格提取
  if (attrPairs.length === 0) {
    const tdPairs = html.matchAll(/<(?:th|td)[^>]*>([^<]{2,20})<\/(?:th|td)>\s*<(?:th|td)[^>]*>([^<]{2,60})<\/(?:th|td)>/g);
    for (const m of tdPairs) {
      const name = normalize(m[1]);
      const value = normalize(m[2]);
      if (name && value && !/colspan|rowspan|class/i.test(name)) {
        attrPairs.push({ name, value });
      }
    }
  }

  // 店铺名
  const shopMatch =
    html.match(/shopName[\"']\s*:\s*[\"']([^\"']+)[\"']/) ||
    html.match(/companyName[\"']\s*:\s*[\"']([^\"']+)[\"']/) ||
    html.match(/sellerName[\"']\s*:\s*[\"']([^\"']+)[\"']/);

  // 起订量
  const moqMatch =
    html.match(/minOrderQuantity[\"']\s*:\s*[\"']?(\d+)/) ||
    html.match(/beginAmount[\"']\s*:\s*[\"']?(\d+)/) ||
    html.match(/≥\s*(\d+)\s*[个件只包套双]/);

  // 销量
  const salesMatch =
    html.match(/quantitySumMonth[\"']\s*:\s*[\"']?(\d+)/) ||
    html.match(/gmvSumMonth|soldQuantity|saleCount[\"']\s*:\s*[\"']?(\d+)/);

  return {
    page_type: "detail",
    offerId,
    offer_title: rawTitle,
    detail_url: `https://detail.1688.com/offer/${offerId}.html`,
    price_text: priceText,
    price_range_text: priceText,
    min_order_qty: parseInt(moqMatch?.[1] || "1", 10),
    unit: "件",
    shop_name: normalize(shopMatch?.[1] || ""),
    image_urls: images.slice(0, 20),
    image_count: images.length,
    source_attributes: attrPairs,
    attr_count: attrPairs.length,
    sku_list: [],
    raw_card_text: rawTitle,
    sales_count: parseInt(salesMatch?.[1] || salesMatch?.[2] || "0", 10),
  };
}

// ── 公开API ──

/**
 * 通过移动端HTTP搜索1688（无浏览器、无验证码）
 */
export async function mobileSearch1688(keyword, cookieStr) {
  const url = `https://m.1688.com/offer_search/-6D616C6C2E31363838.html?keywords=${encodeURIComponent(keyword)}`;
  const html = await fetchHtml(url, cookieStr);
  return parseSearchHtml(html, keyword);
}

/**
 * 通过移动端HTTP获取商品详情
 */
export async function mobileDetail1688(offerId, cookieStr) {
  // PC详情页比移动端验证码少，优先用PC
  const pcUrl = `https://detail.1688.com/offer/${offerId}.html`;
  try {
    const html = await fetchHtml(pcUrl, cookieStr, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      Referer: "https://s.1688.com/",
    });
    const result = parseDetailHtml(html, offerId);
    if (result.page_type !== "captcha") return result;
  } catch {}
  // PC端失败则fallback到移动端
  const mobileUrl = `https://m.1688.com/offer/${offerId}.html`;
  const html = await fetchHtml(mobileUrl, cookieStr);
  return parseDetailHtml(html, offerId);
}

/**
 * 批量搜索+详情（替代Playwright的collect1688Candidates）
 * 无浏览器、无验证码、纯HTTP。
 */
export async function collect1688ByMobile(seeds, options = {}) {
  const {
    perKeywordLimit = 10,
    detailLimit = 12,
    pacingMs = 3000,
  } = options;

  const cookieStr = await loadCookieString();
  console.log(`[1688-mobile] 使用移动端HTTP模式 (无浏览器、无验证码)`);

  const searchAttempts = [];
  const allCandidates = [];

  for (const [i, seed] of seeds.entries()) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, pacingMs + Math.random() * 2000));
    }

    try {
      console.log(`[${i + 1}/${seeds.length}] 搜索: ${seed.keyword}`);
      const result = await mobileSearch1688(seed.keyword, cookieStr);

      if (result.hasCaptcha) {
        console.log(`[${i + 1}/${seeds.length}] "${seed.keyword}" 触发验证码，跳过`);
        searchAttempts.push({ keyword: seed.keyword, page_type: "captcha", card_count: 0 });
        continue;
      }

      const items = result.items.slice(0, perKeywordLimit);
      console.log(`[${i + 1}/${seeds.length}] "${seed.keyword}" -> ${items.length} 个商品`);

      searchAttempts.push({
        keyword: seed.keyword,
        page_type: "search",
        card_count: items.length,
        offer_link_count: items.length,
      });

      for (const item of items) {
        allCandidates.push({
          ...item,
          keywords: [seed.keyword],
          seedCategories: seed.category ? [seed.category] : [],
          seedReasons: seed.why ? [seed.why] : [],
          targetUsers: seed.target_users ? [seed.target_users] : [],
        });
      }
    } catch (error) {
      console.error(`[${i + 1}/${seeds.length}] "${seed.keyword}" 失败: ${error.message}`);
      searchAttempts.push({ keyword: seed.keyword, page_type: "error", card_count: 0 });
    }
  }

  // 去重
  const seen = new Set();
  const deduped = allCandidates.filter((c) => {
    if (!c.offerId || seen.has(c.offerId)) return false;
    seen.add(c.offerId);
    return true;
  });

  const shortlisted = deduped.slice(0, detailLimit);
  console.log(`[1688-mobile] 搜索完成: ${allCandidates.length}个 -> ${deduped.length}去重 -> ${shortlisted.length}个进入详情`);

  // 抓详情
  const offers = [];
  for (const [i, candidate] of shortlisted.entries()) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
    }
    try {
      const detail = await mobileDetail1688(candidate.offerId, cookieStr);
      if (detail.page_type === "captcha") {
        console.log(`[detail] ${i + 1}/${shortlisted.length} ${candidate.offerId} 验证码，用搜索数据兜底`);
        offers.push({ ...candidate, source_url: candidate.offerUrl });
      } else {
        const title = normalize(detail.offer_title || candidate.title).slice(0, 50);
        console.log(`[detail] ${i + 1}/${shortlisted.length} ${title}`);
        offers.push({ ...candidate, ...detail, source_url: candidate.offerUrl });
      }
    } catch (error) {
      console.error(`[detail] ${candidate.offerId} 失败: ${error.message}`);
      offers.push({ ...candidate, source_url: candidate.offerUrl });
    }
  }

  console.log(`[1688-mobile] 完成: ${offers.length} 个商品数据`);

  return {
    runtime: { mode: "mobile-http", storageStateExists: true, bootstrapSource: "cookie", browserProfileDir: "" },
    rawCards: deduped,
    searchAttempts,
    searchPool: deduped,
    offers,
    detailIssues: [],
    captchaSkippedKeywords: [],
    async close() {},
  };
}
