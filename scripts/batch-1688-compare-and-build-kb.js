import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import path from "node:path";
import crypto from "node:crypto";
import {
  ensureDir,
  getWorkflowPaths,
  listProductRecords,
  parseArgs,
  readJson,
  writeJson,
} from "./merchant-workflow-lib.js";
import { convertWeightToKg, normalize, compactText, parseNumber } from "./shared-utils.js";
import { repairDeepMojibake } from "./shared-utils.js";
import { ensureHostsDirectConnection, extractHostname, gotoWithProxyFallback } from "./browser-network.js";
import { buildKnowledgeBaseSkeleton, refreshKnowledgeBaseArtifacts } from "./product-kb-workflow-lib.js";

const PROFILE_ROOT = path.resolve(".profiles", "1688");
const STORAGE_STATE_PATH = path.join(PROFILE_ROOT, "storage-state.json");
const BROWSER_PROFILE_DIR = path.join(PROFILE_ROOT, "browser-user-data");
const LEGACY_STORAGE_STATE_PATH = path.resolve(".profiles", "alphashop", "storage-state.json");
const DEFAULT_LIMIT = 3;
const DEFAULT_TOP_N = 3;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_AFTER_GOTO_WAIT_MS = 3000;
const CAPTCHA_TIMEOUT_MS = 300000;
const SEARCH_PACING_BASE_MS = 6500;
const SEARCH_PACING_JITTER_MS = 2500;
const DETAIL_PACING_BASE_MS = 4500;
const DETAIL_PACING_JITTER_MS = 1800;
const RECORD_PACING_BASE_MS = 9000;
const RECORD_PACING_JITTER_MS = 3000;
const LOGIN_SIGNAL_RE =
  /登录|密码登录|短信登录|扫码登录|免费注册|忘记密码|点击刷新|提交反馈|登录页面|FAIL_SYS_SESSION_EXPIRED|User not login in/i;
const CAPTCHA_SIGNAL_RE =
  /验证码拦截|拖动下方滑块|请按住滑块|通过验证以确保正常访问|请拖动下方滑块完成验证|点我反馈|captcha/i;
const GENERIC_TITLE_RE = /^(旺旺在线|找相似|验厂报告|全球领先的采购批发平台,批发网|阿里巴巴|1688)$/i;
const GENERIC_SHOP_RE = /^(找相似|验厂报告|客服|关注|商品)$/i;
const NOISY_CATEGORY_RE = /关注|客服|商品|入驻|店铺|回头率|好评率|Load|start|retry|Play|登录|密码登录|滑块|拖动到最右边|点我反馈|反馈/i;
const BLOCKED_HREF_RE = /similar_search|fcaReport|survey\.|javascript:|login|signin|passport|member\/signin/i;
const BLOCKED_IMAGE_RE = /\.svg(?:$|\?)|avatar|icon|logo|55-tps|sprite|-2-tps-|gw\.alicdn\.com\/imgextra/i;
const MARKETPLACE_COOKIE_DOMAIN_RE = /(^|\.)1688\.com$|(^|\.)taobao\.com$|(^|\.)alibaba\.com$/i;

const ATTRIBUTE_KEY_MAP = [
  [/品牌|brand/i, "brand"],
  [/型号|model/i, "model"],
  [/货号|款号|商家编码|vendor/i, "vendor_code"],
  [/条码|ean|upc|gtin|barcode/i, "barcode"],
  [/材质|面料|成分|material/i, "material"],
  [/颜色|color/i, "color"],
  [/尺寸|规格|尺码|size/i, "size"],
  [/适用车型|适用机型|compatible/i, "compatible_models"],
  [/适用对象|适用宠物|适用人群/i, "applicable_target"],
  [/风格|style/i, "style"],
  [/功能|feature/i, "feature"],
  [/电源方式|供电方式|power/i, "power_supply"],
  [/产地|country/i, "country_of_origin"],
  [/装箱数|箱规|package/i, "package_quantity"],
  [/净重|重量|weight/i, "weight_raw"],
  [/包装尺寸|尺寸规格|package size/i, "package_size_raw"],
];

