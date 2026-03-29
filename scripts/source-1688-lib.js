import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  compactText,
  convertWeightToKg,
  ensureDir,
  normalize,
  parseNumber,
  readJson,
  repairDeepMojibake,
  writeJson,
} from "./shared-utils.js";
import { ensureHostsDirectConnection, extractHostname, gotoWithProxyFallback } from "./browser-network.js";

const PROFILE_ROOT = path.resolve(".profiles", "1688");
const STORAGE_STATE_PATH = path.join(PROFILE_ROOT, "storage-state.json");
const BROWSER_PROFILE_DIR = path.join(PROFILE_ROOT, "browser-user-data");
const LEGACY_STORAGE_STATE_PATH = path.resolve(".profiles", "alphashop", "storage-state.json");
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_AFTER_GOTO_WAIT_MS = 3000;
const CAPTCHA_TIMEOUT_MS = 300000;

const LOGIN_SIGNAL_RE =
  /登录|密码登录|短信登录|扫码登录|免费注册|忘记密码|点击刷新|提交反馈|登录页面|FAIL_SYS_SESSION_EXPIRED|User not login in/i;
const CAPTCHA_SIGNAL_RE =
  /验证码拦截|拖动下方滑块|请按住滑块|通过验证以确保正常访问|请拖动下方滑块完成验证|点击反馈|captcha/i;
const GENERIC_TITLE_RE =
  /^(旺旺在线|找相似|验厂报告|全球领先的采购批发平台|阿里巴巴|1688)$/i;
const BLOCKED_HREF_RE =
  /similar_search|fcaReport|survey\.|javascript:|login|signin|passport|member\/signin/i;
const BLOCKED_IMAGE_RE =
  /\.svg(?:$|\?)|avatar|icon|logo|55-tps|sprite|-2-tps-|gw\.alicdn\.com\/imgextra/i;
const MARKETPLACE_COOKIE_DOMAIN_RE =
  /(^|\.)1688\.com$|(^|\.)taobao\.com$|(^|\.)alibaba\.com$/i;
const QUANTITY_TITLE_RE = /^(?:[¥￥]?\d+(?:\.\d+)?(?:[~\-]\d+(?:\.\d+)?)?|≥\d+(?:\.\d+)?)(?:个|件|只|包|箱|套|条|双|袋|卷|盒|把|米)?$/;
const COMPANY_TITLE_RE = /(有限公司|有限责任公司|商行|经营部|工厂|制品厂|贸易有限公司|电子商务有限公司|塑料制品厂|汽车用品有限公司|日用品有限公司|日用品厂)$/;

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
  [/毛重|净重|重量|件重|weight/i, "weight_raw"],
];

const GENERIC_COMPANY_SUFFIX_RE =
  /(?:\u6709\u9650\u516c\u53f8|\u8d23\u4efb\u516c\u53f8|\u5de5\u5382|\u5382|\u5546\u884c|\u7535\u5b50\u5546\u52a1|\u4f01\u4e1a|\u65d7\u8230\u5e97)$/u;
const RANGE_ONLY_TITLE_RE =
  /^\d+(?:\.\d+)?(?:\s*[~\-]\s*\d+(?:\.\d+)?)?\s*(?:\u4e2a|\u4ef6|\u53ea|\u53f0|\u5957|\u6761|\u888b|\u7bb1|\u5377|\u5f20)\s*$/u;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function randomBetween(min, max) {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

export function waitWithHumanPacing(page, baseMs, jitterMs = 0) {
  const waitMs = baseMs + (jitterMs > 0 ? randomBetween(0, jitterMs) : 0);
  return page.waitForTimeout(waitMs);
}

export function encodeKeywordFor1688(keyword) {
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

export function tokenizeTerms(...values) {
  const raw = values
    .map((value) => normalize(value).toLowerCase())
    .filter(Boolean)
    .join(" ");
  const terms = raw.match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{3,}/gi) || [];
  return Array.from(new Set(terms)).slice(0, 16);
}

export function numericPriceFromText(value) {
  const numbers = String(value || "")
    .replace(/[,，]/g, ".")
    .match(/\d+(?:\.\d+)?/g);
  if (!numbers?.length) return 0;
  return parseNumber(numbers[0], 0);
}

export function parseMinOrderQty(text) {
  const input = String(text || "");
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:个|件|条|套|箱|包|盒|pcs?|piece)\s*(?:起批|起订|起售|起拍)?/i,
    /(\d+(?:\.\d+)?)\s*(?:起批|起订|起售|起拍)/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return parseNumber(match[1], 0);
  }
  return 0;
}

