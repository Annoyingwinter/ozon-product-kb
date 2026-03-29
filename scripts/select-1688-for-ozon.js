import fs from "node:fs/promises";
import path from "node:path";
import {
  buildOfferSummary,
  collectSearchCandidates,
  dedupeCandidates,
  launch1688Runtime,
  openSearchPage,
  save1688StorageState,
  scoreSearchCandidate,
  scrapeDetailPage,
  summarizeSearchCard,
  tokenizeTerms,
  waitForCaptchaClear,
  waitWithHumanPacing,
} from "./source-1688-lib.js";
import { execFile } from "node:child_process";
import { ensureDir, normalize, readJson, repairDeepMojibake, timestamp, writeJson } from "./shared-utils.js";
import { collect1688ByApi, checkApiAvailability } from "./source-1688-api.js";
import { collect1688ByMobile } from "./source-1688-mobile.js";

// ── 系统通知 & 窗口管理 ──

/** 发送Windows系统通知（验证码提醒） */
function sendCaptchaNotification(keyword) {
  const title = "1688 需要验证";
  const message = `搜索 "${keyword}" 遇到验证码，请在浏览器中拖动滑块完成验证。`;

  // Windows PowerShell toast notification
  const ps = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null;
    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new();
    $xml.LoadXml('<toast duration="long"><visual><binding template="ToastGeneric"><text>${title}</text><text>${message}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>');
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml);
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('1688选品助手').Show($toast);
  `.replace(/\n/g, " ");

  execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 5000 }, (err) => {
    if (err) {
      // fallback: BurntToast 或简单 beep
      execFile("powershell", [
        "-NoProfile", "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${message}', '${title}', 'OK', 'Information') | Out-Null`,
      ], { timeout: 120000 }, () => {});
    }
  });
}

/** 将浏览器窗口置顶 */
async function bringBrowserToFront(page) {
  try {
    await page.bringToFront();
  } catch {}
}

/** 验证码等待超时时间 — 产品级给足时间 */
const CAPTCHA_WAIT_TIMEOUT_MS = 120000; // 2分钟

const DEFAULT_OUTPUT_DIR = path.resolve("output");
const DEFAULT_PLATFORM = "ozon";
const DEFAULT_PROVIDER = "1688";
const DEFAULT_LIMIT = 12;
const DEFAULT_DETAIL_LIMIT = 12;
const DEFAULT_PER_KEYWORD_LIMIT = 8;
const DEFAULT_MAX_KEYWORDS = 8;
const SEARCH_PACING_BASE_MS = 8000;
const SEARCH_PACING_JITTER_MS = 5000;
const DETAIL_PACING_BASE_MS = 3500;
const DETAIL_PACING_JITTER_MS = 1200;
const SEARCH_CAPTCHA_WAIT_MS = 15000;
const DETAIL_CAPTCHA_WAIT_MS = 20000;
const QUANTITY_TITLE_RE = /^(?:[¥￥]?\d+(?:\.\d+)?(?:[~\-]\d+(?:\.\d+)?)?|≥\d+(?:\.\d+)?)(?:个|件|只|包|箱|套|条|双|袋|卷|盒|把|米)?$/;
const COMPANY_TITLE_RE = /(有限公司|有限责任公司|商行|经营部|工厂|制品厂|贸易有限公司|电子商务有限公司|塑料制品厂|汽车用品有限公司|日用品有限公司|日用品厂)$/;

const PLATFORM_DEFAULTS = {
  ozon: {
    marketplace: "Ozon Russia",
    priceMinRub: 1000,
    priceMaxRub: 4000,
    maxWeightKg: 1.2,
    maxLongEdgeCm: 45,
    exchangeRateRubPerCny: 12.5,
    logisticsWeight: 18,
    marginWeight: 22,
    competitionWeight: 14,
    complianceWeight: 14,
    returnWeight: 12,
    contentWeight: 8,
    trendWeight: 6,
    sourceWeight: 6,
  },
};