function encodeKeywordFor1688(keyword) {
  const normalized = String(keyword || "");
  if (!normalized) return "";
  if (process.platform !== "win32") {
    return encodeURIComponent(normalized);
  }

  try {
    const escaped = normalized.replace(/'/g, "''");
    const encoded = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Web; [System.Web.HttpUtility]::UrlEncode('${escaped}', [System.Text.Encoding]::GetEncoding(936))`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    return encoded || encodeURIComponent(normalized);
  } catch {
    return encodeURIComponent(normalized);
  }
}

function tokenizeTerms(...values) {
  const raw = values
    .map((value) => normalize(value).toLowerCase())
    .filter(Boolean)
    .join(" ");
  const terms = raw.match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{3,}/gi) || [];
  return Array.from(new Set(terms)).slice(0, 12);
}

function numericPriceFromText(value) {
  const numbers = String(value || "")
    .replace(/[,，]/g, ".")
    .match(/\d+(?:\.\d+)?/g);
  if (!numbers?.length) return 0;
  return parseNumber(numbers[0], 0);
}

function parseMinOrderQty(text) {
  const input = String(text || "");
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:个|件|只|条|套|包|箱|双|张|卷|台|pcs?|piece)\s*(?:起批|起订|起售|起拍)?/i,
    /(\d+(?:\.\d+)?)\s*(?:起批|起订|起售|起拍)/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return parseNumber(match[1], 0);
  }
  return 0;
}

function deriveDetailUrl(candidate = {}) {
  const direct = normalize(candidate.offerUrl || candidate.offerHref || "");
  if (/detail\.1688\.com\/offer\/\d+\.html/i.test(direct)) {
    return direct;
  }
  const offerId = String(candidate.offerId || "").trim();
  if (offerId) {
    return `https://detail.1688.com/offer/${offerId}.html`;
  }
  const fromHref = direct.match(/offerId=(\d+)/i);
  if (fromHref?.[1]) {
    return `https://detail.1688.com/offer/${fromHref[1]}.html`;
  }
  const fromOfferIds = direct.match(/offerIds?=(\d+)/i);
  if (fromOfferIds?.[1]) {
    return `https://detail.1688.com/offer/${fromOfferIds[1]}.html`;
  }
  return "";
}

function isBlockedHref(value) {
  return BLOCKED_HREF_RE.test(String(value || ""));
}

function cleanImageUrl(value) {
  const url = normalize(value);
  if (!/^https?:/i.test(url)) return "";
  if (BLOCKED_IMAGE_RE.test(url)) return "";
  return url;
}

function looksGenericTitle(value) {
  const text = normalize(value);
  return !text || GENERIC_TITLE_RE.test(text) || LOGIN_SIGNAL_RE.test(text);
}

function looksGenericShopName(value) {
  const text = normalize(value);
  return !text || GENERIC_SHOP_RE.test(text) || LOGIN_SIGNAL_RE.test(text);
}

function scoreTextCandidate(value, preferredTerms = []) {
  const text = normalize(value);
  if (!text) return -100;
  if (looksGenericTitle(text)) return -80;

  let score = 0;
  if (/[\u4e00-\u9fff]/.test(text)) score += 4;
  if (text.length >= 6 && text.length <= 80) score += 6;
  if (text.length > 120) score -= 8;
  if (/公司|商行|工厂|有限公司/.test(text)) score -= 4;
  if (/[0-9]/.test(text)) score += 1;

  for (const term of preferredTerms) {
    const normalizedTerm = normalize(term).toLowerCase();
    if (normalizedTerm && text.toLowerCase().includes(normalizedTerm)) {
      score += Math.min(10, normalizedTerm.length * 2);
    }
  }
  return score;
}

function pickBestText(candidates = [], preferredTerms = [], fallback = "") {
  const scored = candidates
    .map((value) => ({ value: normalize(value), score: scoreTextCandidate(value, preferredTerms) }))
    .filter((item) => item.value);

  scored.sort((left, right) => right.score - left.score);
  if (scored[0] && scored[0].score > 0) {
    return scored[0].value;
  }
  return normalize(fallback);
}

function sanitizeCategoryPath(value, fallback = "") {
  const items = normalize(value)
    .split(/\s*>\s*/)
    .map((item) => normalize(item))
    .filter(Boolean)
    .filter((item) => !NOISY_CATEGORY_RE.test(item))
    .filter((item) => !/%|^\d+(?:\.\d+)?$/.test(item))
    .slice(0, 6);

  if (items.length >= 1) {
    return items.join(" > ");
  }
  return normalize(fallback);
}

function buildCleanDescription(record, primaryOffer, base) {
  const product = record?.product || {};
  const attrs = primaryOffer?.normalizedAttributes || {};
  const parts = [
    normalize(product?.why_it_can_sell || ""),
    attrs.material ? `材质：${attrs.material}` : "",
    attrs.size ? `规格：${attrs.size}` : "",
    attrs.color ? `颜色：${attrs.color}` : "",
    attrs.style ? `风格：${attrs.style}` : "",
    attrs.applicable_target ? `适用对象：${attrs.applicable_target}` : "",
  ].filter(Boolean);

  const description = compactText(parts.join("；"), 600);
  return description || base.description;
}

function buildCleanBulletPoints(record, primaryOffer, base) {
  const product = record?.product || {};
  const attrs = primaryOffer?.normalizedAttributes || {};
  const points = [
    normalize(product?.why_it_can_sell || ""),
    attrs.material ? `material: ${attrs.material}` : "",
    attrs.size ? `size: ${attrs.size}` : "",
    attrs.color ? `color: ${attrs.color}` : "",
    attrs.style ? `style: ${attrs.style}` : "",
    attrs.country_of_origin ? `country_of_origin: ${attrs.country_of_origin}` : "",
    product?.seasonality ? `seasonality: ${product.seasonality}` : "",
  ]
    .map((item) => compactText(item, 120))
    .filter(Boolean)
    .filter((item) => !LOGIN_SIGNAL_RE.test(item));

  const unique = Array.from(new Set(points));
  return unique.length >= 2 ? unique.slice(0, 6) : base.bullet_points;
}

function isLikelyProductPage(detail) {
  if (!detail) return false;
  if (detail.page_type === "login") return false;
  const attributeCount =
    (Array.isArray(detail.attributePairs) ? detail.attributePairs.length : 0) +
    (Array.isArray(detail.source_attributes) ? detail.source_attributes.length : 0) +
    (detail.normalizedAttributes && typeof detail.normalizedAttributes === "object"
      ? Object.keys(detail.normalizedAttributes).length
      : 0);
  const imageCount =
    (Array.isArray(detail.imageUrls) ? detail.imageUrls.length : 0) +
    (Array.isArray(detail.images) ? detail.images.length : 0) +
    (normalize(detail.main_image || "") ? 1 : 0);
  const hasUsefulAttrs = attributeCount >= 3;
  const hasUsefulImages = imageCount >= 1;
  return hasUsefulAttrs || hasUsefulImages;
}

function candidateKey(candidate = {}) {
  return normalize(candidate.shopUrl || candidate.shopName || candidate.offerUrl || candidate.offerId || "");
}

function scoreCandidate(candidate, searchTerms) {
  const haystack = normalize(`${candidate.title} ${candidate.shopName} ${candidate.cardText}`).toLowerCase();
  let score = 0;
  for (const term of searchTerms) {
    if (haystack.includes(String(term).toLowerCase())) {
      score += term.length >= 3 ? 10 : 4;
    }
  }
  if (candidate.price > 0) score += 4;
  if (candidate.minOrderQty > 0) score += 3;
  if (candidate.imageUrl) score += 2;
  if (candidate.offerUrl) score += 4;
  return score;
}

function detectPageType(title = "", body = "", signals = {}) {
  const bundle = normalize(`${title} ${body}`);
  if (CAPTCHA_SIGNAL_RE.test(bundle)) return "captcha";
  if (LOGIN_SIGNAL_RE.test(bundle) && !signals.hasProductSignals) return "login";
  return "normal";
}

async function readSearchPageState(page) {
  const snapshot = await page.evaluate(() => {
    const body = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const title = String(document.title || "").trim();
    const cardCount = document.querySelectorAll(".search-offer-item, .major-offer").length;
    const offerLinkCount = document.querySelectorAll('a[href*="offerId="], a[href*="detail.1688.com/offer/"]').length;
    return { title, body, cardCount, offerLinkCount };
  });

  const pageType = detectPageType(snapshot.title, snapshot.body);
  return {
    ...snapshot,
    page_type: pageType === "normal" ? "search" : pageType,
  };
}

async function waitForCaptchaClear(page, label, timeoutMs = CAPTCHA_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastState = { title: "", body: "", cardCount: 0, page_type: "captcha" };

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(2000);
    lastState = await readSearchPageState(page);
    if (lastState.page_type !== "captcha") {
      return { resolved: true, state: lastState };
    }
  }

  console.warn(`[captcha] timed out while waiting for manual verification on ${label}`);
  return { resolved: false, state: lastState };
}