export function parseSalesCount(text) {
  const input = normalize(text);
  const patterns = [
    /成交\s*(\d+(?:\.\d+)?)\s*(万)?/i,
    /(\d+(?:\.\d+)?)\s*(万)?\s*(?:笔成交|人付款|件成交|成交)/i,
    /已售\s*(\d+(?:\.\d+)?)\s*(万)?/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (!match) continue;
    const base = Number(match[1] || 0);
    if (!Number.isFinite(base) || base <= 0) continue;
    return match[2] ? Math.round(base * 10000) : Math.round(base);
  }

  return 0;
}

export function deriveDetailUrl(candidate = {}) {
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

export function cleanImageUrl(value) {
  const url = normalize(value);
  if (!/^https?:/i.test(url)) return "";
  if (BLOCKED_IMAGE_RE.test(url)) return "";
  return url;
}

function cleanOfferTitleCandidate(value) {
  return normalize(value).replace(/\s*-\s*阿里巴巴.*$/i, "").trim();
}

function looksInvalidOfferTitle(value) {
  const text = cleanOfferTitleCandidate(value);
  if (!text) return true;
  if (QUANTITY_TITLE_RE.test(text)) return true;
  if (COMPANY_TITLE_RE.test(text)) return true;
  if (RANGE_ONLY_TITLE_RE.test(text)) return true;
  if (GENERIC_COMPANY_SUFFIX_RE.test(text)) return true;
  if (/^(登录查看更多优惠|价格|商品|客服|关注)$/i.test(text)) return true;
  return text.length < 6;
}

function pickOfferTitle(rawOffer = {}, detail = {}) {
  const shopName = normalize(rawOffer.shopName || "");
  const candidates = [
    ...safeArray(detail.titleCandidates),
    detail.title,
    rawOffer.title,
  ]
    .map((item) => cleanOfferTitleCandidate(item))
    .filter(Boolean);

  const preferred = candidates.find(
    (item) => !looksInvalidOfferTitle(item) && (!shopName || normalize(item) !== shopName),
  );
  if (preferred) return preferred;
  return "";
}

function extractWeightSource(normalizedAttributes = {}, detail = {}, rawOffer = {}) {
  const explicit = normalize(normalizedAttributes.weight_raw || "");
  if (explicit) return explicit;

  const bundle = normalize(`${detail.bodySnippet || ""} ${rawOffer.cardText || ""}`);
  const patterns = [
    /(毛重|净重|重量|件重)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(kg|千克|公斤|g|克)?/i,
    /重量\s*\(g\)\s*(\d+(?:\.\d+)?)/i,
    /重量\s*\(kg\)\s*(\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = bundle.match(pattern);
    if (!match) continue;
    const value = match[2] || match[1];
    const unit = match[3] || (pattern.source.includes("(g)") ? "g" : "");
    return `${value}${unit}`;
  }

  return "";
}

function looksGenericTitle(value) {
  const text = normalize(value);
  return !text || GENERIC_TITLE_RE.test(text) || LOGIN_SIGNAL_RE.test(text);
}

function candidateKey(candidate = {}) {
  return normalize(candidate.offerId || candidate.offerUrl || candidate.shopUrl || candidate.title);
}

export function dedupeCandidates(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of safeArray(candidates)) {
    const key = candidateKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

export function scoreSearchCandidate(candidate, searchTerms = []) {
  const haystack = normalize(
    `${candidate.title} ${candidate.shopName} ${candidate.cardText} ${(candidate.keywords || []).join(" ")}`,
  ).toLowerCase();

  let score = 0;
  for (const term of searchTerms) {
    const normalizedTerm = String(term || "").toLowerCase();
    if (normalizedTerm && haystack.includes(normalizedTerm)) {
      score += normalizedTerm.length >= 3 ? 10 : 4;
    }
  }

  if (candidate.price > 0) score += 4;
  if (candidate.minOrderQty > 0) score += 3;
  if (candidate.imageUrl) score += 2;
  if (candidate.offerUrl) score += 4;
  if (/源头|工厂|厂家|现货|一件代发/.test(candidate.cardText || "")) score += 6;
  if (/热销|爆款|热卖/.test(candidate.cardText || "")) score += 10;
  if (candidate.salesCount > 100) score += 8;
  if (candidate.salesCount > 1000) score += 12;
  if (candidate.salesCount > 10000) score += 16;
  if (looksGenericTitle(candidate.title)) score -= 12;
  return score;
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

export function normalizeAttributes(attributePairs = []) {
  const attributes = {};
  for (const pair of attributePairs) {
    const sourceKey = normalize(pair.key);
    const sourceValue = normalize(pair.value);
    if (!sourceKey || !sourceValue) continue;
    const mapped = mapAttributeKey(sourceKey);
    if (!mapped) continue;
    if (mapped === "compatible_models") {
      const models = sourceValue
        .split(/[、,，/]/)
        .map((item) => normalize(item))
        .filter(Boolean);
      if (models.length) attributes[mapped] = Array.from(new Set(models));
      continue;
    }
    attributes[mapped] = sourceValue;
  }
  return attributes;
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
    const offerLinkCount = document.querySelectorAll(
      'a[href*="offerId="], a[href*="detail.1688.com/offer/"]',
    ).length;
    return { title, body, cardCount, offerLinkCount };
  });

  const pageType = detectPageType(snapshot.title, snapshot.body);
  return {
    ...snapshot,
    page_type: pageType === "normal" ? "search" : pageType,
  };
}

export async function waitForCaptchaClear(page, label, timeoutMs = CAPTCHA_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastState = { title: "", body: "", cardCount: 0, page_type: "captcha" };

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(2000);
    try {
      lastState = await readSearchPageState(page);
    } catch (error) {
      // 页面导航（验证通过后跳转）会销毁执行上下文，这是正常的
      if (/context was destroyed|navigation|frame was detached/i.test(String(error))) {
        await page.waitForTimeout(2000);
        try {
          lastState = await readSearchPageState(page);
        } catch {
          // 页面仍在加载，继续等
          continue;
        }
      } else {
        throw error;
      }
    }
    if (lastState.page_type !== "captcha") {
      return { resolved: true, state: lastState };
    }
  }

  console.warn(`[验证码] ${label} 等待超时`);
  return { resolved: false, state: lastState };
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
  return /user data dir(?:ectory)? is already in use|existing browser session|Singleton/i.test(
    message,
  );
}

async function isBrowserProfileLocked(browserProfileDir) {
  const lockNames = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];
  for (const name of lockNames) {
    try {
      await fs.access(path.join(browserProfileDir, name));
      return true;
    } catch {
      // Ignore.
    }
  }
  return false;
}