// ── 大词库：按品类分组，每次运行随机抽取，避免重复 ──
const KEYWORD_POOL = [
  // 汽车用品
  { keyword: "车载缝隙收纳盒", category: "Auto Accessories", target_users: "Car owners", why: "Small, visual, high utility." },
  { keyword: "后备箱收纳网兜", category: "Auto Storage", target_users: "Car owners", why: "Low breakage, broad vehicle fit." },
  { keyword: "车载手机支架 出风口", category: "Auto Accessories", target_users: "Car owners", why: "High repeat demand, universal fit." },
  { keyword: "汽车遮阳挡 前挡", category: "Auto Accessories", target_users: "Car owners", why: "Seasonal demand, lightweight." },
  { keyword: "车载垃圾桶 折叠", category: "Auto Accessories", target_users: "Car owners", why: "Impulse buy, easy to ship." },
  { keyword: "方向盘手机支架", category: "Auto Accessories", target_users: "Car owners", why: "Novel design, easy demo." },
  { keyword: "汽车后座挂钩", category: "Auto Accessories", target_users: "Car owners", why: "Tiny, cheap, high margin." },
  { keyword: "车载香薰 出风口夹", category: "Auto Accessories", target_users: "Car owners", why: "Repeat consumable, visual appeal." },

  // 宠物用品
  { keyword: "宠物粘毛器", category: "Pet Cleaning", target_users: "Pet owners", why: "Strong pain point, repeat demand." },
  { keyword: "宠物饮水器 自动循环", category: "Pet Supplies", target_users: "Pet owners", why: "Trending, high AOV." },
  { keyword: "猫砂铲 漏砂", category: "Pet Supplies", target_users: "Cat owners", why: "Daily necessity, lightweight." },
  { keyword: "宠物牵引绳 伸缩", category: "Pet Supplies", target_users: "Dog owners", why: "Universal demand, many variants." },
  { keyword: "猫抓板 瓦楞纸", category: "Pet Supplies", target_users: "Cat owners", why: "Consumable, repeat purchase." },
  { keyword: "宠物慢食碗", category: "Pet Supplies", target_users: "Pet owners", why: "Trending, visual selling point." },
  { keyword: "狗狗拾便袋", category: "Pet Supplies", target_users: "Dog owners", why: "Consumable, multi-pack upsell." },
  { keyword: "宠物外出水壶", category: "Pet Supplies", target_users: "Dog owners", why: "Portable, good for bundles." },

  // 厨房收纳
  { keyword: "冰箱收纳盒", category: "Kitchen Storage", target_users: "Urban families", why: "Standardized, visual improvement." },
  { keyword: "厨房调料架 旋转", category: "Kitchen Storage", target_users: "Urban families", why: "Space-saving, good visuals." },
  { keyword: "锅盖架 台面", category: "Kitchen Organizer", target_users: "Urban families", why: "Solves common pain point." },
  { keyword: "厨房水槽沥水篮", category: "Kitchen Accessories", target_users: "Urban families", why: "Universal fit, low return." },
  { keyword: "硅胶保鲜盖 万能", category: "Kitchen Accessories", target_users: "Urban families", why: "Consumable, multi-size pack." },
  { keyword: "厨房刀架 壁挂磁吸", category: "Kitchen Organizer", target_users: "Urban families", why: "Premium feel, compact." },
  { keyword: "厨房垃圾袋挂架", category: "Kitchen Accessories", target_users: "Urban families", why: "Tiny, impulse buy." },
  { keyword: "食品封口夹 密封", category: "Kitchen Accessories", target_users: "Urban families", why: "Multi-pack, daily use." },

  // 家居收纳
  { keyword: "抽屉分隔盒", category: "Home Storage", target_users: "Urban families", why: "Lightweight, modular." },
  { keyword: "浴室收纳架 免打孔", category: "Bathroom Storage", target_users: "Renters", why: "Visual before/after demo." },
  { keyword: "衣柜收纳分层隔板", category: "Home Storage", target_users: "Urban families", why: "Easy install, space doubling." },
  { keyword: "鞋柜收纳鞋架 双层", category: "Home Storage", target_users: "Urban families", why: "Space saving, universal." },
  { keyword: "墙壁挂钩 免打孔", category: "Home Storage", target_users: "Renters", why: "Tiny, high margin." },
  { keyword: "衣物压缩袋 真空", category: "Home Storage", target_users: "Urban families", why: "Seasonal demand, multi-pack." },
  { keyword: "桌面收纳盒 化妆品", category: "Home Storage", target_users: "Women", why: "Gift potential, visual appeal." },
  { keyword: "门后挂钩 免钉", category: "Home Storage", target_users: "Renters", why: "Universal, impulse purchase." },

  // 办公/桌面
  { keyword: "桌面理线器", category: "Desk Organizer", target_users: "Office workers", why: "Impulse buy, easy to localize." },
  { keyword: "显示器增高架", category: "Desk Organizer", target_users: "Office workers", why: "Ergonomic trend, good margin." },
  { keyword: "笔记本电脑支架 折叠", category: "Desk Accessories", target_users: "Remote workers", why: "Trending, aluminum premium." },
  { keyword: "桌面文件收纳架", category: "Desk Organizer", target_users: "Office workers", why: "Standardized, easy to ship." },
  { keyword: "手机支架 桌面 可调节", category: "Desk Accessories", target_users: "Everyone", why: "Universal demand, many colors." },

  // 旅行/户外
  { keyword: "旅行鞋袋 收纳", category: "Travel Organizer", target_users: "Travelers", why: "Low return risk, multi-pack." },
  { keyword: "旅行分装瓶 套装", category: "Travel Accessories", target_users: "Travelers", why: "Consumable, TSA-friendly." },
  { keyword: "行李箱收纳袋 压缩", category: "Travel Organizer", target_users: "Travelers", why: "Seasonal + year-round." },
  { keyword: "折叠水杯 硅胶", category: "Travel Accessories", target_users: "Outdoor enthusiasts", why: "Compact, novelty factor." },
  { keyword: "便携式衣架 折叠", category: "Travel Accessories", target_users: "Business travelers", why: "Niche but loyal demand." },
  { keyword: "旅行收纳包 数码", category: "Travel Organizer", target_users: "Tech travelers", why: "Cable mess pain point." },

  // 清洁工具
  { keyword: "窗户清洁刮水器", category: "Cleaning Tools", target_users: "Homeowners", why: "Seasonal, good before/after demo." },
  { keyword: "缝隙清洁刷", category: "Cleaning Tools", target_users: "Homeowners", why: "Solves visible pain point." },
  { keyword: "马桶刷 硅胶 壁挂", category: "Cleaning Tools", target_users: "Homeowners", why: "Upgrade from traditional brush." },
  { keyword: "拖把挤水桶 旋转", category: "Cleaning Tools", target_users: "Homeowners", why: "High AOV, repeat purchase." },
  { keyword: "除霉啫喱 防霉", category: "Cleaning Supplies", target_users: "Homeowners", why: "Consumable, strong visual." },

  // 生活小工具
  { keyword: "迷你封口机 便携", category: "Gadgets", target_users: "Everyone", why: "Novelty, low price impulse buy." },
  { keyword: "自动感应垃圾桶", category: "Home Gadgets", target_users: "Urban families", why: "Smart home trend, good margin." },
  { keyword: "LED灯带 遥控", category: "Home Decor", target_users: "Young adults", why: "Trending, many variations." },
  { keyword: "USB小风扇 桌面", category: "Gadgets", target_users: "Office workers", why: "Seasonal, lightweight." },
  { keyword: "懒人手机支架 床头", category: "Gadgets", target_users: "Young adults", why: "Relatable pain point." },
  { keyword: "电动指甲刀 婴儿", category: "Baby Care", target_users: "New parents", why: "Safety concern drives purchase." },
  { keyword: "自动搅拌杯 磁力", category: "Gadgets", target_users: "Office workers", why: "Novelty gift potential." },

  // 婴幼儿/母婴
  { keyword: "婴儿防撞角 硅胶", category: "Baby Safety", target_users: "New parents", why: "Safety concern, multi-pack." },
  { keyword: "儿童餐盘 硅胶吸盘", category: "Baby Feeding", target_users: "Parents", why: "Repeat purchase, colorful." },
  { keyword: "婴儿指甲剪套装", category: "Baby Care", target_users: "New parents", why: "Gift set potential." },
  { keyword: "奶瓶沥水架", category: "Baby Care", target_users: "New parents", why: "Standardized, low risk." },

  // 运动健身
  { keyword: "瑜伽垫 加厚防滑", category: "Fitness", target_users: "Fitness enthusiasts", why: "Trending, stable demand." },
  { keyword: "筋膜球 按摩", category: "Fitness", target_users: "Fitness enthusiasts", why: "Small, lightweight, high margin." },
  { keyword: "跳绳 计数", category: "Fitness", target_users: "Fitness enthusiasts", why: "Low price, high volume." },
  { keyword: "握力器 可调节", category: "Fitness", target_users: "Fitness enthusiasts", why: "Compact, many variants." },
  { keyword: "运动腰包 跑步", category: "Fitness", target_users: "Runners", why: "Universal fit, lightweight." },

  // 文具/手工
  { keyword: "彩色胶带 和纸胶带", category: "Stationery", target_users: "Students/crafters", why: "Collectible, multi-pack upsell." },
  { keyword: "自粘便签纸 创意", category: "Stationery", target_users: "Office workers", why: "Low cost, repeat purchase." },
  { keyword: "手账贴纸 套装", category: "Stationery", target_users: "Young women", why: "Collectible trend." },
];

// 已用关键词追踪文件（持久化，避免跨次运行重复）
const USED_KEYWORDS_PATH = path.resolve("knowledge-base", ".used-keywords.json");

async function loadUsedKeywords() {
  try {
    return new Set(JSON.parse(await fs.readFile(USED_KEYWORDS_PATH, "utf8")));
  } catch {
    return new Set();
  }
}

async function saveUsedKeywords(used) {
  await fs.writeFile(USED_KEYWORDS_PATH, JSON.stringify([...used], null, 2), "utf8");
}

/** 从大词库中随机抽取未用过的关键词 */
async function pickFreshSeeds(count) {
  const used = await loadUsedKeywords();
  const available = KEYWORD_POOL.filter((s) => !used.has(s.keyword));

  if (available.length === 0) {
    // 所有关键词都用过了，清空重来但打乱顺序
    console.log(`[seeds] 所有 ${KEYWORD_POOL.length} 个关键词都已使用过，重置词库重新开始。`);
    await saveUsedKeywords(new Set());
    return shuffleArray(KEYWORD_POOL).slice(0, count);
  }

  // 从不同品类中均匀抽取
  const byCategory = new Map();
  for (const s of available) {
    const cat = s.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(s);
  }
  // 每个品类打乱
  for (const arr of byCategory.values()) shuffleArray(arr);

  const picked = [];
  const categories = shuffleArray([...byCategory.keys()]);
  let catIndex = 0;
  while (picked.length < count && picked.length < available.length) {
    const cat = categories[catIndex % categories.length];
    const pool = byCategory.get(cat);
    if (pool && pool.length > 0) {
      picked.push(pool.shift());
    }
    catIndex += 1;
    // 如果所有品类都空了就停
    if ([...byCategory.values()].every((arr) => arr.length === 0)) break;
  }

  // 记录已使用
  for (const s of picked) used.add(s.keyword);
  await saveUsedKeywords(used);
  console.log(`[seeds] 从词库抽取 ${picked.length} 个新关键词 (剩余 ${available.length - picked.length}/${KEYWORD_POOL.length})`);
  return picked;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── 去重：加载已调研产品名称用于比对 ──
const KB_PRODUCTS_DIR = path.resolve("knowledge-base", "products");

async function loadExistingProductNames() {
  const names = new Set();
  try {
    const dirs = await fs.readdir(KB_PRODUCTS_DIR);
    for (const d of dirs) {
      try {
        const p = JSON.parse(await fs.readFile(path.join(KB_PRODUCTS_DIR, d, "product.json"), "utf8"));
        const name = normalize(p.product?.name || "");
        if (name) names.add(name);
        // 也存slug用于URL去重
        if (p.slug) names.add(normalize(p.slug));
        // 存source_url用于精确去重
        const url = p.source?.detail_url || p.source?.analysis_path || "";
        if (url) names.add(url);
      } catch {}
    }
  } catch {}
  return names;
}

/** 简单文本相似度（共享字符bigram比例） */
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const bigramsA = new Set();
  const bigramsB = new Set();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let shared = 0;
  for (const bg of bigramsA) if (bigramsB.has(bg)) shared++;
  return (2 * shared) / (bigramsA.size + bigramsB.size);
}

/** 检查候选产品是否和已有KB产品重复 */
function isDuplicateProduct(candidateName, existingNames, threshold = 0.6) {
  const cn = normalize(candidateName);
  if (!cn) return false;
  if (existingNames.has(cn)) return true;
  for (const existing of existingNames) {
    if (textSimilarity(cn, existing) >= threshold) return true;
  }
  return false;
}