function randomBetween(min, max) {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

async function waitWithHumanPacing(page, baseMs, jitterMs = 0) {
  const waitMs = baseMs + (jitterMs > 0 ? randomBetween(0, jitterMs) : 0);
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
  return waitMs;
}

async function persistStorageState(context, storageStatePath) {
  if (!context || !storageStatePath) return;
  await context.storageState({ path: storageStatePath }).catch(() => {});
}

async function readStorageStateSafe(storageStatePath) {
  const parsed = await readJson(storageStatePath, null);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function countMarketplaceCookies(storageState) {
  return safeArray(storageState?.cookies).filter((cookie) =>
    MARKETPLACE_COOKIE_DOMAIN_RE.test(String(cookie?.domain || "")),
  ).length;
}

async function hasSavedStorageState(storageStatePath) {
  const parsed = await readStorageStateSafe(storageStatePath);
  return countMarketplaceCookies(parsed) > 0;
}

async function ensure1688BootstrapState() {
  await ensureDir(PROFILE_ROOT);
  const current = await readStorageStateSafe(STORAGE_STATE_PATH);
  if (countMarketplaceCookies(current) > 0) {
    return { state: current, source: STORAGE_STATE_PATH };
  }

  const legacy = await readStorageStateSafe(LEGACY_STORAGE_STATE_PATH);
  if (countMarketplaceCookies(legacy) > 0) {
    await writeJson(STORAGE_STATE_PATH, legacy);
    return { state: legacy, source: LEGACY_STORAGE_STATE_PATH };
  }

  return { state: null, source: "" };
}

async function seedContextFromStorageState(context, storageState) {
  const cookies = safeArray(storageState?.cookies).filter(
    (cookie) =>
      cookie &&
      typeof cookie.name === "string" &&
      typeof cookie.value === "string" &&
      typeof cookie.domain === "string",
  );
  if (!cookies.length) return;
  await context.addCookies(cookies).catch(() => {});
}

function isProfileInUseError(error) {
  const message = String(error || "");
  return /user data dir(?:ectory)? is already in use|existing browser session|Singleton/i.test(message);
}

async function isBrowserProfileLocked(browserProfileDir) {
  const lockNames = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];
  for (const name of lockNames) {
    try {
      await fs.access(path.join(browserProfileDir, name));
      return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function launch1688Runtime(headless) {
  const launchOptions = {
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  };

  await ensureDir(path.dirname(STORAGE_STATE_PATH));
  await ensureDir(BROWSER_PROFILE_DIR);

  const bootstrap = await ensure1688BootstrapState();
  const storageStateExists = countMarketplaceCookies(bootstrap.state) > 0;

  if (!(await isBrowserProfileLocked(BROWSER_PROFILE_DIR))) {
    for (const channel of ["msedge", "chrome"]) {
      try {
        const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
          ...launchOptions,
          ...contextOptions,
          channel,
        });
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", {
            configurable: true,
            get: () => undefined,
          });
          window.chrome = window.chrome || { runtime: {} };
        });
        if (storageStateExists) {
          await seedContextFromStorageState(context, bootstrap.state);
          await persistStorageState(context, STORAGE_STATE_PATH);
        }
        return {
          browser: null,
          context,
          mode: "persistent",
          storageStateExists,
          bootstrapSource: bootstrap.source,
        };
      } catch (error) {
        if (isProfileInUseError(error)) {
          break;
        }
      }
    }
  }

  const browser = await chromium.launch({
    channel: "msedge",
    ...launchOptions,
  }).catch(() => chromium.launch(launchOptions));
  const fallbackContext = await browser.newContext({
    ...contextOptions,
    storageState: storageStateExists ? bootstrap.state : undefined,
  });
  await fallbackContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
    window.chrome = window.chrome || { runtime: {} };
  });
  return {
    browser,
    context: fallbackContext,
    mode: "storage-state",
    storageStateExists,
    bootstrapSource: bootstrap.source,
  };
}