/** 注入完整stealth脚本，隐藏headless/自动化特征 */
async function injectStealthScripts(context) {
  await context.addInitScript(() => {
    // 1. 隐藏 webdriver 标记
    Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => undefined });
    delete navigator.__proto__.webdriver;

    // 2. 模拟 chrome 对象
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || { connect: () => {}, sendMessage: () => {} };
    window.chrome.loadTimes = window.chrome.loadTimes || (() => ({}));
    window.chrome.csi = window.chrome.csi || (() => ({}));

    // 3. 修改 permissions API（防止 Notification permission 泄露 headless）
    const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (origQuery) {
      window.navigator.permissions.query = (params) => {
        if (params?.name === "notifications") {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery(params);
      };
    }

    // 4. 修改 plugins 和 mimeTypes（headless 通常为空）
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const fakePlugins = [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
          { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
        ];
        fakePlugins.length = 3;
        fakePlugins.item = (i) => fakePlugins[i];
        fakePlugins.namedItem = (n) => fakePlugins.find((p) => p.name === n);
        fakePlugins.refresh = () => {};
        return fakePlugins;
      },
    });

    // 5. 修改 languages（headless 可能缺失）
    Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en-US", "en"] });
    Object.defineProperty(navigator, "language", { get: () => "zh-CN" });

    // 6. 隐藏 headless 的 connection.rtt（headless 通常为 0）
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, "rtt", { get: () => 100 });
    }

    // 7. 修改 hardwareConcurrency（headless 可能为异常值）
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });

    // 8. WebGL vendor/renderer 伪装
    const getParamOrig = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return "Intel Inc.";           // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
      return getParamOrig.call(this, param);
    };

    // 9. 阻止 iframe contentWindow 检测
    const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    if (origContentWindow) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
        get: function () {
          const win = origContentWindow.get.call(this);
          if (win) {
            try { Object.defineProperty(win.navigator, "webdriver", { get: () => undefined }); } catch {}
          }
          return win;
        },
      });
    }

    // 10. 修改 toString 防止函数检测
    const nativeToString = Function.prototype.toString;
    Function.prototype.toString = function () {
      if (this === Function.prototype.toString) return "function toString() { [native code] }";
      return nativeToString.call(this);
    };
  });
}