function parseArgs(argv) {
  const args = {
    platform: DEFAULT_PLATFORM,
    provider: DEFAULT_PROVIDER,
    outputDir: DEFAULT_OUTPUT_DIR,
    seedFile: "",
    searchSnapshotFile: "",
    keywords: "",
    category: "",
    targetUsers: "",
    productGoal:
      "Use low-cost Chinese wholesale supply to find Ozon-friendly products with lightweight logistics, low after-sales pressure, and stable repeat demand.",
    priceMinRub: undefined,
    priceMaxRub: undefined,
    maxWeightKg: undefined,
    maxLongEdgeCm: undefined,
    limit: DEFAULT_LIMIT,
    detailLimit: DEFAULT_DETAIL_LIMIT,
    perKeywordLimit: DEFAULT_PER_KEYWORD_LIMIT,
    maxKeywords: DEFAULT_MAX_KEYWORDS,
    headless: false,
    keepOpen: false,
    useApi: false,
    apiProvider: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--platform" && next) {
      args.platform = next.toLowerCase();
      index += 1;
    } else if (current === "--provider" && next) {
      args.provider = next.toLowerCase();
      index += 1;
    } else if (current === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      index += 1;
    } else if (current === "--seed-file" && next) {
      args.seedFile = path.resolve(next);
      index += 1;
    } else if (current === "--search-snapshot-file" && next) {
      args.searchSnapshotFile = path.resolve(next);
      index += 1;
    } else if (current === "--keywords" && next) {
      args.keywords = next;
      index += 1;
    } else if (current === "--category" && next) {
      args.category = next;
      index += 1;
    } else if (current === "--target-users" && next) {
      args.targetUsers = next;
      index += 1;
    } else if (current === "--product-goal" && next) {
      args.productGoal = next;
      index += 1;
    } else if (current === "--price-min-rub" && next) {
      args.priceMinRub = Number(next);
      index += 1;
    } else if (current === "--price-max-rub" && next) {
      args.priceMaxRub = Number(next);
      index += 1;
    } else if (current === "--max-weight-kg" && next) {
      args.maxWeightKg = Number(next);
      index += 1;
    } else if (current === "--max-long-edge-cm" && next) {
      args.maxLongEdgeCm = Number(next);
      index += 1;
    } else if (current === "--limit" && next) {
      args.limit = Math.max(1, Number(next));
      index += 1;
    } else if (current === "--detail-limit" && next) {
      args.detailLimit = Math.max(1, Number(next));
      index += 1;
    } else if (current === "--per-keyword-limit" && next) {
      args.perKeywordLimit = Math.max(1, Number(next));
      index += 1;
    } else if (current === "--max-keywords" && next) {
      args.maxKeywords = Math.max(1, Number(next));
      index += 1;
    } else if (current === "--headless") {
      args.headless = true;
    } else if (current === "--api") {
      args.useApi = true;
    } else if (current === "--api-provider" && next) {
      args.useApi = true;
      args.apiProvider = next;
      index += 1;
    } else if (current === "--keep-open") {
      args.keepOpen = true;
    }
  }

  return args;
}