async function openSearchPage(page, keyword) {
  const encodedKeyword = encodeKeywordFor1688(keyword);
  const url = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodedKeyword}`;
  await ensureHostsDirectConnection([extractHostname(url), "1688.com", "taobao.com", "alibaba.com"]);
  await gotoWithProxyFallback(page, url, {
    waitUntil: "domcontentloaded",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    afterGotoWaitMs: DEFAULT_AFTER_GOTO_WAIT_MS + 1000,
    retryDelayMs: 5000,
    attempts: 2,
    hosts: [extractHostname(url), "1688.com"],
  });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2500);
  return readSearchPageState(page);
}

async function collectSearchCandidates(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const blockedText = /找相似|验厂报告|旺旺在线|客服|关注|登录|提交反馈|密码登录|短信登录|点击刷新/;
    const blockedHref = /similar_search|fcaReport|survey\.|javascript:|login|signin|passport|member\/signin/i;
    const relaxedOfferHref = /javascript:|login|signin|passport|member\/signin/i;
    const cards = Array.from(document.querySelectorAll(".search-offer-item, .major-offer"));
    return cards.slice(0, 20).map((card, index) => {
      const anchors = [
        card.tagName === "A" ? card : null,
        ...Array.from(card.querySelectorAll("a")),
      ].filter(Boolean);
      const cardHref = card.tagName === "A" ? card.href || "" : "";
      const offerAnchor =
        anchors.find((item) => {
          const href = item.href || "";
          return /offerId=|offerIds=|detail\.1688\.com\/offer\//i.test(href) && !relaxedOfferHref.test(href);
        }) || null;
      const offerHref = offerAnchor?.href || cardHref || "";
      const shopLink =
        anchors.find((item) => {
          const text = clean(item.textContent);
          const href = item.href || "";
          return /\.1688\.com/i.test(href) && !/detail\.1688\.com/i.test(href) && !blockedHref.test(href) && text.length >= 2 && !blockedText.test(text);
        }) ||
        null;
      const titleNode =
        card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='subject'], [class*='desc']") || null;
      const image = card.querySelector("img");
      const priceNode =
        card.querySelector('[class*="price"]') ||
        card.querySelector(".price-now") ||
        card.querySelector(".offer-price");
      const titleCandidates = [
        clean(titleNode?.textContent || ""),
        clean(offerAnchor?.textContent || ""),
        clean(image?.getAttribute("alt") || ""),
      ].filter((text) => text && !blockedText.test(text) && text.length >= 4);
      return {
        index,
        title: titleCandidates[0] || "",
        offerUrl: offerHref,
        shopName: clean(shopLink?.textContent || ""),
        shopUrl: shopLink?.href || "",
        imageUrl:
          image?.getAttribute("data-lazy-src") ||
          image?.getAttribute("data-src") ||
          image?.getAttribute("src") ||
          "",
        priceText: clean(priceNode?.textContent || ""),
        cardText: clean(card.textContent || ""),
      };
    });
  });
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function mapAttributeKey(rawKey) {
  const key = normalize(rawKey);
  for (const [pattern, mapped] of ATTRIBUTE_KEY_MAP) {
    if (pattern.test(key)) return mapped;
  }
  return "";
}

function parseDimensions(rawValue) {
  const normalized = String(rawValue || "").replace(/[×xX＊*]/g, "x");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  if (!match) {
    return { length: 0, width: 0, height: 0 };
  }
  return {
    length: parseNumber(match[1], 0),
    width: parseNumber(match[2], 0),
    height: parseNumber(match[3], 0),
  };
}

function normalizeAttributes(attributePairs = []) {
  const attributes = {};
  for (const pair of attributePairs) {
    const sourceKey = normalize(pair.key);
    const sourceValue = normalize(pair.value);
    if (!sourceKey || !sourceValue) continue;
    const mapped = mapAttributeKey(sourceKey);
    if (!mapped) continue;
    if (mapped === "compatible_models") {
      const models = sourceValue.split(/[、,，/]/).map((item) => normalize(item)).filter(Boolean);
      if (models.length) attributes[mapped] = Array.from(new Set(models));
      continue;
    }
    attributes[mapped] = sourceValue;
  }
  return attributes;
}

function buildBulletPointsFromOffer(offer) {
  const items = [];
  if (offer?.title) items.push(offer.title);
  const attributes = offer?.normalizedAttributes || {};
  for (const [key, value] of Object.entries(attributes)) {
    if (Array.isArray(value)) {
      items.push(`${key}: ${value.join(", ")}`);
    } else if (value) {
      items.push(`${key}: ${value}`);
    }
  }
  if (offer?.minOrderQty > 0) items.push(`min_order_qty: ${offer.minOrderQty}`);
  return Array.from(new Set(items.map((item) => compactText(item, 120)).filter(Boolean))).slice(0, 6);
}

async function scrapeDetailPage(page, url) {
  await ensureHostsDirectConnection([extractHostname(url), "detail.1688.com", "1688.com", "taobao.com", "alibaba.com"]);
  await gotoWithProxyFallback(page, url, {
    waitUntil: "domcontentloaded",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    afterGotoWaitMs: DEFAULT_AFTER_GOTO_WAIT_MS + 500,
    retryDelayMs: 5000,
    attempts: 2,
    hosts: [extractHostname(url), "detail.1688.com", "1688.com"],
  });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2500);

  const detail = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const titleCandidates = [
      clean(document.querySelector("h1")?.textContent || ""),
      clean(document.title || ""),
      clean(document.querySelector('meta[property=\"og:title\"]')?.getAttribute("content") || ""),
      clean(document.querySelector('meta[name=\"keywords\"]')?.getAttribute("content") || ""),
    ].filter(Boolean);
    const title =
      titleCandidates[0] || "";
    const bodyText = clean(document.body?.innerText || "");
    const imageUrls = Array.from(document.querySelectorAll("img"))
      .map((img) => img.getAttribute("data-lazy-src") || img.getAttribute("data-src") || img.getAttribute("src") || "")
      .map((value) => clean(value))
      .filter((value) => /^https?:/i.test(value) && !/avatar|icon|logo|55-tps|sprite|\.svg(?:$|\?)/i.test(value))
      .slice(0, 20);

    const breadcrumb = Array.from(document.querySelectorAll("a, span"))
      .map((node) => clean(node.textContent))
      .filter((text) => text && text.length <= 20)
      .slice(0, 20);

    const pairs = [];
    const pushPair = (key, value) => {
      const cleanKey = clean(key);
      const cleanValue = clean(value);
      if (!cleanKey || !cleanValue) return;
      pairs.push({ key: cleanKey, value: cleanValue });
    };

    Array.from(document.querySelectorAll("table tr")).forEach((row) => {
      const cells = Array.from(row.querySelectorAll("th,td")).map((cell) => clean(cell.textContent));
      if (cells.length >= 2) {
        for (let index = 0; index + 1 < cells.length; index += 2) {
          pushPair(cells[index], cells[index + 1]);
        }
      }
    });

    Array.from(document.querySelectorAll("li, dt, dd")).forEach((node) => {
      const text = clean(node.textContent || "");
      const match = text.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
      if (match) {
        pushPair(match[1], match[2]);
      }
    });

    const priceNodes = Array.from(document.querySelectorAll('[class*="price"], .price, .price-now, .offer-price'))
      .map((node) => clean(node.textContent || ""))
      .filter(Boolean);

    const hasProductSignals =
      (titleCandidates.length > 0 && (imageUrls.length >= 1 || pairs.length >= 1)) ||
      /商品属性|包装信息|评价|颜色|规格|库存|运费/i.test(bodyText);

    const pageType = "detail";

    return {
      page_type: pageType,
      title,
      titleCandidates,
      bodyText,
      imageUrls,
      breadcrumb,
      attributePairs: pairs,
      priceText: priceNodes[0] || "",
      bodySnippet: bodyText.slice(0, 5000),
      hasProductSignals,
    };
  });
  const repaired = repairDeepMojibake(detail);
  const pageType = detectPageType(repaired.title, repaired.bodyText, repaired);
  return {
    ...repaired,
    page_type: pageType === "normal" ? "detail" : pageType,
  };
}

function buildOfferSummary(rawOffer, detail) {
  const normalizedAttributes = normalizeAttributes(detail.attributePairs);
  const packageDimensions = parseDimensions(
    normalizedAttributes.package_size_raw ||
      normalizedAttributes.size ||
      rawOffer.cardText,
  );
  const weight = convertWeightToKg(
    normalizedAttributes.weight_raw || rawOffer.cardText,
    normalizedAttributes.weight_raw || rawOffer.cardText,
  );
  const images = Array.from(
    new Set(
      [rawOffer.imageUrl, ...detail.imageUrls]
        .map((item) => normalize(item))
        .filter(Boolean),
    ),
  ).slice(0, 10);

  return {
    source_platform: "1688",
    source_url: deriveDetailUrl(rawOffer),
    offer_title: normalize(rawOffer.title || detail.title || ""),
    shop_name: normalize(rawOffer.shopName || ""),
    shop_url: normalize(rawOffer.shopUrl || ""),
    price: numericPriceFromText(detail.priceText || rawOffer.priceText),
    price_text: detail.priceText || rawOffer.priceText,
    currency: "CNY",
    min_order_qty: parseMinOrderQty(`${detail.bodySnippet || ""} ${detail.priceText || ""} ${rawOffer.cardText || ""}`),
    main_image: images.find(Boolean) || "",
    images: images.map(cleanImageUrl).filter(Boolean),
    image_count: images.length,
    image_hash: crypto.createHash("sha1").update(images.join("|")).digest("hex"),
    category_path: detail.breadcrumb.join(" > "),
    description: compactText(detail.bodySnippet, 1200),
    source_attributes: detail.attributePairs,
    normalizedAttributes,
    package_dimensions_cm: packageDimensions,
    weight_kg: weight,
    page_type: detail.page_type || "detail",
    title_candidates: detail.titleCandidates || [],
    raw_search_title: normalize(rawOffer.title || ""),
    raw_search_shop_name: normalize(rawOffer.shopName || ""),
  };
}

function buildKnowledgeBase(record, offers) {
  const base = buildKnowledgeBaseSkeleton(record);
  const primary = offers[0] || null;
  const prices = offers.map((item) => Number(item.price || 0)).filter((value) => value > 0);
  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;
  const priceAvg = prices.length
    ? Number((prices.reduce((sum, value) => sum + value, 0) / prices.length).toFixed(2))
    : 0;
  const attributes = primary?.normalizedAttributes || {};
  const dimensions = primary?.package_dimensions_cm || {
    length: base.length,
    width: base.width,
    height: base.height,
  };

  const productTerms = tokenizeTerms(record?.product?.name, record?.product?.category, record?.product?.why_it_can_sell);
  const cleanedImages = safeArray(primary?.images).map(cleanImageUrl).filter(Boolean);
  const cleanedTitle = pickBestText(
    [
      ...(safeArray(primary?.title_candidates)),
      normalize(primary?.raw_search_title || ""),
      normalize(base.title_cn || ""),
    ],
    productTerms,
    base.title_cn,
  );
  const cleanedShopName = looksGenericShopName(primary?.raw_search_shop_name)
    ? ""
    : normalize(primary?.raw_search_shop_name || "");
  const cleanedBrand =
    normalize(attributes.brand || "") && !/^(是|否|可以|不可以|无|未知)$/i.test(normalize(attributes.brand || ""))
      ? normalize(attributes.brand)
      : "";
  const cleanedVendorCode =
    normalize(attributes.vendor_code || "") && !/^(是|否|可以|不可以)$/i.test(normalize(attributes.vendor_code || ""))
      ? normalize(attributes.vendor_code)
      : base.vendor_code;
  const cleanedCategoryPath = sanitizeCategoryPath(primary?.category_path || "", base.category_path);

  return {
    ...base,
    generated_at: new Date().toISOString(),
    source_url: primary?.source_url || "",
    source_platform_urls: offers.map((item) => item.source_url).filter(Boolean),
    brand: cleanedBrand,
    model: normalize(attributes.model || ""),
    vendor_code: cleanedVendorCode,
    barcode: normalize(attributes.barcode || ""),
    title_cn: cleanedTitle,
    description: buildCleanDescription(record, primary, base),
    bullet_points: buildCleanBulletPoints(record, primary, base),
    price: primary?.price || base.price,
    old_price: priceMax > (primary?.price || 0) ? priceMax : 0,
    currency: "CNY",
    stock: null,
    min_order_qty: primary?.min_order_qty || 0,
    package_quantity: parseNumber(attributes.package_quantity, base.package_quantity),
    weight: primary?.weight_kg || base.weight,
    length: dimensions.length || base.length,
    width: dimensions.width || base.width,
    height: dimensions.height || base.height,
    category_path: cleanedCategoryPath,
    category_id_source: "",
    ozon_category_id: "",
    attributes: {
      ...base.attributes,
      ...Object.fromEntries(
        Object.entries(attributes).filter(([key]) => !["brand", "model", "vendor_code", "barcode", "package_quantity", "weight_raw", "package_size_raw", "country_of_origin"].includes(key)),
      ),
    },
    main_image: cleanImageUrl(primary?.main_image || "") || cleanedImages[0] || "",
    images: cleanedImages,
    image_count: cleanedImages.length,
    image_hash: cleanedImages.length ? crypto.createHash("sha1").update(cleanedImages.join("|")).digest("hex") : "",
    dangerous_goods: base.dangerous_goods,
    country_of_origin: normalize(attributes.country_of_origin || base.country_of_origin),
    competitor_offers: offers.map((offer) => ({
      ...offer,
      offer_title: pickBestText(
        [...safeArray(offer.title_candidates), offer.raw_search_title, base.title_cn],
        productTerms,
        base.title_cn,
      ),
      shop_name: looksGenericShopName(offer.raw_search_shop_name) ? "" : normalize(offer.raw_search_shop_name || ""),
      category_path: sanitizeCategoryPath(offer.category_path || "", base.category_path),
      images: safeArray(offer.images).map(cleanImageUrl).filter(Boolean),
      main_image: cleanImageUrl(offer.main_image || ""),
    })),
    comparison_summary: {
      compared_at: new Date().toISOString(),
      candidate_count: offers.length,
      selected_offer_source_url: primary?.source_url || "",
      price_min: priceMin,
      price_max: priceMax,
      price_avg: priceAvg,
      notes: [
        ...(offers.length >= 3 ? [] : ["Less than 3 comparable 1688 offers were captured."]),
        ...(primary?.page_type === "login" ? ["Detail page hit login flow; fell back to cleaner inferred fields."] : []),
      ],
    },
    data_quality: {
      title_source: cleanedTitle === normalize(base.title_cn || "") ? "source-analysis" : "web-detail-or-search",
      description_source: buildCleanDescription(record, primary, base) === base.description ? "source-analysis" : "web-augmented",
      web_detail_valid: isLikelyProductPage(primary),
      inferred_fields: [
        ...(cleanedTitle === normalize(base.title_cn || "") ? ["title_cn"] : []),
        ...(cleanedCategoryPath === normalize(base.category_path || "") ? ["category_path"] : []),
      ],
    },
  };
}

function buildBlockedReasons(knowledgeBase) {
  const reasons = [];
  if (!knowledgeBase?.data_quality?.web_detail_valid) reasons.push("invalid_detail_page");
  if (!normalize(knowledgeBase?.source_url || "")) reasons.push("missing_source_url");
  if (!(normalize(knowledgeBase?.main_image || "") || safeArray(knowledgeBase?.images).length > 0)) reasons.push("missing_media");
  if (safeArray(knowledgeBase?.competitor_offers).length < 3) reasons.push("less_than_three_competitors");
  if (!normalize(knowledgeBase?.comparison_summary?.selected_offer_source_url || "")) reasons.push("missing_selected_offer");
  if (!Number(knowledgeBase?.price || 0)) reasons.push("missing_price");
  return Array.from(new Set(reasons));
}

function isKnowledgeBaseReady(knowledgeBase) {
  return buildBlockedReasons(knowledgeBase).length === 0;
}

function selectRecords(records, args, filters = {}) {
  const requestedSlugs = new Set(safeArray(args.slug ? [args.slug] : []).concat(safeArray(args.slugs)));
  const runSlugSet = new Set(safeArray(filters.slugs));
  const analysisPathFilter = normalize(filters.analysisPath || "");
  const includeBlocked = Boolean(args["include-blocked"] || args.retry || args["retry-blocked"]);
  const allowExplicitRerun =
    requestedSlugs.size > 0 && Boolean(args.force || args.rebuild || args.retry || args["include-blocked"]);
  let pending = records.filter((record) => {
    const stage = normalize(record?.workflow?.current_stage || "");
    if (stage === "supplier_compare_pending") return true;
    if (includeBlocked && stage === "supplier_compare_blocked") return true;
    if (allowExplicitRerun && requestedSlugs.has(normalize(record?.slug || "")) && stage !== "rejected") {
      return true;
    }
    return false;
  });

  if (analysisPathFilter) {
    pending = pending.filter(
      (record) => normalize(record?.source?.analysis_path || "") === analysisPathFilter,
    );
  }

  if (runSlugSet.size > 0) {
    pending = pending.filter((record) => runSlugSet.has(normalize(record?.slug || "")));
  }

  if (!requestedSlugs.size) return pending;
  return pending.filter((record) => requestedSlugs.has(record.slug));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildRunFilters(runManifest) {
  const analysisPath = normalize(runManifest?.analysisPath || "");
  const slugs = safeArray(runManifest?.slugs)
    .map((slug) => normalize(slug))
    .filter(Boolean);
  return {
    analysisPath,
    pipeline: normalize(runManifest?.pipeline || "product-kb"),
    slugs,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = getWorkflowPaths(process.cwd());
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : DEFAULT_LIMIT;
  const topN = Number.isFinite(Number(args["top-n"])) ? Math.max(1, Number(args["top-n"])) : DEFAULT_TOP_N;
  const headless = Boolean(args.headless);
  const keepOpen = Boolean(args["keep-open"]);
  const runManifestPath =
    normalize(args["manifest-path"] || "") || path.join(paths.outputDir, "latest-product-kb-run.json");
  const runManifest = await readJson(runManifestPath, null);
  const runFilters = buildRunFilters(runManifest);

  const productEntries = await listProductRecords(paths.productsDir);
  const records = productEntries.map(({ record }) => repairDeepMojibake(record));
  const chosen = args.all
    ? selectRecords(records, args, runFilters)
    : selectRecords(records, args, runFilters).slice(0, limit);
  const runtime = await launch1688Runtime(headless);
  const { browser, context, mode: runtimeMode, storageStateExists, bootstrapSource = "" } = runtime;
  const summary = {
    startedAt: new Date().toISOString(),
    runtimeMode,
    storageStatePath: STORAGE_STATE_PATH,
    browserProfileDir: BROWSER_PROFILE_DIR,
    storageStateExistsAtLaunch: storageStateExists,
    bootstrapSource,
    processed: [],
    blocked: [],
    skipped: [],
    failed: [],
  };

  try {
    for (const [recordIndex, record] of chosen.entries()) {
      const comparePlan = repairDeepMojibake(await readJson(record.paths.compare_plan_path, null));
      const keywords = safeArray(comparePlan?.search_keywords).filter(Boolean);
      if (!keywords.length) {
        summary.skipped.push({ slug: record.slug, reason: "no_search_keywords" });
        continue;
      }

      const searchPage = await context.newPage();
      const detailPage = await context.newPage();
      try {
        const searchCandidates = [];
        const searchTerms = tokenizeTerms(record?.product?.name, record?.product?.category, ...keywords);
        const compareIssues = [];
        const searchAttempts = [];

        for (const [keywordIndex, keyword] of keywords.slice(0, 3).entries()) {
          if (keywordIndex > 0) {
            await waitWithHumanPacing(searchPage, SEARCH_PACING_BASE_MS, SEARCH_PACING_JITTER_MS);
          }
          let searchPageState = await openSearchPage(searchPage, keyword);
          await persistStorageState(context, STORAGE_STATE_PATH);
          searchAttempts.push({
            keyword,
            page_type: searchPageState?.page_type || "",
            card_count: Number(searchPageState?.cardCount || 0),
            offer_link_count: Number(searchPageState?.offerLinkCount || 0),
            title: normalize(searchPageState?.title || ""),
            body_snippet: compactText(searchPageState?.body || "", 160),
          });
          if (searchPageState?.page_type === "captcha") {
            compareIssues.push("captcha_challenge_search");
            if (!headless) {
              console.log(
                `[captcha] 1688 search for "${keyword}" requires manual verification. Solve it in the browser window; waiting up to ${Math.round(CAPTCHA_TIMEOUT_MS / 1000)}s...`,
              );
              const waitResult = await waitForCaptchaClear(searchPage, `search:${keyword}`);
              if (waitResult.resolved) {
                searchPageState = waitResult.state;
                compareIssues.pop();
                await persistStorageState(context, STORAGE_STATE_PATH);
                searchAttempts.push({
                  keyword: `${keyword} [after-captcha]`,
                  page_type: searchPageState?.page_type || "",
                  card_count: Number(searchPageState?.cardCount || 0),
                  offer_link_count: Number(searchPageState?.offerLinkCount || 0),
                  title: normalize(searchPageState?.title || ""),
                  body_snippet: compactText(searchPageState?.body || "", 160),
                });
              } else {
                break;
              }
            } else {
              break;
            }
          }
          if (searchPageState?.page_type === "login") {
            compareIssues.push("search_login_required");
            continue;
          }
          const rawCards = repairDeepMojibake(await collectSearchCandidates(searchPage));
          if (!rawCards.length && Number(searchPageState?.offerLinkCount || 0) > 0) {
            compareIssues.push("search_selector_mismatch");
          }
          if (!rawCards.length && searchPageState?.page_type === "search") {
            compareIssues.push("search_zero_candidates");
          }
          for (const card of rawCards) {
            const offerId =
              String(card.offerUrl || "").match(/offer\/(\d+)\.html/i)?.[1] ||
              String(card.offerUrl || "").match(/offerId=(\d+)/i)?.[1] ||
              String(card.offerUrl || "").match(/offerIds=(\d+)/i)?.[1] ||
              "";
            const price = numericPriceFromText(card.priceText || card.cardText);
            searchCandidates.push({
              ...card,
              offerId,
              price,
              minOrderQty: parseMinOrderQty(card.cardText),
              keyword,
            });
          }
        }

        const shortlisted = dedupeCandidates(
          searchCandidates
            .map((candidate) => ({
              ...candidate,
              offerUrl: deriveDetailUrl(candidate),
              score: scoreCandidate(candidate, searchTerms),
            }))
            .filter((candidate) => candidate.offerUrl),
        )
          .sort((left, right) => right.score - left.score)
          .slice(0, topN);

        const offers = [];
        for (const [offerIndex, candidate] of shortlisted.entries()) {
          if (offerIndex > 0) {
            await waitWithHumanPacing(detailPage, DETAIL_PACING_BASE_MS, DETAIL_PACING_JITTER_MS);
          }
          const detail = await scrapeDetailPage(detailPage, candidate.offerUrl);
          await persistStorageState(context, STORAGE_STATE_PATH);
          if (detail.page_type === "captcha") {
            compareIssues.push("captcha_challenge_detail");
            if (!headless) {
              console.log(
                `[captcha] 1688 detail page for "${record.product?.name || record.slug}" requires manual verification. Solve it in the browser window; waiting up to ${Math.round(CAPTCHA_TIMEOUT_MS / 1000)}s...`,
              );
              const waitResult = await waitForCaptchaClear(detailPage, `detail:${candidate.offerUrl}`);
              if (waitResult.resolved) {
                compareIssues.pop();
                await persistStorageState(context, STORAGE_STATE_PATH);
                const retriedDetail = await scrapeDetailPage(detailPage, candidate.offerUrl);
                if (retriedDetail.page_type === "detail") {
                  offers.push(buildOfferSummary(candidate, retriedDetail));
                } else {
                  compareIssues.push(`detail_${retriedDetail.page_type}`);
                }
              }
            }
            continue;
          }
          if (detail.page_type === "login") {
            compareIssues.push("detail_login_required");
            continue;
          }
          offers.push(buildOfferSummary(candidate, detail));
        }

        const knowledgeBase = buildKnowledgeBase(record, offers);
        const blockedReasons = Array.from(
          new Set([...compareIssues, ...buildBlockedReasons(knowledgeBase)].filter(Boolean)),
        );
        const isReady = isKnowledgeBaseReady(knowledgeBase);
        const gatedKnowledgeBase = isReady
          ? knowledgeBase
          : {
              ...knowledgeBase,
              blocked_reasons: blockedReasons,
            };
        const compareSummary = {
          slug: record.slug,
          compared_at: new Date().toISOString(),
          candidate_count: offers.length,
          selected_offer_source_url: knowledgeBase.comparison_summary.selected_offer_source_url,
          shortlist: offers.map((offer, index) => ({
            rank: index + 1,
            source_url: offer.source_url,
            shop_name: looksGenericShopName(offer.raw_search_shop_name) ? "" : normalize(offer.raw_search_shop_name || offer.shop_name || ""),
            offer_title: pickBestText([...safeArray(offer.title_candidates), offer.raw_search_title, record?.product?.name], tokenizeTerms(record?.product?.name, record?.product?.category), record?.product?.name || ""),
            price: offer.price,
            min_order_qty: offer.min_order_qty,
          })),
          search_attempts: searchAttempts,
          notes: Array.from(new Set([...(knowledgeBase.comparison_summary.notes || []), ...compareIssues])),
        };

        const blockedSnapshotPath = path.join(paths.blockedArtifactsDir, record.slug, "ozon-knowledge.blocked.json");
        record.workflow.current_stage = isReady ? "knowledge_base_ready" : "supplier_compare_blocked";
        record.workflow.updated_at = new Date().toISOString();
        record.research.compare_status = isReady ? "completed" : "blocked";
        record.research.compared_at = new Date().toISOString();
        record.research.shortlist_count = offers.length;
        record.research.last_error = isReady ? "" : blockedReasons.join(", ");
        record.research.blocked_snapshot_path = isReady ? "" : blockedSnapshotPath;
        record.knowledge_base = isReady ? knowledgeBase : null;

        await writeJson(record.paths.competitor_offers_path, offers);
        await writeJson(record.paths.compare_summary_path, compareSummary);
        if (isReady) {
          await writeJson(record.paths.knowledge_base_path, knowledgeBase);
        } else {
          await ensureDir(path.dirname(blockedSnapshotPath));
          await writeJson(blockedSnapshotPath, gatedKnowledgeBase);
          await fs.unlink(record.paths.knowledge_base_path).catch(() => {});
        }
        await writeJson(record.paths.product_json, record);

        const summaryEntry = {
          slug: record.slug,
          candidateCount: offers.length,
          compareSummaryPath: record.paths.compare_summary_path,
        };
        if (isReady) {
          summary.processed.push({
            ...summaryEntry,
            knowledgeBasePath: record.paths.knowledge_base_path,
          });
        } else {
          summary.blocked.push({
            ...summaryEntry,
            blockedReasons,
            blockedSnapshotPath,
          });
        }
      } catch (error) {
        record.research.compare_status = "failed";
        record.research.last_error = String(error?.message || error);
        record.workflow.updated_at = new Date().toISOString();
        await writeJson(record.paths.product_json, record);
        summary.failed.push({
          slug: record.slug,
          error: String(error?.message || error),
        });
      } finally {
        await persistStorageState(context, STORAGE_STATE_PATH);
        await searchPage.close().catch(() => {});
        await detailPage.close().catch(() => {});
      }
      if (recordIndex < chosen.length - 1) {
        await waitWithHumanPacing(context.pages()[0] || { waitForTimeout: async () => {} }, RECORD_PACING_BASE_MS, RECORD_PACING_JITTER_MS);
      }
    }
  } finally {
    if (!keepOpen) {
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  await refreshKnowledgeBaseArtifacts(paths, runFilters);
  summary.finishedAt = new Date().toISOString();
  summary.runManifestPath = runManifestPath;
  summary.runFilters = runFilters;
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
