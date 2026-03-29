/**
 * 义乌购采集 — 纯HTTP，无需登录，无验证码
 *
 * 使用 en.yiwugo.com（英文站，服务端渲染HTML）
 * 搜索：en.yiwugo.com/product/list.html?keyword={keyword}&cpage={page}
 * 详情：en.yiwugo.com/product/detail/{productId}.html
 */

import { normalize, repairDeepMojibake } from "./shared-utils.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SEARCH_URL = "https://en.yiwugo.com/product/list.html";
const DETAIL_URL = "https://en.yiwugo.com/product/detail";

async function fetchHtml(url, timeoutMs = 15000) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ── 搜索解析 ──

function parseSearchHtml(html, keyword) {
  const items = [];
  const seen = new Set();

  // 按product_inf分割卡片
  const cards = html.split("product_inf");

  for (let ci = 1; ci < cards.length; ci++) {
    const card = cards[ci];

    // 提取productid
    const pidMatch = card.match(/productid="(\d+)"/);
    if (!pidMatch) continue;
    const pid = pidMatch[1];
    if (seen.has(pid)) continue;
    seen.add(pid);

    // 标题从 <a class="producthref" title="...">
    const titleMatch = card.match(/title="([^"]{6,200})"/);
    const title = normalize(titleMatch?.[1] || keyword);

    // 图片从 data-url="..."
    const imgMatch = card.match(/data-url="([^"]+)"/);
    const imageUrl = imgMatch?.[1] || "";

    // 价格从 cpprice 区域
    const priceSection = card.match(/cpprice[\s\S]{0,200}/)?.[0] || "";
    const priceNums = [...priceSection.matchAll(/(\d+)(?:<font>\.(\d+)<\/font>)?/g)].map(m =>
      parseFloat(m[1] + (m[2] ? "." + m[2] : ""))
    );
    const priceLow = priceNums[0] || 0;
    const priceHigh = priceNums[1] || priceLow;

    // MOQ
    const moqMatch = card.match(/Min\.?\s*Order:?\s*([\d,]+)\s*(\w+)/i);

    // 供应商
    const shopMatch = card.match(/cpname[\s\S]{0,200}?title="([^"]+)"/);

    items.push({
      offerId: pid,
      title,
      offerUrl: `https://en.yiwugo.com/product/detail/${pid}.html`,
      price: priceLow,
      priceHigh,
      priceText: priceLow > 0 ? `CN¥${priceLow}${priceHigh > priceLow ? " ~ " + priceHigh : ""}` : "",
      minOrderQty: parseInt((moqMatch?.[1] || "1").replace(/,/g, ""), 10),
      minOrderUnit: moqMatch?.[2] || "piece",
      shopName: normalize(shopMatch?.[1] || ""),
      imageUrl: imageUrl.startsWith("//") ? "https:" + imageUrl : imageUrl,
      platform: "yiwugo",
      searchScore: 50,
      cardText: title,
    });
  }

  return items;
}

// ── 详情页解析 ──