function splitList(value) {
  return String(value || "")
    .split(/[|;,，；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanOfferName(value) {
  return normalize(value)
    .replace(/\s*-\s*阿里巴巴.*$/i, "")
    // 剥离1688搜索页UI噪音
    .replace(/找相似/g, "")
    .replace(/验厂报告/g, "")
    .replace(/综合服务/g, "")
    .replace(/采购咨询\d+(\.\d+)?/g, "")
    .replace(/退换体验\d+(\.\d+)?/g, "")
    .replace(/品质体验\d+(\.\d+)?/g, "")
    .replace(/纠纷解决\d+(\.\d+)?/g, "")
    .replace(/物流时效\d+(\.\d+)?/g, "")
    .replace(/旺旺在线/g, "")
    .replace(/首单减\d+元/g, "")
    .replace(/近\d+天低价/g, "")
    .replace(/元宝可抵\d+%/g, "")
    .replace(/比同款低\d+%/g, "")
    .replace(/[¥￥]\s*\d+(\.\d+)?/g, "")
    .replace(/≥\d+[个件只包套双卷盒条把米台]?/g, "")
    .replace(/\d+(\.\d+)?[~\-]\d+(\.\d+)?[个件只包套双卷盒条把米台]?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const GENERIC_COMPANY_SUFFIX_RE =
  /(?:\u6709\u9650\u516c\u53f8|\u8d23\u4efb\u516c\u53f8|\u5de5\u5382|\u5382|\u5546\u884c|\u7535\u5b50\u5546\u52a1|\u4f01\u4e1a|\u65d7\u8230\u5e97)$/u;
const RANGE_ONLY_TITLE_RE =
  /^\d+(?:\.\d+)?(?:\s*[~\-]\s*\d+(?:\.\d+)?)?\s*(?:\u4e2a|\u4ef6|\u53ea|\u53f0|\u5957|\u6761|\u888b|\u7bb1|\u5377|\u5f20)\s*$/u;

function looksInvalidOfferName(value) {
  const text = cleanOfferName(value);
  if (!text) return true;
  if (QUANTITY_TITLE_RE.test(text)) return true;
  if (COMPANY_TITLE_RE.test(text)) return true;
  if (RANGE_ONLY_TITLE_RE.test(text)) return true;
  if (GENERIC_COMPANY_SUFFIX_RE.test(text)) return true;
  return text.length < 6;
}

function pickCandidateName(offer) {
  const shopName = cleanOfferName(offer?.shop_name || offer?.shopName || offer?.raw_search_shop_name || "");
  const candidates = [
    offer?.offer_title,
    ...(Array.isArray(offer?.title_candidates) ? offer.title_candidates : []),
    offer?.raw_search_title,
  ]
    .map((item) => cleanOfferName(item))
    .filter(Boolean);

  const preferred = candidates.find(
    (item) => !looksInvalidOfferName(item) && (!shopName || cleanOfferName(item) !== shopName),
  );
  return preferred || candidates.find((item) => !shopName || cleanOfferName(item) !== shopName) || "";
}

/** 用已有信息推断/补全缺失字段，减少无谓丢弃 */
function inferMissingCardFields(card, keyword) {
  // 补标题：如果title无效，从title_candidates或cardText推断
  if (!card.title || looksInvalidOfferName(cleanOfferName(card.title))) {
    const candidates = (card.title_candidates || [])
      .map((t) => cleanOfferName(t))
      .filter((t) => t && !looksInvalidOfferName(t));
    if (candidates.length > 0) {
      card.title = candidates[0];
    } else {
      // 从cardText中提取：先清洗UI噪音，再找产品描述片段
      const cleaned = cleanOfferName(card.cardText || "");
      const segments = cleaned
        .split(/起批|成交|销量|已售|件起|人付款|综合|退换|品质|纠纷|物流|采购|验厂|找相似|旺旺|登录|提交|反馈/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 6 && /[\u4e00-\u9fff]{3,}/.test(s) && !COMPANY_TITLE_RE.test(s) && !GENERIC_COMPANY_SUFFIX_RE.test(s));
      if (segments.length > 0) {
        card.title = segments.sort((a, b) => b.length - a.length)[0].slice(0, 80);
      }
    }
  }

  // 补offerUrl：从cardText或shopUrl中推断offerId
  if (!card.offerUrl) {
    const raw = normalize(card.cardText || "") + " " + normalize(card.shopUrl || "");
    const idMatch = raw.match(/offer\/(\d{8,})\.html/i) || raw.match(/offerId=(\d+)/i);
    if (idMatch?.[1]) {
      card.offerUrl = `https://detail.1688.com/offer/${idMatch[1]}.html`;
    }
  }

  // 补价格：从cardText中提取
  if (!card.priceText) {
    const priceMatch = normalize(card.cardText || "").match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
    if (priceMatch) card.priceText = priceMatch[0];
  }

  return card;
}

function isUsableSearchCard(card) {
  const title = cleanOfferName(card?.title || "");
  const shopName = cleanOfferName(card?.shopName || "");
  if (!title) return false;
  if (looksInvalidOfferName(title)) return false;
  if (shopName && title === shopName) return false;
  return true;
}

function inferOfferWeightKg(offer) {
  const direct = Number(offer?.weight_kg || 0);
  if (direct > 0) return direct;

  const bundle = normalize(
    `${offer?.description || ""} ${offer?.raw_card_text || ""} ${JSON.stringify(offer?.source_attributes || [])}`,
  );
  const match =
    bundle.match(/(毛重|净重|重量|件重)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(kg|千克|公斤|g|克)?/i) ||
    bundle.match(/重量\s*\(g\)\s*(\d+(?:\.\d+)?)/i) ||
    bundle.match(/重量\s*\(kg\)\s*(\d+(?:\.\d+)?)/i);

  if (!match) return 0;

  const value = Number(match[2] || match[1] || 0);
  const unit = String(match[3] || (match[0].includes("(g)") ? "g" : ""));
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (/(kg|千克|公斤)/i.test(unit)) return Number(value.toFixed(3));
  if (/(g|克)/i.test(unit) || value > 10) return Number((value / 1000).toFixed(3));
  return Number(value.toFixed(3));
}

function inferOfferLongEdge(offer) {
  const direct = maxLongEdge(offer?.package_dimensions_cm);
  if (direct > 0) return direct;

  const sizeText = normalize(
    `${offer?.normalizedAttributes?.size || ""} ${offer?.description || ""} ${offer?.raw_card_text || ""}`,
  );
  const match = sizeText.match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)(?:\s*[xX×*]\s*(\d+(?:\.\d+)?))?/);
  if (!match) return 0;

  return Math.max(
    Number(match[1] || 0),
    Number(match[2] || 0),
    Number(match[3] || 0),
  );
}

function inferOfferDemandSignal(offer) {
  const direct = Number(offer?.sales_count || 0);
  if (direct > 0) return direct;

  const bundle = normalize(`${offer?.raw_card_text || ""} ${offer?.description || ""}`);
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(万)?\+?\s*件/g,
    /(\d+(?:\.\d+)?)\s*(万)?\+?\s*人好评/g,
    /(\d+(?:\.\d+)?)\s*(万)?\+?\s*条评价/g,
  ];

  let best = 0;
  for (const pattern of patterns) {
    for (const match of bundle.matchAll(pattern)) {
      const base = Number(match[1] || 0);
      if (!Number.isFinite(base) || base <= 0) continue;
      const count = match[2] ? Math.round(base * 10000) : Math.round(base);
      if (count > best) best = count;
    }
  }

  return best;
}

function inferOfferMinOrderQty(offer) {
  const bundle = normalize(`${offer?.description || ""} ${offer?.raw_card_text || ""} ${offer?.price_text || ""}`);
  if (/(1件价格|1件包邮|一件代发|1件起批|1件起订)/.test(bundle)) return 1;

  const ladder = bundle.match(/≥\s*(\d+)\s*件/);
  if (ladder?.[1]) {
    return Number(ladder[1]);
  }

  const direct = Number(offer?.min_order_qty || 0);
  if (direct > 0 && direct <= 100) return direct;
  if (direct > 100 && /(先采后付|官方仓退货|立即铺货|代发下单)/.test(bundle)) return 1;
  return direct;
}

function getRules(args) {
  const base = PLATFORM_DEFAULTS[args.platform] || PLATFORM_DEFAULTS[DEFAULT_PLATFORM];
  return {
    ...base,
    priceMinRub: args.priceMinRub ?? base.priceMinRub,
    priceMaxRub: args.priceMaxRub ?? base.priceMaxRub,
    maxWeightKg: args.maxWeightKg ?? base.maxWeightKg,
    maxLongEdgeCm: args.maxLongEdgeCm ?? base.maxLongEdgeCm,
  };
}

async function loadSeeds(args) {
  if (args.keywords) {
    return repairDeepMojibake(
      splitList(args.keywords)
        .slice(0, args.maxKeywords)
        .map((keyword) => ({
          keyword,
          category: args.category || "",
          target_users: args.targetUsers || "",
          why: "",
        })),
    );
  }

  if (args.seedFile) {
    const raw = await fs.readFile(args.seedFile, "utf8");
    const parsed = JSON.parse(raw);
    const seeds = Array.isArray(parsed) ? parsed : parsed.seeds;
    if (!Array.isArray(seeds) || seeds.length === 0) {
      throw new Error("Seed file must be an array or an object with a seeds array.");
    }
    return repairDeepMojibake(
      seeds
        .map((item) => ({
          keyword: normalize(item.keyword),
          category: normalize(item.category),
          target_users: normalize(item.target_users || item.targetUsers),
          why: normalize(item.why),
        }))
        .filter((item) => item.keyword)
        .slice(0, args.maxKeywords),
    );
  }

  // 没有指定seed文件或关键词时，从大词库动态抽取
  const fresh = await pickFreshSeeds(args.maxKeywords);
  return repairDeepMojibake(fresh);
}

function chooseBetterText(left, right) {
  const leftText = normalize(left);
  const rightText = normalize(right);
  if (!leftText) return rightText;
  if (!rightText) return leftText;
  return rightText.length > leftText.length ? rightText : leftText;
}

function chooseBetterSearchTitle(left, right) {
  const leftText = cleanOfferName(left);
  const rightText = cleanOfferName(right);
  const leftValid = leftText && !looksInvalidOfferName(leftText);
  const rightValid = rightText && !looksInvalidOfferName(rightText);

  if (leftValid && !rightValid) return leftText;
  if (!leftValid && rightValid) return rightText;
  if (leftValid && rightValid) {
    return rightText.length > leftText.length ? rightText : leftText;
  }
  if (leftText && !rightText) return leftText;
  if (rightText && !leftText) return rightText;
  return rightText.length > leftText.length ? rightText : leftText;
}

function mergeSearchCandidate(existing, next, seed) {
  return {
    ...existing,
    title: chooseBetterSearchTitle(existing.title, next.title),
    shopName: chooseBetterText(existing.shopName, next.shopName),
    shopUrl: existing.shopUrl || next.shopUrl,
    offerUrl: existing.offerUrl || next.offerUrl,
    imageUrl: existing.imageUrl || next.imageUrl,
    priceText: chooseBetterText(existing.priceText, next.priceText),
    cardText: chooseBetterText(existing.cardText, next.cardText),
    price:
      existing.price > 0 && next.price > 0 ? Math.min(existing.price, next.price) : existing.price || next.price,
    salesCount: Math.max(Number(existing.salesCount || 0), Number(next.salesCount || 0)),
    minOrderQty:
      existing.minOrderQty > 0 && next.minOrderQty > 0
        ? Math.min(existing.minOrderQty, next.minOrderQty)
        : existing.minOrderQty || next.minOrderQty,
    keywords: Array.from(new Set([...(existing.keywords || []), ...(next.keywords || [])])),
    seedCategories: Array.from(
      new Set([...(existing.seedCategories || []), normalize(seed.category)]).values(),
    ).filter(Boolean),
    seedReasons: Array.from(
      new Set([...(existing.seedReasons || []), normalize(seed.why)]).values(),
    ).filter(Boolean),
    targetUsers: Array.from(
      new Set([...(existing.targetUsers || []), normalize(seed.target_users)]).values(),
    ).filter(Boolean),
  };
}

function buildSearchPool(rawCards, seeds) {
  const seedByKeyword = new Map(seeds.map((seed) => [seed.keyword, seed]));
  const merged = new Map();

  for (const card of rawCards.filter(isUsableSearchCard)) {
    const seed = seedByKeyword.get(card.keywords?.[0]) || {};
    const key = normalize(card.offerId || card.offerUrl || card.title);
    if (!key) continue;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        ...card,
        seedCategories: seed.category ? [seed.category] : [],
        seedReasons: seed.why ? [seed.why] : [],
        targetUsers: seed.target_users ? [seed.target_users] : [],
      });
      continue;
    }
    merged.set(key, mergeSearchCandidate(current, card, seed));
  }

  return Array.from(merged.values());
}

function roundTo(value, step) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value / step) * step;
}

function maxLongEdge(dimensions) {
  return Math.max(
    Number(dimensions?.length || 0),
    Number(dimensions?.width || 0),
    Number(dimensions?.height || 0),
  );
}

function textBundle(offer) {
  return normalize(
    `${offer.offer_title} ${offer.category_path} ${offer.description} ${offer.raw_card_text} ${
      offer.keyword_hits?.join(" ") || ""
    }`,
  );
}

function inferFragility(offer) {
  const text = textBundle(offer);
  if (/玻璃|陶瓷|镜|瓷|香薰蜡烛|水晶|易碎/.test(text)) return "high";
  if (/灯|电子|电器|数码|仪表/.test(text)) return "medium";
  if (/塑料|硅胶|布艺|尼龙|不锈钢|ABS|PP|PET/i.test(text)) return "low";
  return maxLongEdge(offer.package_dimensions_cm) > 40 ? "medium" : "low";
}