export async function launch1688Runtime(headless = false) {
  const launchOptions = {
    headless: false, // 1688能检测headless CDP，始终用有头模式
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

        await injectStealthScripts(context);

        if (storageStateExists) {
          await seedContextFromStorageState(context, bootstrap.state);
          await persistStorageState(context, STORAGE_STATE_PATH);
        }

        return {
          browser: null,
          context,
          mode: "persistent",
          storageStatePath: STORAGE_STATE_PATH,
          browserProfileDir: BROWSER_PROFILE_DIR,
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

  const browser = await chromium
    .launch({
      channel: "msedge",
      ...launchOptions,
    })
    .catch(() => chromium.launch(launchOptions));

  const context = await browser.newContext({
    ...contextOptions,
    storageState: storageStateExists ? bootstrap.state : undefined,
  });

  await injectStealthScripts(context);

  return {
    browser,
    context,
    mode: "storage-state",
    storageStatePath: STORAGE_STATE_PATH,
    browserProfileDir: BROWSER_PROFILE_DIR,
    storageStateExists,
    bootstrapSource: bootstrap.source,
  };
}

export async function openSearchPage(page, keyword) {
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

export async function collectSearchCandidates(page) {
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const blockedText = /找相似|验厂报告|旺旺在线|客服|关注|登录|提交反馈|密码登录|短信登录|点击刷新/;
    const blockedHref = /similar_search|fcaReport|survey\.|javascript:|login|signin|passport|member\/signin/i;
    const relaxedOfferHref = /javascript:|login|signin|passport|member\/signin/i;
    // 扩大卡片选择器覆盖面（1688搜索页DOM经常变动）
    const cardSelectors = [
      ".search-offer-item", ".major-offer",
      "[class*='offer-item']", "[class*='offerItem']",
      "[class*='card-item']", "[class*='cardItem']",
      "[data-offer-id]", "[data-offerid]",
      ".sm-offer-item", ".normalcommon-offer-card",
    ];
    const cards = Array.from(document.querySelectorAll(cardSelectors.join(", ")));
    // 去重（不同选择器可能命中同一个元素）
    const seen = new Set();
    const uniqueCards = cards.filter((el) => { if (seen.has(el)) return false; seen.add(el); return true; });

    return uniqueCards.slice(0, 30).map((card, index) => {
      const anchors = [card.tagName === "A" ? card : null, ...Array.from(card.querySelectorAll("a"))].filter(Boolean);
      const cardHref = card.tagName === "A" ? card.href || "" : "";

      // ── 多策略提取 offer URL ──
      const offerAnchor =
        anchors.find((item) => {
          const href = item.href || "";
          return /offerId=|offerIds=|detail\.1688\.com\/offer\//i.test(href) && !relaxedOfferHref.test(href);
        }) || null;
      let offerHref = offerAnchor?.href || cardHref || "";

      // 策略2: 从data属性提取offerId
      if (!offerHref || !/\d{5,}/.test(offerHref)) {
        const dataOfferId = card.getAttribute("data-offer-id") || card.getAttribute("data-offerid") || "";
        if (/^\d{5,}$/.test(dataOfferId)) {
          offerHref = "https://detail.1688.com/offer/" + dataOfferId + ".html";
        }
      }
      // 策略3: 从所有链接中找含长数字ID的1688链接
      if (!offerHref || !/\d{5,}/.test(offerHref)) {
        const anyOffer = anchors.find((item) => {
          const href = item.href || "";
          return /1688\.com/i.test(href) && /\/\d{8,}\.html|offerId=\d+/i.test(href) && !relaxedOfferHref.test(href);
        });
        if (anyOffer) offerHref = anyOffer.href;
      }
      // 策略4: 从卡片innerHTML中正则提取offer链接
      if (!offerHref || !/\d{5,}/.test(offerHref)) {
        const htmlMatch = card.innerHTML.match(/detail\.1688\.com\/offer\/(\d+)\.html/i) ||
          card.innerHTML.match(/offerId=(\d+)/i);
        if (htmlMatch?.[1]) offerHref = "https://detail.1688.com/offer/" + htmlMatch[1] + ".html";
      }

      const shopLink =
        anchors.find((item) => {
          const text = clean(item.textContent);
          const href = item.href || "";
          return (
            /\.1688\.com/i.test(href) &&
            !/detail\.1688\.com/i.test(href) &&
            !blockedHref.test(href) &&
            text.length >= 2 &&
            !blockedText.test(text)
          );
        }) || null;

      // ── 多策略提取标题 ──
      const titleNode =
        card.querySelector("h1, h2, h3, h4, [class*='title'], [class*='subject'], [class*='desc'], [class*='name']") || null;
      const images = Array.from(card.querySelectorAll("img"));
      const image = images[0] || null;
      const priceNode =
        card.querySelector('[class*="price"]') ||
        card.querySelector(".price-now") ||
        card.querySelector(".offer-price") ||
        card.querySelector('[class*="Price"]');

      const titleCandidates = [
        clean(titleNode?.textContent || ""),
        clean(offerAnchor?.textContent || ""),
        ...images.map((img) => clean(img.getAttribute("alt") || "")),
        clean(card.getAttribute("title") || ""),
        clean(card.getAttribute("aria-label") || ""),
      ].filter((text) => text && !blockedText.test(text) && text.length >= 4);

      // 从cardText中提取可能的产品名（取第一段中文为主的长文本）
      if (titleCandidates.length === 0) {
        const raw = clean(card.textContent || "");
        const segments = raw.split(/[¥￥\d]{3,}/).map((s) => s.trim()).filter((s) => s.length >= 6 && /[\u4e00-\u9fff]{2,}/.test(s));
        if (segments.length > 0) titleCandidates.push(segments[0].slice(0, 80));
      }

      return {
        index,
        title: titleCandidates[0] || "",
        title_candidates: titleCandidates,
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

  return repairDeepMojibake(result);
}

export async function scrapeDetailPage(page, url) {
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
      clean(document.querySelector('meta[property="og:title"]')?.getAttribute("content") || ""),
      clean(document.querySelector('meta[name="keywords"]')?.getAttribute("content") || ""),
    ].filter(Boolean);
    const title = titleCandidates[0] || "";
    const bodyText = clean(document.body?.innerText || "");
    const imageUrls = Array.from(document.querySelectorAll("img"))
      .map(
        (img) =>
          img.getAttribute("data-lazy-src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("src") ||
          "",
      )
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

    const priceNodes = Array.from(
      document.querySelectorAll('[class*="price"], .price, .price-now, .offer-price'),
    )
      .map((node) => clean(node.textContent || ""))
      .filter(Boolean);

    const hasProductSignals =
      (titleCandidates.length > 0 && (imageUrls.length >= 1 || pairs.length >= 1)) ||
      /商品属性|包装信息|评价|颜色|规格|库存|运费/i.test(bodyText);

    return {
      page_type: "detail",
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

export function buildOfferSummary(rawOffer, detail) {
  const normalizedAttributes = normalizeAttributes(detail.attributePairs);
  const packageDimensions = parseDimensions(
    normalizedAttributes.package_size_raw ||
      normalizedAttributes.size ||
      detail.bodySnippet ||
      rawOffer.cardText,
  );
  const weightSource = extractWeightSource(normalizedAttributes, detail, rawOffer);
  const weight = convertWeightToKg(
    weightSource || detail.bodySnippet || rawOffer.cardText,
    weightSource || detail.bodySnippet || rawOffer.cardText,
  );
  const rawImages = Array.from(
    new Set([rawOffer.imageUrl, ...safeArray(detail.imageUrls)].map((item) => normalize(item)).filter(Boolean)),
  ).slice(0, 10);
  const images = rawImages.map(cleanImageUrl).filter(Boolean);

  return {
    source_platform: "1688",
    source_url: deriveDetailUrl(rawOffer),
    offer_id: rawOffer.offerId || "",
    offer_title: pickOfferTitle(rawOffer, detail),
    shop_name: normalize(rawOffer.shopName || ""),
    shop_url: normalize(rawOffer.shopUrl || ""),
    price: numericPriceFromText(detail.priceText || rawOffer.priceText),
    price_text: detail.priceText || rawOffer.priceText,
    currency: "CNY",
    min_order_qty: parseMinOrderQty(
      `${detail.bodySnippet || ""} ${detail.priceText || ""} ${rawOffer.cardText || ""}`,
    ),
    sales_count: Number(rawOffer.salesCount || 0),
    keyword_hits: safeArray(rawOffer.keywords),
    main_image: images[0] || "",
    images,
    image_count: images.length,
    image_hash: crypto.createHash("sha1").update(images.join("|")).digest("hex"),
    category_path: safeArray(detail.breadcrumb).join(" > "),
    description: compactText(detail.bodySnippet, 1200),
    source_attributes: detail.attributePairs,
    normalizedAttributes,
    package_dimensions_cm: packageDimensions,
    weight_kg: weight,
    page_type: detail.page_type || "detail",
    title_candidates: detail.titleCandidates || [],
    raw_search_title: normalize(rawOffer.title || ""),
    raw_search_shop_name: normalize(rawOffer.shopName || ""),
    raw_card_text: normalize(rawOffer.cardText || ""),
  };
}

export async function save1688StorageState(context) {
  await persistStorageState(context, STORAGE_STATE_PATH);
}

export function summarizeSearchCard(card, keyword = "") {
  const offerId =
    String(card.offerUrl || "").match(/offer\/(\d+)\.html/i)?.[1] ||
    String(card.offerUrl || "").match(/offerId=(\d+)/i)?.[1] ||
    String(card.offerUrl || "").match(/offerIds=(\d+)/i)?.[1] ||
    "";
  return {
    ...card,
    offerId,
    offerUrl: deriveDetailUrl({ ...card, offerId }),
    price: numericPriceFromText(card.priceText || card.cardText),
    salesCount: parseSalesCount(card.cardText),
    minOrderQty: parseMinOrderQty(card.cardText),
    keywords: keyword ? [keyword] : [],
  };
}

export const runtimePaths = {
  profileRoot: PROFILE_ROOT,
  storageStatePath: STORAGE_STATE_PATH,
  browserProfileDir: BROWSER_PROFILE_DIR,
};