function parseDetailHtml(html, productId) {
  // 标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/) || html.match(/<title>([^<]+)<\/title>/);
  const title = normalize(titleMatch?.[1] || "").replace(/\s*-\s*Yiwugo.*$/i, "");

  // 价格
  const priceMatch = html.match(/EXW\s*Price[^<]*<[^>]*>([^<]*CN[^<]*)/i) || html.match(/CN\u00a5\s*([\d.]+)/);
  const priceText = normalize(priceMatch?.[1] || priceMatch?.[0] || "");

  // MOQ
  const moqMatch = html.match(/Min\.?\s*Order[^<]*<[^>]*>\s*([\d,]+)\s*(\w+)/i);

  // 图片
  const images = [...new Set(
    [...html.matchAll(/(?:src|data-original|data-src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)/gi)]
      .map(m => m[1])
      .filter(u => !u.includes("blank.gif") && !u.includes("icon") && !u.includes("logo") && !u.includes("avatar"))
  )];

  // 属性表（从HTML表格提取）
  const attrs = [];
  const rows = [...html.matchAll(/<t[dh][^>]*>([^<]{2,30})<\/t[dh]>\s*<t[dh][^>]*>([^<]{2,80})<\/t[dh]>/g)];
  for (const row of rows) {
    const name = normalize(row[1]);
    const value = normalize(row[2]);
    if (name && value && !/colspan|class|style/i.test(name)) {
      attrs.push({ name, value });
    }
  }

  // 供应商信息
  const companyMatch = html.match(/Company\s*Name[^<]*<[^>]*>([^<]+)/i) || html.match(/company-name[^>]*>([^<]+)/i);
  const phoneMatch = html.match(/(?:Tel|Phone|Mobile)[^<]*<[^>]*>([^<]+)/i);
  const emailMatch = html.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);

  // 包装信息
  const cartonMatch = html.match(/Carton\s*Size[^<]*<[^>]*>([^<]+)/i);
  const cartonWeightMatch = html.match(/Carton\s*Weight[^<]*<[^>]*>([^<]+)/i);

  // 重量
  const weightMatch = html.match(/Weight[^<]*<[^>]*>\s*([\d.]+)\s*(kg|g)/i);
  let weight_g = 0;
  if (weightMatch) {
    weight_g = parseFloat(weightMatch[1]) * (weightMatch[2] === "kg" ? 1000 : 1);
  }

  return {
    page_type: "detail",
    offerId: productId,
    offer_title: title,
    detail_url: `https://en.yiwugo.com/product/detail/${productId}.html`,
    price_text: priceText,
    min_order_qty: parseInt((moqMatch?.[1] || "1").replace(/,/g, ""), 10),
    unit: moqMatch?.[2] || "piece",
    shop_name: normalize(companyMatch?.[1] || ""),
    shop_phone: normalize(phoneMatch?.[1] || ""),
    shop_email: emailMatch?.[1] || "",
    image_urls: images.slice(0, 15),
    image_count: images.length,
    source_attributes: attrs,
    attr_count: attrs.length,
    weight_g,
    carton_size: normalize(cartonMatch?.[1] || ""),
    carton_weight: normalize(cartonWeightMatch?.[1] || ""),
    platform: "yiwugo",
  };
}

// ── 公开API ──

export async function searchYiwugo(keyword, page = 1) {
  const url = `${SEARCH_URL}?keyword=${encodeURIComponent(keyword)}&cpage=${page}`;
  const html = await fetchHtml(url);
  return parseSearchHtml(html, keyword);
}

export async function detailYiwugo(productId) {
  const url = `${DETAIL_URL}/${productId}.html`;
  const html = await fetchHtml(url);
  return parseDetailHtml(html, productId);
}

/**
 * 批量搜索+详情（与1688的collect1688ByMobile同构）
 */
export async function collectYiwugo(seeds, options = {}) {
  const { perKeywordLimit = 8, detailLimit = 12, pacingMs = 2000 } = options;

  console.log("[yiwugo] 义乌购采集 (纯HTTP, 无需登录)");

  const searchAttempts = [];
  const allCandidates = [];

  for (const [i, seed] of seeds.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, pacingMs));

    try {
      // 义乌购用英文关键词效果更好，但中文也能搜
      console.log(`[${i + 1}/${seeds.length}] 搜索: ${seed.keyword}`);
      const items = await searchYiwugo(seed.keyword);

      searchAttempts.push({ keyword: seed.keyword, page_type: "search", card_count: items.length });
      console.log(`[${i + 1}/${seeds.length}] "${seed.keyword}" -> ${items.length} 个商品`);

      for (const item of items.slice(0, perKeywordLimit)) {
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
  const deduped = allCandidates.filter(c => { if (!c.offerId || seen.has(c.offerId)) return false; seen.add(c.offerId); return true; });
  const shortlisted = deduped.slice(0, detailLimit);
  console.log(`[yiwugo] 搜索完成: ${allCandidates.length}个 -> ${deduped.length}去重 -> ${shortlisted.length}个进入详情`);

  // 抓详情
  const offers = [];
  for (const [i, candidate] of shortlisted.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    try {
      const detail = await detailYiwugo(candidate.offerId);
      const title = normalize(detail.offer_title || candidate.title).slice(0, 50);
      console.log(`[detail] ${i + 1}/${shortlisted.length} ${title}`);
      offers.push({ ...candidate, ...detail, source_url: candidate.offerUrl });
    } catch (error) {
      console.error(`[detail] ${candidate.offerId} 失败: ${error.message}`);
      offers.push({ ...candidate, source_url: candidate.offerUrl });
    }
  }

  console.log(`[yiwugo] 完成: ${offers.length} 个商品数据`);

  return {
    runtime: { mode: "yiwugo-http", storageStateExists: false, bootstrapSource: "none", browserProfileDir: "" },
    rawCards: deduped,
    searchAttempts,
    searchPool: deduped,
    offers,
    detailIssues: [],
    captchaSkippedKeywords: [],
    async close() {},
  };
}