function inferCertificationRisk(offer) {
  const text = textBundle(offer);
  if (/电池|充电|蓝牙|wifi|医疗|医用|药|化妆|喷雾|液体|婴儿|宝宝|儿童餐|食品接触/.test(text)) {
    return "high";
  }
  if (/电子|车载充电|点烟器|刀具|磁吸|食品|母婴/.test(text)) {
    return "medium";
  }
  return "low";
}

function inferReturnRisk(offer) {
  const text = textBundle(offer);
  if (/尺码|服装|鞋|裤|裙|车型专用|机型专用|型号专用/.test(text)) return "high";
  if (/电子|安装|组装|多规格|颜色随机|香味/.test(text)) return "medium";
  return "low";
}

function inferContentPotential(offer) {
  const text = textBundle(offer);
  if (/收纳|清洁|粘毛|除毛|车载|厨房|浴室|折叠|旅行|整理|神器/.test(text)) return "high";
  if (/挂钩|垫|盒|袋|夹|架/.test(text)) return "medium";
  return "low";
}

function inferSeasonality(offer) {
  const text = textBundle(offer);
  if (/圣诞|新年|万圣|夏季|冬季|保暖|取暖|降温|泳|雪/.test(text)) return "seasonal";
  return "stable";
}

function inferSearchTrend(sourceScore, salesCount) {
  if (salesCount >= 5000 || sourceScore >= 80) return "high";
  if (salesCount >= 200 || sourceScore >= 55) return "medium";
  return "low";
}

function inferCompetitionLevel(offer, sourceScore) {
  const text = textBundle(offer);
  if (sourceScore >= 85 && /收纳|整理|盒|袋|架|厨房|浴室/.test(text)) return "high";
  if (sourceScore >= 60) return "medium";
  if (/宠物|车载缝隙|理线|后备箱网兜/.test(text)) return "low";
  return "medium";
}

function inferWhyItCanSell(offer, seedReasons) {
  const reasons = [];
  if (seedReasons.length > 0) reasons.push(seedReasons[0]);
  if (Number(offer.sales_count || 0) > 0) reasons.push(`1688 sales hint ${offer.sales_count}`);
  if (Number(offer.min_order_qty || 0) > 0 && Number(offer.min_order_qty || 0) <= 5) {
    reasons.push("low MOQ");
  }
  if (Number(offer.weight_kg || 0) > 0 && Number(offer.weight_kg || 0) <= 1.2) {
    reasons.push("light logistics");
  }
  if (reasons.length === 0) {
    reasons.push("search result shows standardizable wholesale supply");
  }
  return reasons.join("; ");
}

function buildRiskNotes(offer, rules) {
  const notes = [];
  if (!Number(offer.weight_kg || 0)) notes.push("weight_missing_needs_manual_check");
  if (!maxLongEdge(offer.package_dimensions_cm)) notes.push("dimensions_missing_needs_manual_check");
  if (Number(offer.weight_kg || 0) > rules.maxWeightKg) notes.push("weight_above_target_band");
  if (maxLongEdge(offer.package_dimensions_cm) > rules.maxLongEdgeCm) notes.push("size_above_target_band");
  if (inferCertificationRisk(offer) !== "low") notes.push("compliance_review_required");
  if (inferReturnRisk(offer) === "high") notes.push("return_risk_high");
  if (!offer.main_image) notes.push("main_image_missing");
  return notes;
}

function estimateTargetPriceRub(offer, rules) {
  const supplyPrice = Number(offer.price || 0);
  if (!supplyPrice) return 0;

  let multiple = 4.8;
  if (supplyPrice <= 8) multiple = 9.0;
  else if (supplyPrice <= 15) multiple = 8.2;
  else if (supplyPrice <= 30) multiple = 6.8;
  else if (supplyPrice <= 60) multiple = 5.6;

  if (Number(offer.weight_kg || 0) > 0.8) {
    multiple += 0.2;
  }
  if (maxLongEdge(offer.package_dimensions_cm) > 35) {
    multiple += 0.2;
  }

  const estimated = roundTo(supplyPrice * rules.exchangeRateRubPerCny * multiple, 50);
  return Math.max(estimated, rules.priceMinRub);
}

function sourceSignalScore(offer, baseSearchScore) {
  const demandSignal = inferOfferDemandSignal(offer);
  const minOrderQty = inferOfferMinOrderQty(offer);
  const weightKg = inferOfferWeightKg(offer);
  const longEdge = inferOfferLongEdge(offer);
  let score = Math.max(25, Math.min(95, baseSearchScore));
  if (demandSignal >= 100) score += 6;
  if (demandSignal >= 1000) score += 8;
  if (demandSignal >= 10000) score += 10;
  if (minOrderQty > 0 && minOrderQty <= 3) score += 5;
  if (offer.main_image) score += 4;
  if (offer.image_count >= 3) score += 4;
  if (weightKg > 0 && weightKg <= 1.2) score += 5;
  if (longEdge > 0 && longEdge <= 45) score += 5;
  return Math.min(100, score);
}

function offerToCandidateProduct(offer, seedContext, rules) {
  const longEdge = inferOfferLongEdge(offer);
  const seedReasons = seedContext.seedReasons || [];
  const sourceScore = sourceSignalScore(offer, seedContext.searchScore);
  const weightKg = inferOfferWeightKg(offer);
  const demandSignal = inferOfferDemandSignal(offer);
  const minOrderQty = inferOfferMinOrderQty(offer);

  return {
    name: pickCandidateName(offer),
    category: normalize(seedContext.seedCategories?.[0] || offer.category_path || ""),
    target_price_rub: estimateTargetPriceRub(offer, rules),
    supply_price_cny: Number(offer.price || 0),
    est_weight_kg: weightKg,
    package_long_edge_cm: Number(longEdge || 0),
    fragility: inferFragility(offer),
    certification_risk: inferCertificationRisk(offer),
    return_risk: inferReturnRisk(offer),
    competition_level: inferCompetitionLevel(offer, sourceScore),
    content_potential: inferContentPotential(offer),
    seasonality: inferSeasonality(offer),
    search_trend: inferSearchTrend(sourceScore, demandSignal),
    why_it_can_sell: inferWhyItCanSell(offer, seedReasons),
    risk_notes: buildRiskNotes(offer, rules),
    source: "1688",
    source_url: offer.source_url,
    source_platform: "1688",
    supplier_name: offer.shop_name,
    supplier_url: offer.shop_url,
    source_signal_score: sourceScore,
    source_sales_count: demandSignal,
    source_min_order_qty: minOrderQty,
    matched_keywords: offer.keyword_hits || [],
    target_users: seedContext.targetUsers || [],
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("high")) return "high";
  if (normalized.includes("medium") || normalized.includes("mid")) return "medium";
  if (normalized.includes("low")) return "low";
  if (normalized.includes("stable")) return "stable";
  if (normalized.includes("season")) return "seasonal";
  return normalized;
}

function scorePrice(product, rules) {
  const price = Number(product.target_price_rub || 0);
  if (!price) return 35;
  if (price >= rules.priceMinRub && price <= rules.priceMaxRub) return 100;

  const distance =
    price < rules.priceMinRub
      ? (rules.priceMinRub - price) / Math.max(rules.priceMinRub, 1)
      : (price - rules.priceMaxRub) / Math.max(rules.priceMaxRub, 1);

  return clamp(Math.round(100 - distance * 140), 10, 92);
}

function scoreMargin(product, rules) {
  const targetPrice = Number(product.target_price_rub || 0);
  const supplyPrice = Number(product.supply_price_cny || 0);
  if (!targetPrice || !supplyPrice) return 35;

  const convertedSupplyRub = supplyPrice * rules.exchangeRateRubPerCny;
  const roughMarginRate = (targetPrice - convertedSupplyRub) / Math.max(targetPrice, 1);

  if (roughMarginRate >= 0.65) return 95;
  if (roughMarginRate >= 0.5) return 85;
  if (roughMarginRate >= 0.35) return 70;
  if (roughMarginRate >= 0.2) return 52;
  return 20;
}

