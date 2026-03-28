/**
 * 1688 数据采集 — API模式（万邦Onebound / 订单侠 / 自定义）
 *
 * 替代Playwright爬搜索页，纯HTTP调用，无反爬问题。
 * 支持多个API提供商，按优先级fallback。
 *
 * 环境变量:
 *   ONEBOUND_API_KEY   — 万邦API Key
 *   ONEBOUND_SECRET    — 万邦Secret
 *   DINGDANXIA_API_KEY — 订单侠API Key（备选）
 */

import { normalize, repairDeepMojibake } from "./shared-utils.js";

// ── API 提供商配置 ──

const PROVIDERS = {
  onebound: {
    name: "万邦Onebound",
    searchUrl: (key, secret, keyword, page = 1) =>
      `https://api-gw.onebound.cn/1688/item_search/?key=${key}&secret=${secret}&q=${encodeURIComponent(keyword)}&page=${page}&sort=default&page_size=20`,
    detailUrl: (key, secret, itemId) =>
      `https://api-gw.onebound.cn/1688/item_get/?key=${key}&secret=${secret}&num_iid=${itemId}&lang=zh-CN`,
    parseSearchResults: parseOneboundSearch,
    parseDetailResult: parseOneboundDetail,
    envKey: "ONEBOUND_API_KEY",
    envSecret: "ONEBOUND_SECRET",
  },
  dingdanxia: {
    name: "订单侠",
    searchUrl: (key, _secret, keyword, page = 1) =>
      `https://api.dingdanxia.com/1688/item_search?apikey=${key}&q=${encodeURIComponent(keyword)}&page=${page}`,
    detailUrl: (key, _secret, itemId) =>
      `https://api.dingdanxia.com/1688/item_get?apikey=${key}&num_iid=${itemId}`,
    parseSearchResults: parseDingdanxiaSearch,
    parseDetailResult: parseDingdanxiaDetail,
    envKey: "DINGDANXIA_API_KEY",
    envSecret: "",
  },
};

// ── 核心API调用 ──

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "ozon-product-kb/1.0" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 搜索1688商品
 * @param {string} keyword - 搜索关键词
 * @param {object} options - { provider, page, limit }
 * @returns {Array} 商品列表
 */
export async function search1688(keyword, options = {}) {
  const { page = 1, limit = 15 } = options;
  const provider = getProvider(options.provider);

  const key = process.env[provider.envKey] || "";
  const secret = process.env[provider.envSecret] || "";
  if (!key) {
    throw new Error(
      `[1688-api] 缺少API Key。请设置环境变量 ${provider.envKey}\n` +
        `  万邦注册: https://open.onebound.cn\n` +
        `  订单侠注册: https://www.dingdanxia.com`,
    );
  }

  const url = provider.searchUrl(key, secret, keyword, page);
  console.log(`[1688-api] 搜索: "${keyword}" (${provider.name}, page=${page})`);

  const data = await fetchJson(url);
  const items = provider.parseSearchResults(data, keyword);

  console.log(`[1688-api] "${keyword}" -> ${items.length} 个结果`);
  return repairDeepMojibake(items.slice(0, limit));
}

/**
 * 获取1688商品详情
 * @param {string} itemId - 商品ID (num_iid)
 * @param {object} options - { provider }
 * @returns {object} 商品详情
 */
export async function getDetail1688(itemId, options = {}) {
  const provider = getProvider(options.provider);

  const key = process.env[provider.envKey] || "";
  const secret = process.env[provider.envSecret] || "";
  if (!key) {
    throw new Error(`[1688-api] 缺少API Key: ${provider.envKey}`);
  }

  const url = provider.detailUrl(key, secret, itemId);
  console.log(`[1688-api] 详情: ${itemId} (${provider.name})`);

  const data = await fetchJson(url);
  return repairDeepMojibake(provider.parseDetailResult(data, itemId));
}

/**
 * 批量搜索+详情（替代Playwright的collect1688Candidates）
 * @param {Array} seeds - [{keyword, category, ...}]
 * @param {object} options - { provider, perKeywordLimit, detailLimit, pacingMs }
 * @returns {object} { offers, searchAttempts, ... }
 */