function scoreLogistics(product, rules) {
  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  const fragility = parseLevel(product.fragility);
  let score = 92;

  if (!weight) score -= 18;
  if (!longEdge) score -= 12;

  if (weight > rules.maxWeightKg) {
    score -= Math.min(50, Math.round(((weight - rules.maxWeightKg) / rules.maxWeightKg) * 45));
  }
  if (longEdge > rules.maxLongEdgeCm) {
    score -= Math.min(35, Math.round(((longEdge - rules.maxLongEdgeCm) / rules.maxLongEdgeCm) * 30));
  }
  if (fragility === "medium") score -= 18;
  if (fragility === "high") score -= 40;

  return clamp(score, 5, 100);
}

function scoreRisk(product, field) {
  const level = parseLevel(product[field]);
  if (level === "low") return 95;
  if (level === "medium") return 60;
  if (level === "high") return 20;
  return 50;
}

function scoreCompetition(product) {
  const level = parseLevel(product.competition_level);
  if (level === "low") return 88;
  if (level === "medium") return 58;
  if (level === "high") return 22;
  return 50;
}

function scoreContent(product) {
  const level = parseLevel(product.content_potential);
  if (level === "high") return 90;
  if (level === "medium") return 64;
  if (level === "low") return 40;
  return 50;
}

function scoreSearchTrend(product) {
  const level = parseLevel(product.search_trend);
  if (level === "high") return 88;
  if (level === "medium" || level === "stable") return 64;
  if (level === "low") return 38;
  return 50;
}

function deriveDecision(totalScore, product) {
  const fragile = parseLevel(product.fragility) === "high";
  const cert = parseLevel(product.certification_risk) === "high";
  const returns = parseLevel(product.return_risk) === "high";
  const price = Number(product.target_price_rub || 0);

  if (cert || (fragile && returns) || totalScore < 45) return "No-Go";
  if (price && price < 800) return "Watch";
  if (totalScore >= 70) return "Go";
  return "Watch";
}

function analyzeProducts(products, rules) {
  return products.map((product) => {
    const scoreBreakdown = {
      price_fit: scorePrice(product, rules),
      margin_potential: scoreMargin(product, rules),
      logistics_friendliness: scoreLogistics(product, rules),
      competition: scoreCompetition(product),
      compliance_risk: scoreRisk(product, "certification_risk"),
      return_risk: scoreRisk(product, "return_risk"),
      content_potential: scoreContent(product),
      search_trend: scoreSearchTrend(product),
      source_signal: clamp(Number(product.source_signal_score || 0), 20, 100),
    };

    const totalScore = Math.round(
      (scoreBreakdown.logistics_friendliness * rules.logisticsWeight +
        scoreBreakdown.margin_potential * rules.marginWeight +
        scoreBreakdown.competition * rules.competitionWeight +
        scoreBreakdown.compliance_risk * rules.complianceWeight +
        scoreBreakdown.return_risk * rules.returnWeight +
        scoreBreakdown.content_potential * rules.contentWeight +
        scoreBreakdown.search_trend * rules.trendWeight +
        scoreBreakdown.source_signal * rules.sourceWeight) /
        (rules.logisticsWeight +
          rules.marginWeight +
          rules.competitionWeight +
          rules.complianceWeight +
          rules.returnWeight +
          rules.contentWeight +
          rules.trendWeight +
          rules.sourceWeight),
    );

    const issueSummary = [];
    if (scoreBreakdown.logistics_friendliness < 60) issueSummary.push("logistics pressure is high");
    if (scoreBreakdown.margin_potential < 60) issueSummary.push("margin space is weak");
    if (scoreBreakdown.competition < 45) issueSummary.push("competition is crowded");
    if (scoreBreakdown.compliance_risk < 45) issueSummary.push("compliance review is required");
    if (scoreBreakdown.return_risk < 45) issueSummary.push("return risk is high");
    if (scoreBreakdown.search_trend < 50) issueSummary.push("trend signal is weak");
    if (scoreBreakdown.source_signal < 45) issueSummary.push("source signal is weak");

    return {
      ...product,
      score_breakdown: scoreBreakdown,
      total_score: totalScore,
      final_decision: deriveDecision(totalScore, product),
      issue_summary: issueSummary,
    };
  });
}

function buildSelectionBrief(args, rules, seeds, runtimeSummary) {
  return {
    platform: "Ozon",
    provider: args.provider,
    marketplace: rules.marketplace,
    price_band_rub: `${rules.priceMinRub}-${rules.priceMaxRub}`,
    core_strategy: [
      "Source from low-cost domestic wholesale offers and filter for Ozon-friendly unit economics.",
      "Prefer lightweight, standardized, low-after-sales products with simple visual selling points.",
      "Treat source signal as evidence only; final decision still gates on logistics, compliance, and margin.",
    ],
    warnings: [
      "Items with missing dimensions or weight remain only semi-validated and need spot checks.",
      "This run uses 1688 search visibility as the demand proxy, not marketplace sell-through confirmation.",
    ],
    source_runtime: runtimeSummary,
    source_keywords: seeds.map((seed) => seed.keyword),
    task: {
      goal: args.productGoal,
      category: args.category || "",
      target_users: args.targetUsers || "",
    },
  };
}

function buildRecommendedActions(products) {
  const goProducts = products.filter((item) => item.final_decision === "Go");
  const watchProducts = products.filter((item) => item.final_decision === "Watch");

  const actions = [];
  if (goProducts.length > 0) {
    actions.push(`Start manual spot-check on ${goProducts.slice(0, 3).map((item) => item.name).join(", ")}.`);
  }
  if (watchProducts.length > 0) {
    actions.push(
      `Recheck weight, carton size, and compliance details for ${watchProducts
        .slice(0, 3)
        .map((item) => item.name)
        .join(", ")}.`,
    );
  }
  actions.push(
    "Keep the first batch narrow and validate click-through, conversion, refund rate, and ad cost before scaling.",
  );
  return actions;
}