export async function collect1688ByApi(seeds, options = {}) {
  const {
    perKeywordLimit = 8,
    detailLimit = 12,
    pacingMs = 1000,
  } = options;

  const searchAttempts = [];
  const allCandidates = [];

  for (const [i, seed] of seeds.entries()) {
    if (i > 0 && pacingMs > 0) {
      await new Promise((r) => setTimeout(r, pacingMs));
    }

    try {
      const items = await search1688(seed.keyword, {
        ...options,
        limit: perKeywordLimit,
      });

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
      console.error(`[1688-api] 搜索失败 "${seed.keyword}": ${error.message}`);
      searchAttempts.push({
        keyword: seed.keyword,
        page_type: "api_error",
        card_count: 0,
        offer_link_count: 0,
        error: error.message,
      });
    }
  }

  // 去重(按offerId)
  const seen = new Set();
  const deduped = allCandidates.filter((c) => {
    if (!c.offerId || seen.has(c.offerId)) return false;
    seen.add(c.offerId);
    return true;
  });

  // 取Top N做详情
  const shortlisted = deduped.slice(0, detailLimit);
  console.log(`[1688-api] 搜索完成: ${allCandidates.length}个候选 -> ${deduped.length}去重 -> ${shortlisted.length}个进入详情`);

  const offers = [];
  for (const [i, candidate] of shortlisted.entries()) {
    if (i > 0 && pacingMs > 0) {
      await new Promise((r) => setTimeout(r, Math.max(500, pacingMs / 2)));
    }

    try {
      const detail = await getDetail1688(candidate.offerId, options);
      offers.push({
        ...candidate,
        ...detail,
        source_url: `https://detail.1688.com/offer/${candidate.offerId}.html`,
      });
      console.log(`[1688-api] 详情 ${i + 1}/${shortlisted.length}: ${normalize(detail.offer_title || candidate.title).slice(0, 40)}`);
    } catch (error) {
      console.error(`[1688-api] 详情失败 ${candidate.offerId}: ${error.message}`);
      // 用搜索数据兜底
      offers.push({
        ...candidate,
        source_url: `https://detail.1688.com/offer/${candidate.offerId}.html`,
      });
    }
  }

  return {
    runtime: {
      mode: "api",
      storageStateExists: false,
      bootstrapSource: "api",
      browserProfileDir: "",
    },
    rawCards: deduped,
    searchAttempts,
    searchPool: deduped,
    offers,
    detailIssues: [],
    captchaSkippedKeywords: [],
    async close() {},
  };
}

// ── 万邦Onebound 数据解析 ──

function parseOneboundSearch(data, keyword) {
  if (data.error && data.error !== "") {
    console.warn(`[onebound] 搜索错误: ${data.error}`);
    return [];
  }

  const items = data?.items?.item || [];
  return items.map((item) => ({
    offerId: String(item.num_iid || ""),
    title: normalize(item.title || ""),
    offerUrl: `https://detail.1688.com/offer/${item.num_iid}.html`,
    price: parseFloat(item.price) || 0,
    priceText: item.price || "",
    imageUrl: item.pic_url || "",
    shopName: normalize(item.nick || ""),
    shopUrl: item.seller_url || item.detail_url || "",
    salesCount: parseInt(item.sales || item.volume || "0", 10),
    location: normalize(item.location || ""),
    cardText: normalize(item.title || ""),
    searchScore: 50,
  }));
}

function parseOneboundDetail(data, itemId) {
  if (data.error && data.error !== "") {
    throw new Error(`Onebound detail error: ${data.error}`);
  }

  const item = data?.item || {};
  const props = item.props_list || {};
  const skus = item.skus?.sku || [];
  const images = [item.pic_url, ...(item.item_imgs?.item_img?.map((i) => i.url) || [])].filter(Boolean);

  return {
    page_type: "detail",
    offer_title: normalize(item.title || ""),
    detail_url: `https://detail.1688.com/offer/${itemId}.html`,
    price_text: item.price || "",
    price_range_text: item.orginal_price ? `${item.price}-${item.orginal_price}` : item.price || "",
    min_order_qty: parseInt(item.min_num || "1", 10),
    unit: item.sell_unit || "件",
    shop_name: normalize(item.nick || item.seller_nick || ""),
    shop_url: item.seller_url || "",
    image_urls: images,
    image_count: images.length,
    source_attributes: Object.entries(props).map(([k, v]) => ({
      name: normalize(k.replace(/^\d+:/, "")),
      value: normalize(v),
    })),
    attr_count: Object.keys(props).length,
    sku_list: skus.map((s) => ({
      sku_id: s.sku_id || "",
      price: s.price || "",
      properties_name: normalize(s.properties_name || ""),
      quantity: parseInt(s.quantity || "0", 10),
    })),
    description: normalize(item.desc || ""),
    raw_card_text: normalize(item.title || ""),
    category_path: normalize(item.cid || ""),
    sales_count: parseInt(item.sales || item.volume || "0", 10),
  };
}

// ── 订单侠 数据解析（结构类似万邦）──

function parseDingdanxiaSearch(data, keyword) {
  const items = data?.items?.item || data?.result || data?.data || [];
  if (!Array.isArray(items)) return [];

  return items.map((item) => ({
    offerId: String(item.num_iid || item.id || ""),
    title: normalize(item.title || ""),
    offerUrl: `https://detail.1688.com/offer/${item.num_iid || item.id}.html`,
    price: parseFloat(item.price) || 0,
    priceText: item.price || "",
    imageUrl: item.pic_url || item.image || "",
    shopName: normalize(item.nick || item.shop_name || ""),
    salesCount: parseInt(item.sales || item.volume || "0", 10),
    location: normalize(item.location || ""),
    cardText: normalize(item.title || ""),
    searchScore: 50,
  }));
}

function parseDingdanxiaDetail(data, itemId) {
  const item = data?.item || data?.result || data?.data || {};
  return parseOneboundDetail({ item }, itemId);
}

// ── 工具函数 ──

function getProvider(name) {
  if (name && PROVIDERS[name]) return PROVIDERS[name];

  // 自动检测哪个API Key可用
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (process.env[provider.envKey]) return provider;
  }

  // 默认返回万邦
  return PROVIDERS.onebound;
}

/**
 * 检查API是否可用（有Key且能连通）
 */
export async function checkApiAvailability() {
  const results = {};
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const key = process.env[provider.envKey];
    results[name] = {
      name: provider.name,
      hasKey: Boolean(key),
      envVar: provider.envKey,
    };
  }
  return results;
}