function buildMarkdownReport(args, rules, seeds, result, manifest) {
  const products = [...result.products].sort((left, right) => right.total_score - left.total_score);
  const goProducts = products.filter((item) => item.final_decision === "Go");
  const watchProducts = products.filter((item) => item.final_decision === "Watch");
  const noGoProducts = products.filter((item) => item.final_decision === "No-Go");

  const lines = [
    "# 1688 Ozon Selection Report",
    "",
    "## Task",
    "",
    `- Provider: ${args.provider}`,
    `- Marketplace: ${rules.marketplace}`,
    `- Goal: ${args.productGoal}`,
    `- Price band: ${rules.priceMinRub}-${rules.priceMaxRub} RUB`,
    `- Max weight: ${rules.maxWeightKg} kg`,
    `- Max long edge: ${rules.maxLongEdgeCm} cm`,
    `- Target users: ${args.targetUsers || "default"}`,
    `- Keywords: ${seeds.map((seed) => seed.keyword).join(", ")}`,
    "",
    "## Source Runtime",
    "",
    `- Runtime mode: ${manifest.runtime.mode}`,
    `- Storage state existed: ${manifest.runtime.storageStateExists ? "yes" : "no"}`,
    `- Search pages visited: ${manifest.searchAttempts.length}`,
    `- Raw search candidates: ${manifest.rawSearchCandidateCount}`,
    `- Detailed offers scraped: ${products.length}`,
    "",
    "## Summary",
    "",
    `- Go: ${goProducts.length}`,
    `- Watch: ${watchProducts.length}`,
    `- No-Go: ${noGoProducts.length}`,
    "",
    "## Products",
    "",
  ];

  for (const product of products) {
    lines.push(`### ${product.name || "Unnamed product"}`);
    lines.push("");
    lines.push(`- Decision: ${product.final_decision}`);
    lines.push(`- Total score: ${product.total_score}`);
    lines.push(`- Category: ${product.category || "n/a"}`);
    lines.push(`- Estimated sell price: ${product.target_price_rub || "n/a"} RUB`);
    lines.push(`- Source price: ${product.supply_price_cny || "n/a"} CNY`);
    lines.push(`- Weight: ${product.est_weight_kg || "unknown"} kg`);
    lines.push(`- Long edge: ${product.package_long_edge_cm || "unknown"} cm`);
    lines.push(`- Supplier: ${product.supplier_name || "unknown"}`);
    lines.push(`- Source URL: ${product.source_url || "n/a"}`);
    lines.push(`- Matched keywords: ${(product.matched_keywords || []).join(", ") || "n/a"}`);
    lines.push(`- Why it can sell: ${product.why_it_can_sell || "n/a"}`);
    if (product.issue_summary.length > 0) {
      lines.push(`- Main issues: ${product.issue_summary.join("; ")}`);
    }
    if ((product.risk_notes || []).length > 0) {
      lines.push(`- Risk notes: ${product.risk_notes.join("; ")}`);
    }
    lines.push(
      `- Score breakdown: price ${product.score_breakdown.price_fit}, margin ${product.score_breakdown.margin_potential}, logistics ${product.score_breakdown.logistics_friendliness}, competition ${product.score_breakdown.competition}, compliance ${product.score_breakdown.compliance_risk}, return ${product.score_breakdown.return_risk}, content ${product.score_breakdown.content_potential}, trend ${product.score_breakdown.search_trend}, source ${product.score_breakdown.source_signal}`,
    );
    lines.push("");
  }

  lines.push("## Recommended Actions", "");
  for (const item of result.recommended_actions) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function saveArtifacts(outputDir, basename, payload) {
  const basePath = path.join(outputDir, basename);
  await writeJson(`${basePath}.json`, payload.manifest);
  await writeJson(`${basePath}.search.json`, payload.searchSnapshot);
  await writeJson(`${basePath}.input.json`, payload.inputPayload);
  await writeJson(`${basePath}.analysis.json`, payload.result);
  await fs.writeFile(`${basePath}.report.md`, payload.report, "utf8");
  return `${basePath}.analysis.json`;
}

async function collect1688Candidates(args, seeds) {
  const runtime = await launch1688Runtime(args.headless);
  const { browser, context } = runtime;
  const searchPage = await context.newPage();
  const detailPage = await context.newPage();
  const searchAttempts = [];
  const rawCards = [];
  const detailIssues = [];
  const captchaSkippedKeywords = [];

  try {
    for (const [seedIndex, seed] of seeds.entries()) {
      const progress = `[${seedIndex + 1}/${seeds.length}]`;
      console.log(`${progress} 搜索: ${seed.keyword}`);

      try {
      if (seedIndex > 0) {
        await waitWithHumanPacing(searchPage, SEARCH_PACING_BASE_MS, SEARCH_PACING_JITTER_MS);
      }

      let searchState = await openSearchPage(searchPage, seed.keyword);
      await save1688StorageState(context);

      if (searchState.page_type === "captcha") {
        // ── 产品级验证码处理 ──
        // 1) 系统通知提醒用户
        sendCaptchaNotification(seed.keyword);
        // 2) 浏览器窗口置顶（确保用户看到）
        await bringBrowserToFront(searchPage).catch(() => {});
        // 3) 等待用户完成验证（最多120秒）
        console.log(`[验证码] 搜索 "${seed.keyword}" 需要人工验证，请在浏览器中拖动滑块...`);
        const waitResult = await waitForCaptchaClear(
          searchPage,
          `search:${seed.keyword}`,
          CAPTCHA_WAIT_TIMEOUT_MS,
        );
        if (!waitResult.resolved) {
          console.log(`[验证码] "${seed.keyword}" 等待超时，跳过此关键词 (下次可重试)`);
          detailIssues.push(`search_captcha_timeout:${seed.keyword}`);
          captchaSkippedKeywords.push(seed.keyword);
          // 验证码超时后，后续关键词也大概率被拦，加长冷却期
          await new Promise((r) => setTimeout(r, 15000 + Math.random() * 10000));
          continue;
        }
        console.log(`[验证码] "${seed.keyword}" 验证通过!`);
        searchState = waitResult.state;
        await save1688StorageState(context);
      }

      console.log(
        `[search] ${seed.keyword} -> page_type=${searchState.page_type} cards=${Number(searchState.cardCount || 0)} offer_links=${Number(searchState.offerLinkCount || 0)}`,
      );

      searchAttempts.push({
        keyword: seed.keyword,
        page_type: searchState.page_type,
        card_count: Number(searchState.cardCount || 0),
        offer_link_count: Number(searchState.offerLinkCount || 0),
        title: normalize(searchState.title || ""),
      });

      if (searchState.page_type !== "search") {
        detailIssues.push(`search_${searchState.page_type}:${seed.keyword}`);
        continue;
      }

      const rawSearchCards = (await collectSearchCandidates(searchPage))
        .map((card) => summarizeSearchCard(card, seed.keyword))
        .map((card) => inferMissingCardFields(card, seed.keyword));
      const beforeFilter = rawSearchCards.length;
      const withUrl = rawSearchCards.filter((card) => card.offerUrl);
      const usable = withUrl.filter(isUsableSearchCard);
      if (usable.length < beforeFilter) {
        console.log(`[search] ${seed.keyword}: ${beforeFilter}张卡片 -> ${withUrl.length}有URL -> ${usable.length}可用 (推断补全后)`);
      }
      const cards = dedupeCandidates(usable)
        .map((card) => ({
          ...card,
          searchScore: scoreSearchCandidate(card, tokenizeTerms(seed.keyword, seed.category)),
        }))
        .sort((left, right) => right.searchScore - left.searchScore)
        .slice(0, args.perKeywordLimit);

      console.log(`[search] ${seed.keyword} -> kept ${cards.length} candidates after ranking.`);
      rawCards.push(...cards);
      } catch (seedError) {
        console.error(`${progress} "${seed.keyword}" 处理异常: ${seedError.message}`);
        detailIssues.push(`search_error:${seed.keyword}:${seedError.message.slice(0, 80)}`);
        captchaSkippedKeywords.push(seed.keyword);
      }
    }

    const searchPool = buildSearchPool(rawCards, seeds)
      .map((candidate) => ({
        ...candidate,
        searchScore: scoreSearchCandidate(
          candidate,
          tokenizeTerms(
            candidate.title,
            ...(candidate.keywords || []),
            ...(candidate.seedCategories || []),
            ...(candidate.targetUsers || []),
          ),
        ),
      }))
      .sort((left, right) => right.searchScore - left.searchScore);

    const shortlisted = searchPool.slice(0, Math.max(args.detailLimit, args.limit));
    console.log(
      `[detail] Preparing ${shortlisted.length} shortlisted offers from ${rawCards.length} ranked search cards.`,
    );
    const offers = [];

    for (const [index, candidate] of shortlisted.entries()) {
      console.log(
        `[detail] ${index + 1}/${shortlisted.length} opening: ${candidate.title || candidate.offerUrl}`,
      );

      if (index > 0) {
        await waitWithHumanPacing(detailPage, DETAIL_PACING_BASE_MS, DETAIL_PACING_JITTER_MS);
      }

      let detail = await scrapeDetailPage(detailPage, candidate.offerUrl);
      await save1688StorageState(context);

      if (detail.page_type === "captcha") {
        sendCaptchaNotification(candidate.title || "商品详情");
        await bringBrowserToFront(detailPage).catch(() => {});
        console.log(`[验证码] 商品详情 "${normalize(candidate.title || "").slice(0, 30)}" 需要人工验证...`);
        const waitResult = await waitForCaptchaClear(
          detailPage,
          `detail:${candidate.offerUrl}`,
          CAPTCHA_WAIT_TIMEOUT_MS,
        );
        if (!waitResult.resolved) {
          console.log(`[验证码] 详情页验证超时，跳过`);
          detailIssues.push(`detail_captcha_timeout:${candidate.offerUrl}`);
          continue;
        }
        console.log(`[验证码] 详情页验证通过!`);
        await save1688StorageState(context);
        detail = await scrapeDetailPage(detailPage, candidate.offerUrl);
      }

      if (detail.page_type !== "detail") {
        detailIssues.push(`detail_${detail.page_type}:${candidate.offerUrl}`);
        console.log(
          `[detail] skipped ${candidate.title || candidate.offerUrl}: page_type=${detail.page_type}`,
        );
        continue;
      }

      offers.push(
        buildOfferSummary(
          {
            ...candidate,
            offerId: candidate.offerId,
            salesCount: candidate.salesCount,
            keywords: candidate.keywords,
          },
          detail,
        ),
      );

      console.log(
        `[detail] captured ${offers.length}/${shortlisted.length}: ${candidate.title || candidate.offerUrl}`,
      );
    }

    return {
      runtime,
      rawCards,
      searchAttempts,
      searchPool,
      offers,
      detailIssues,
      captchaSkippedKeywords,
      async close() {
        if (!args.keepOpen) {
          await context.close().catch(() => {});
          await browser?.close().catch(() => {});
        }
      },
    };
  } catch (error) {
    if (!args.keepOpen) {
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
    throw error;
  }
}

async function collectFromSearchSnapshot(searchSnapshotFile) {
  const snapshot = await readJson(searchSnapshotFile, null);
  if (!snapshot || !Array.isArray(snapshot.offers)) {
    throw new Error(`Invalid search snapshot: ${searchSnapshotFile}`);
  }

  const manifest = await readJson(searchSnapshotFile.replace(/\.search\.json$/i, ".json"), null);

  return {
    runtime: {
      mode: "search-snapshot-replay",
      storageStateExists: Boolean(manifest?.runtime?.storageStateExists),
      bootstrapSource: manifest?.runtime?.bootstrapSource || searchSnapshotFile,
      browserProfileDir: manifest?.runtime?.browserProfileDir || "",
      storageStatePath: manifest?.runtime?.storageStatePath || "",
    },
    rawCards: repairDeepMojibake(snapshot.rawCards || []),
    searchAttempts: repairDeepMojibake(snapshot.searchAttempts || []),
    searchPool: repairDeepMojibake(snapshot.searchPool || []),
    offers: repairDeepMojibake(snapshot.offers || []),
    detailIssues: [...(snapshot.detailIssues || []), `replayed_from_snapshot:${searchSnapshotFile}`],
    replayedSeeds: repairDeepMojibake(snapshot.seeds || []),
    async close() {},
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.provider !== "1688") {
    throw new Error(`Unsupported provider: ${args.provider}. Only 1688 is implemented in this run.`);
  }

  const rules = getRules(args);
  let seeds = await loadSeeds(args);
  if (seeds.length === 0) {
    throw new Error("No seed keywords available.");
  }

  const modeLabel = args.useApi ? " via API" : args.searchSnapshotFile ? " from saved search snapshot" : "";
  console.log(
    `[selector] Starting 1688 -> ${args.platform} run with ${seeds.length} keywords${modeLabel}.`,
  );
  console.log(`[selector] Keywords: ${seeds.map((seed) => seed.keyword).join(", ")}`);
  await ensureDir(args.outputDir);

  const startedAt = new Date().toISOString();

  let collected;
  if (args.useApi) {
    // API模式（需要万邦/订单侠Key）
    const apiStatus = await checkApiAvailability();
    const available = Object.entries(apiStatus).find(([, v]) => v.hasKey);
    if (!available) {
      console.error(`[1688-api] 没有可用的API Key。请设置环境变量:`);
      for (const [, v] of Object.entries(apiStatus)) {
        console.error(`  ${v.envVar} — ${v.name}`);
      }
      process.exit(1);
    }
    console.log(`[1688-api] 使用 ${available[1].name} API`);
    collected = await collect1688ByApi(seeds, {
      provider: args.apiProvider || available[0],
      perKeywordLimit: args.perKeywordLimit,
      detailLimit: args.detailLimit,
      pacingMs: 1000,
    });
  } else if (args.searchSnapshotFile) {
    collected = await collectFromSearchSnapshot(args.searchSnapshotFile);
  } else if (args.headless) {
    // 默认：移动端HTTP模式（无浏览器、无验证码）
    collected = await collect1688ByMobile(seeds, {
      perKeywordLimit: args.perKeywordLimit,
      detailLimit: Math.max(args.detailLimit, args.limit),
      pacingMs: 3000,
    });
  } else {
    // 有头浏览器模式（用于调试或需要完整JS渲染时）
    collected = await collect1688Candidates(args, seeds);
  }

  if (Array.isArray(collected.replayedSeeds) && collected.replayedSeeds.length > 0) {
    seeds = collected.replayedSeeds;
    console.log(`[selector] Replayed snapshot seeds: ${seeds.map((seed) => seed.keyword).join(", ")}`);
  }

  try {
    const seedContextByUrl = new Map(
      collected.searchPool.map((candidate) => [
        candidate.offerUrl,
        {
          searchScore: candidate.searchScore,
          seedCategories: candidate.seedCategories || [],
          seedReasons: candidate.seedReasons || [],
          targetUsers: candidate.targetUsers || [],
        },
      ]),
    );

    // ── 去重：排除已调研过的产品 ──
    const existingNames = await loadExistingProductNames();
    const allCandidates = collected.offers
      .map((offer) => {
        const seedContext = seedContextByUrl.get(offer.source_url) || {
          searchScore: 40,
          seedCategories: [],
          seedReasons: [],
          targetUsers: [],
        };
        return offerToCandidateProduct(offer, seedContext, rules);
      })
      .sort((left, right) => Number(right.source_signal_score || 0) - Number(left.source_signal_score || 0));

    const beforeDedup = allCandidates.length;
    const candidateProducts = allCandidates
      .filter((p) => !isDuplicateProduct(p.name, existingNames))
      .slice(0, args.limit);
    const dedupSkipped = beforeDedup - candidateProducts.length - Math.max(0, beforeDedup - args.limit);
    if (dedupSkipped > 0) {
      console.log(`[dedup] 跳过 ${dedupSkipped} 个已调研过的重复产品`);
    }

    const analyzedProducts = analyzeProducts(candidateProducts, rules).sort(
      (left, right) => right.total_score - left.total_score,
    );

    console.log(
      `[完成] 抓取 ${collected.offers.length} 个商品详情，评估 ${analyzedProducts.length} 个候选产品。`,
    );

    const runtimeSummary = {
      mode: collected.runtime.mode,
      storage_state_exists: collected.runtime.storageStateExists,
      bootstrap_source: collected.runtime.bootstrapSource,
      browser_profile_dir: collected.runtime.browserProfileDir,
      storage_state_path: collected.runtime.storageStatePath,
    };

    const result = {
      selection_brief: buildSelectionBrief(args, rules, seeds, runtimeSummary),
      products: analyzedProducts,
      recommended_actions: buildRecommendedActions(analyzedProducts),
      provider_summary: {
        provider: args.provider,
        raw_search_candidate_count: collected.rawCards.length,
        search_pool_count: collected.searchPool.length,
        detailed_offer_count: collected.offers.length,
        detail_issues: collected.detailIssues,
      },
      ozon_operating_rules: {
        marketplace: rules.marketplace,
        price_band_rub: `${rules.priceMinRub}-${rules.priceMaxRub}`,
        max_weight_kg: rules.maxWeightKg,
        max_long_edge_cm: rules.maxLongEdgeCm,
      },
    };

    const manifest = {
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: args.platform,
      provider: args.provider,
      outputDir: args.outputDir,
      seedFile: args.seedFile,
      keywords: seeds.map((seed) => seed.keyword),
      runtime: {
        mode: collected.runtime.mode,
        storageStateExists: collected.runtime.storageStateExists,
        bootstrapSource: collected.runtime.bootstrapSource,
        browserProfileDir: collected.runtime.browserProfileDir,
        storageStatePath: collected.runtime.storageStatePath,
      },
      rawSearchCandidateCount: collected.rawCards.length,
      searchPoolCount: collected.searchPool.length,
      detailedOfferCount: collected.offers.length,
      finalProductCount: analyzedProducts.length,
      searchAttempts: collected.searchAttempts,
      detailIssues: collected.detailIssues,
      goCount: analyzedProducts.filter((item) => item.final_decision === "Go").length,
      watchCount: analyzedProducts.filter((item) => item.final_decision === "Watch").length,
      noGoCount: analyzedProducts.filter((item) => item.final_decision === "No-Go").length,
    };

    const basename = `1688-ozon-selector-${timestamp()}`;
    const report = buildMarkdownReport(args, rules, seeds, result, manifest);
    const inputPayload = {
      selection_brief: result.selection_brief,
      provider_summary: result.provider_summary,
      products: candidateProducts,
    };
    const searchSnapshot = {
      seeds,
      searchAttempts: collected.searchAttempts,
      rawCards: collected.rawCards,
      searchPool: collected.searchPool,
      offers: collected.offers,
      detailIssues: collected.detailIssues,
    };

    const savedPath = await saveArtifacts(args.outputDir, basename, {
      manifest,
      searchSnapshot,
      inputPayload,
      result,
      report,
    });

    console.log(`[保存] ${savedPath}`);
    console.log(`[结果] ${analyzedProducts.length} 个产品已评估完成`);

    // 回收被验证码跳过的关键词（从已使用列表中移除，下次还能抽到）
    if ((collected.captchaSkippedKeywords || []).length > 0) {
      try {
        const used = await loadUsedKeywords();
        for (const kw of collected.captchaSkippedKeywords) used.delete(kw);
        await saveUsedKeywords(used);
        console.log(`[seeds] 回收 ${collected.captchaSkippedKeywords.length} 个被验证码跳过的关键词: ${collected.captchaSkippedKeywords.join(", ")}`);
      } catch {}
    }
  } finally {
    await collected.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
