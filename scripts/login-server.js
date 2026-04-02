#!/usr/bin/env node
/**
 * Ozon Pilot - 全栈管理服务器
 *
 * 本地启动一个Web界面 + Playwright浏览器：
 * 1. 前端页面显示登录状态和按钮
 * 2. 点击"登录1688"→ Playwright打开1688登录页，用户扫码
 * 3. 登录成功后自动保存cookie到 .profiles/
 * 4. Ozon API配置、批量上架、订单监控、面单下载
 *
 * 用法: node scripts/login-server.js [--port 3456]
 */
// 加载 .env 环境变量（无依赖）
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { readJson, writeJson, ensureDir, parseCliArgs } from "./lib/shared.js";
import { launchBrowser, saveSession, closeBrowser, detectPageType } from "./lib/browser.js";
import { HTML_PAGE } from "./lib/html-template.js";
import { hashPassword, verifyPassword, signToken, authMiddleware } from "./lib/auth.js";
import { getDb, createUser, getUserByEmail, getUserById, incrementProductsUsed } from "./lib/db.js";

/* ─── Proxy for Ozon API (GFW) ─── */
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
let proxyDispatcher;
if (PROXY_URL) {
  try {
    const undici = await import("undici");
    proxyDispatcher = new undici.ProxyAgent(PROXY_URL);
    console.log(`  代理: ${PROXY_URL}`);
  } catch {
    // undici不可用时通过https-proxy-agent或跳过
    console.log(`  代理: ${PROXY_URL} (需安装 undici: npm i undici)`);
  }
}

/* ─── Project root paths ─── */
const AI_ROOT = path.resolve(".");
const KB_PRODUCTS = path.join(AI_ROOT, "knowledge-base", "products");
const OZON_CONFIG_DIR = path.join(AI_ROOT, "config");
const OZON_CONFIG_PATH = path.join(OZON_CONFIG_DIR, "ozon-api.json");

/* ─── Per-user data directories ─── */
function getUserDir(userId) {
  const dir = path.join(AI_ROOT, "data", String(userId));
  return dir;
}

function getUserProductsDir(userId) {
  return path.join(getUserDir(userId), "products");
}

function getUserConfigDir(userId) {
  return path.join(getUserDir(userId), "config");
}

function getUserOzonConfigPath(userId) {
  return path.join(getUserConfigDir(userId), "ozon-api.json");
}

/** Ensure per-user directory tree exists */
async function ensureUserDirs(userId) {
  await ensureDir(getUserProductsDir(userId));
  await ensureDir(getUserConfigDir(userId));
}

/**
 * Migrate legacy data for the first registered user (id=1).
 * Copies existing knowledge-base/products → data/1/products
 * and config/ozon-api.json → data/1/config/ozon-api.json
 */
async function migrateDataForFirstUser(userId) {
  if (userId !== 1) return;
  const userProducts = getUserProductsDir(userId);
  const userCfgPath = getUserOzonConfigPath(userId);

  // Check if migration already done
  try {
    const entries = await fs.readdir(userProducts);
    if (entries.length > 0) return; // already has data
  } catch { /* dir doesn't exist yet, will create */ }

  await ensureUserDirs(userId);

  // Copy products
  const legacyProducts = path.join(AI_ROOT, "knowledge-base", "products");
  try {
    const entries = await fs.readdir(legacyProducts, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = path.join(legacyProducts, entry.name);
      const dst = path.join(userProducts, entry.name);
      await fs.cp(src, dst, { recursive: true }).catch(() => {});
    }
    console.log(`[auth] 已迁移 ${entries.length} 个产品目录到用户 ${userId}`);
  } catch (e) {
    console.log(`[auth] 产品目录迁移跳过: ${e.message?.slice(0, 60)}`);
  }

  // Copy ozon config
  try {
    const raw = await fs.readFile(OZON_CONFIG_PATH, "utf8");
    await fs.writeFile(userCfgPath, raw, "utf8");
    console.log(`[auth] 已迁移 Ozon 配置到用户 ${userId}`);
  } catch {
    // No legacy config, fine
  }
}

const PLATFORMS = {
  "1688": {
    loginUrl: "https://login.1688.com/member/signin.htm",
    checkUrl: "https://s.1688.com/selloffer/offer_search.htm?keywords=test",
    profileDir: path.resolve(".profiles", "1688", "browser-user-data"),
    storagePath: path.resolve(".profiles", "1688", "storage-state.json"),
    cookieDomain: ".1688.com",
    successPattern: /1688\.com(?!.*login|.*signin)/i,
    loginPattern: /login|signin|passport/i,
  },
  pdd: {
    loginUrl: "https://mobile.yangkeduo.com/login.html",
    checkUrl: "https://mobile.yangkeduo.com/search_result.html?search_key=test",
    profileDir: path.resolve(".profiles", "pdd", "browser-user-data"),
    storagePath: path.resolve(".profiles", "pdd", "storage-state.json"),
    cookieDomain: ".yangkeduo.com",
    successPattern: /yangkeduo\.com(?!.*login)/i,
    loginPattern: /login/i,
  },
  ozon: {
    loginUrl: "https://seller.ozon.ru/",
    checkUrl: "https://seller.ozon.ru/app/settings/api-keys",
    profileDir: path.resolve(".profiles", "ozon", "browser-user-data"),
    storagePath: path.resolve(".profiles", "ozon", "storage-state.json"),
    cookieDomain: ".ozon.ru",
    successPattern: /seller\.ozon\.ru\/app/i,
    loginPattern: /passport\.ozon\.ru|login|signin/i,
  },
};

let activeSessions = {}; // platform → { context, browser, page, status }

/* ─── Ozon API helper ─── */
async function loadOzonCfg() {
  try {
    const raw = await fs.readFile(OZON_CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function ozonApi(endpoint, body, cfg) {
  const r = await fetch("https://api-seller.ozon.ru" + endpoint, {
    method: "POST",
    headers: {
      "Client-Id": String(cfg.clientId),
      "Api-Key": cfg.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  });
  // 安全解析JSON（处理403 HTML/502等非JSON响应）
  let data;
  try {
    data = await r.json();
  } catch {
    const text = await r.text().catch(() => "");
    if (r.status === 403) data = { code: 7, message: "API Key已停用或无效，请重新生成" };
    else if (r.status === 404) data = { code: 5, message: "API端点不存在: " + endpoint };
    else data = { code: r.status, message: "Ozon API HTTP " + r.status + ": " + text.slice(0, 100) };
  }
  return { status: r.status, ok: r.ok, data };
}

async function ozonApiRaw(endpoint, body, cfg) {
  return fetch("https://api-seller.ozon.ru" + endpoint, {
    method: "POST",
    headers: {
      "Client-Id": String(cfg.clientId),
      "Api-Key": cfg.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  });
}

/* ─── Read all import mappings ─── */
async function readAllMappings() {
  const entries = await fs.readdir(KB_PRODUCTS, { withFileTypes: true }).catch(() => []);
  const mappings = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const mjson = path.join(KB_PRODUCTS, entry.name, "ozon-import-mapping.json");
      const raw = await fs.readFile(mjson, "utf8");
      const m = JSON.parse(raw);
      m._dir = entry.name;
      mappings.push(m);
    } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
  }
  return mappings;
}

// ─── 检查cookie状态 ───
async function checkCookieStatus(platform) {
  const config = PLATFORMS[platform];
  if (!config) return { valid: false, error: "unknown platform" };

  const state = await readJson(config.storagePath, null);
  if (!state?.cookies?.length) return { valid: false, reason: "no_cookies" };

  const domainCookies = state.cookies.filter(c =>
    String(c.domain || "").endsWith(config.cookieDomain.replace(/^\./, ""))
  );

  const now = Date.now() / 1000;
  // expires <= 0 或 epoch前 = session cookie（视为已过期，因为浏览器关了就没了）
  // expires > now = 有效
  // !expires = 视为session cookie（不可靠）
  const isValidCookie = (c) => c.expires && c.expires > 100 && c.expires > now;
  const expired = domainCookies.filter(c => !isValidCookie(c));
  const valid = domainCookies.filter(isValidCookie);

  const keyNames = platform === "pdd"
    ? ["PDDAccessToken", "PASS_ID", "pdd_user_id", "pdd_user_uin", "SUB", "ak", "accessToken"]
    : platform === "ozon"
      ? ["abt_data", "__Secure", "session", "OZON_TOKEN"]
      : ["cookie2", "_tb_token_", "__cn_logon__", "sgcookie", "PASS_ID"];
  const keyCookies = platform === "ozon"
    ? (valid.length >= 5 ? valid.slice(0, 1) : [])
    : valid.filter(c => keyNames.some(k => c.name?.includes(k)));
  const earliestExpiry = keyCookies.reduce((min, c) => {
    if (c.expires && c.expires > 0) return Math.min(min, c.expires);
    return min;
  }, Infinity);

  const daysLeft = earliestExpiry === Infinity ? -1 : Math.round((earliestExpiry - now) / 86400);

  // 1688需要至少2个关键cookie才能正常搜索
  const minKeyCookies = platform === "1688" ? 2 : platform === "ozon" ? 0 : 1;
  const isValid = keyCookies.length >= minKeyCookies;

  // 如果关键cookie不足，标记哪些缺失
  const missingKeys = platform === "1688"
    ? ["cookie2", "_tb_token_", "sgcookie"].filter(k => !valid.some(c => c.name?.includes(k)))
    : [];

  return {
    valid: isValid,
    totalCookies: domainCookies.length,
    validCookies: valid.length,
    keyCookieCount: keyCookies.length,
    expiredCookies: expired.length,
    daysUntilExpiry: daysLeft,
    missingKeys,
    lastSaved: state.cookies[0]?.sameSite ? "recent" : "unknown",
  };
}

// ─── 启动登录流程 ───
async function startLogin(platform) {
  const config = PLATFORMS[platform];
  if (!config) throw new Error(`Unknown platform: ${platform}`);

  if (activeSessions[platform]) {
    await closeBrowser(activeSessions[platform]).catch(() => {});
    delete activeSessions[platform];
  }

  const { context, browser } = await launchBrowser(config.profileDir, {
    headless: false,
    storageStatePath: config.storagePath,
  });

  // 关闭持久化上下文恢复的多余页面，只保留一个用于登录
  const existingPages = context.pages();
  const page = existingPages[0] || await context.newPage();
  for (const p of existingPages.slice(1)) {
    await p.close().catch(() => {});
  }

  // 清除旧的关键cookie，防止轮询误判"已登录"
  try {
    const oldCookies = await context.cookies();
    const domain = config.cookieDomain.replace(/^\./, "");
    const keyNames = platform === "pdd"
      ? ["PDDAccessToken", "PASS_ID", "pdd_user_id", "pdd_user_uin", "SUB"]
      : platform === "ozon"
        ? ["abt_data", "x-o2-api-key", "session", "__Secure"]
        : ["cookie2", "_tb_token_", "__cn_logon__", "sgcookie"];
    const toRemove = oldCookies.filter(c =>
      String(c.domain || "").endsWith(domain) && keyNames.some(k => c.name?.includes(k))
    );
    if (toRemove.length) {
      await context.clearCookies({ domain: config.cookieDomain }).catch(() => {});
      console.log(`[${platform}] 已清除 ${toRemove.length} 个旧关键cookie，等待重新登录`);
    }
  } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }

  // 确保1688/ozon等国内站不走代理
  const hosts = [config.loginUrl, config.checkUrl].map(u => { try { return new URL(u).hostname; } catch { return ""; } }).filter(Boolean);
  try {
    const { ensureDirectConnection } = await import("./lib/browser.js");
    await ensureDirectConnection(hosts);
  } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }

  // 导航到登录页，失败重试一次
  let navOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      navOk = true;
      break;
    } catch (navErr) {
      console.log(`[${platform}] 导航失败(${attempt}/2): ${navErr.message?.slice(0, 60)}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!navOk) {
    // 最后兜底：直接在地址栏输入URL
    try { await page.evaluate((url) => { window.location.href = url; }, config.loginUrl); } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
    await new Promise(r => setTimeout(r, 3000));
  }

  // 记录启动时已有的关键cookie指纹，用于区分"旧cookie"和"新登录产生的cookie"
  let initialKeyCookieSignature = "";
  try {
    const keyNames = platform === "pdd"
      ? ["PDDAccessToken", "PASS_ID", "pdd_user_id", "pdd_user_uin", "SUB"]
      : platform === "ozon"
        ? ["abt_data", "x-o2-api-key", "session", "__Secure"]
        : ["cookie2", "_tb_token_", "__cn_logon__", "sgcookie"];
    const cookies = await context.cookies();
    const domain = config.cookieDomain.replace(/^\./, "");
    const keyCookies = cookies.filter(c =>
      String(c.domain || "").endsWith(domain) && keyNames.some(k => c.name?.includes(k))
    );
    initialKeyCookieSignature = keyCookies.map(c => c.name + "=" + c.value).sort().join("|");
    if (keyCookies.length) {
      console.log(`[${platform}] 检测到 ${keyCookies.length} 个旧关键cookie，将等待新cookie出现`);
    }
  } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }

  activeSessions[platform] = { context, browser, page, status: "waiting_login", initialKeyCookieSignature };
  pollLoginStatus(platform);
  return { started: true, platform };
}

async function pollLoginStatus(platform) {
  const session = activeSessions[platform];
  const config = PLATFORMS[platform];
  if (!session || !config) return;

  const startTime = Date.now();
  const timeout = 300_000;

  let browserClosed = false;
  const onClose = () => { browserClosed = true; };
  session.page?.on("close", onClose);
  session.context?.on("close", onClose);

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 3000));

    if (!activeSessions[platform]) return;

    if (browserClosed) {
      console.log(`[${platform}] 用户关闭了登录窗口`);
      await saveSession(session.context, config.storagePath).catch(() => {});
      await closeBrowser(session).catch(() => {});
      delete activeSessions[platform];
      return;
    }

    try {
      const isClosed = session.page?.isClosed?.() ?? false;
      if (isClosed) {
        console.log(`[${platform}] 登录页面已关闭`);
        await saveSession(session.context, config.storagePath).catch(() => {});
        await closeBrowser(session).catch(() => {});
        delete activeSessions[platform];
        return;
      }

      const url = session.page.url();
      const urlLeft = !config.loginPattern.test(url);
      let cookieReady = false;
      try {
        const cookies = await session.context.cookies();
        const domainCookies = cookies.filter(c =>
          String(c.domain || "").endsWith(config.cookieDomain.replace(/^\./, ""))
        );
        const keyNames = platform === "pdd"
          ? ["PDDAccessToken", "PASS_ID", "pdd_user_id", "pdd_user_uin", "SUB"]
          : platform === "ozon"
            ? ["abt_data", "x-o2-api-key", "session", "__Secure"]
            : ["cookie2", "_tb_token_", "__cn_logon__", "sgcookie"];
        const keyCookies = domainCookies.filter(c => keyNames.some(k => c.name?.includes(k)));
        const keyCookieCount = keyCookies.length;
        const minRequired = platform === "1688" ? 2 : 1;
        const hasKeyCookie = keyCookieCount >= minRequired;
        const hasEnoughTotal = platform === "ozon"
          ? domainCookies.length >= 5
          : hasKeyCookie && domainCookies.length >= 3;

        // 关键：比较cookie指纹是否变化（防止旧cookie误判）
        const currentSignature = keyCookies.map(c => c.name + "=" + c.value).sort().join("|");
        const signatureChanged = currentSignature !== (session.initialKeyCookieSignature || "");

        cookieReady = hasEnoughTotal && signatureChanged;
        if (hasEnoughTotal && !signatureChanged) {
          // cookie存在但没变化 → 是旧cookie，不算登录成功
        } else if (cookieReady) {
          console.log(`[${platform}] 检测到新登录cookie: ${domainCookies.length}个 (含${keyCookieCount}个关键cookie)`);
        }
      } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }

      // 1688必须cookie变化才算登录成功（防止旧cookie误判）
      // 其他平台URL离开登录页或cookie变化都算
      const loginSuccess = platform === "1688" ? cookieReady : (urlLeft || cookieReady);
      if (loginSuccess) {
        session.status = "logged_in";
        await new Promise(r => setTimeout(r, 3000));
        await saveSession(session.context, config.storagePath);
        session.status = "cookie_saved";
        console.log(`[${platform}] 登录成功，cookie已保存`);

        // 立刻关浏览器
        await closeBrowser(session).catch(() => {});
        delete activeSessions[platform];

        // ── Ozon特殊处理：后台静默提取API Key ──
        if (platform === "ozon") {
          extractOzonApiKeySilent(config.storagePath).catch(e => {
            console.log(`[ozon] 后台API Key提取失败: ${e.message}`);
          });
        }
        return;
      }
    } catch (err) {
      console.log(`[${platform}] 浏览器已关闭 (${err.message?.slice(0, 60)})`);
      await closeBrowser(session).catch(() => {});
      delete activeSessions[platform];
      return;
    }
  }

  session.status = "timeout";
  await closeBrowser(session).catch(() => {});
  delete activeSessions[platform];
}

/**
 * 后台静默提取Ozon API Key（纯HTTP，不弹浏览器）
 * 用登录后保存的cookie请求API Key管理页面
 */
async function extractOzonApiKeySilent(storagePath) {
  console.log("[ozon] 后台提取API Key...");

  const state = await readJson(storagePath, null);
  if (!state?.cookies?.length) {
    console.log("[ozon] 无cookie，跳过API Key提取");
    return;
  }

  const cookieStr = state.cookies
    .filter(c => String(c.domain || "").includes("ozon.ru"))
    .map(c => `${c.name}=${c.value}`)
    .join("; ");

  // 请求API Key管理页面
  const r = await fetch("https://seller.ozon.ru/app/settings/api-keys", {
    headers: {
      Cookie: cookieStr,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
    redirect: "follow",
  });

  const html = await r.text();
  console.log("[ozon] API Key页面响应:", r.status, html.length, "bytes");

  // 提取Client-Id
  const clientIdMatch =
    html.match(/Client[- ]?Id[:\s"]*(\d{5,10})/i) ||
    html.match(/client_id[:\s"]*(\d{5,10})/i) ||
    html.match(/ID\s*клиента[:\s"]*(\d{5,10})/i) ||
    html.match(/"clientId"\s*:\s*"?(\d{5,10})/i);
  const clientId = clientIdMatch?.[1] || "";

  // 提取API Keys (UUID格式)
  const keys = [...new Set(
    [...html.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)]
      .map(m => m[1])
  )];

  console.log("[ozon] 提取结果: clientId=" + clientId + " keys=" + keys.length);

  if (clientId || keys.length > 0) {
    const cfg = await loadOzonCfg();
    if (clientId) cfg.clientId = clientId;
    if (keys.length > 0) cfg.apiKey = keys[0];
    await ensureDir(OZON_CONFIG_DIR);
    await fs.writeFile(OZON_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    console.log("[ozon] API Key已自动保存!");

    // 自动获取仓库信息
    if (cfg.clientId && cfg.apiKey) {
      try {
        const wh = await ozonApi("/v1/warehouse/list", {}, cfg);
        if (wh.ok && wh.data.result?.[0]) {
          cfg.warehouseId = wh.data.result[0].warehouse_id;
          cfg.warehouseName = wh.data.result[0].name;
          cfg.currency = "CNY";
          await fs.writeFile(OZON_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
          console.log("[ozon] 仓库信息已获取:", cfg.warehouseName);
        }
      } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
    }
  } else {
    console.log("[ozon] 未能从页面提取API信息，可能需要在Ozon后台先生成API Key");
  }
}

// ─── HTTP 服务器 ───
// HTML_PAGE now in ./lib/html-template.js

// HTML template moved to ./lib/html-template.js

// ─── helper: read JSON body from request ───
function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

// ─── 安全: 路径参数清理（防止路径遍历攻击）───
function safePath(seg) {
  if (!seg || /[\/\\]|\.\./.test(seg)) return null;
  return seg;
}

function createServer(port) {
  // Initialize DB on startup
  getDb();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // ─── Auth API endpoints (no token required) ───
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const { email, password } = body;
        if (!email || !password) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "邮箱和密码不能为空" }));
          return;
        }
        if (password.length < 6) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "密码至少6位" }));
          return;
        }
        const existing = getUserByEmail(email);
        if (existing) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "该邮箱已注册" }));
          return;
        }
        const hash = hashPassword(password);
        const user = createUser(email, hash, body.inviteCode);
        const token = signToken({ userId: user.id, email: user.email });

        // Ensure user data dirs exist + migrate for first user
        await ensureUserDirs(user.id);
        await migrateDataForFirstUser(user.id);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          token,
          user: { id: user.id, email: user.email, plan: user.plan, is_admin: !!user.is_admin },
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const { email, password } = body;
        if (!email || !password) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "邮箱和密码不能为空" }));
          return;
        }
        const user = getUserByEmail(email);
        if (!user) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "邮箱或密码错误" }));
          return;
        }
        if (!verifyPassword(password, user.password_hash)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "邮箱或密码错误" }));
          return;
        }
        const token = signToken({ userId: user.id, email: user.email });

        // Ensure user data dirs exist
        await ensureUserDirs(user.id);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          token,
          user: { id: user.id, email: user.email, plan: user.plan, is_admin: !!user.is_admin },
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const auth = authMiddleware(req);
      if (!auth) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "未登录" }));
        return;
      }
      const user = getUserById(auth.userId);
      if (!user) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "用户不存在" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        user: {
          id: user.id,
          email: user.email,
          plan: user.plan,
          products_used: user.products_used,
          product_quota: user.product_quota,
          is_admin: !!user.is_admin,
        },
      }));
      return;
    }

    // ─── 管理后台 API（需要 admin） ───
    if (url.pathname.startsWith("/api/admin/")) {
      const auth = authMiddleware(req);
      if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: "未登录" })); return; }
      const adminUser = getUserById(auth.userId);
      if (!adminUser?.is_admin) { res.writeHead(403); res.end(JSON.stringify({ error: "无管理权限" })); return; }

      // GET /api/admin/users — 用户列表 + 用量
      if (url.pathname === "/api/admin/users" && req.method === "GET") {
        const { listAllUsers, getUsageStats } = await import("./lib/db.js");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ users: listAllUsers(), stats: getUsageStats() }));
        return;
      }

      // POST /api/admin/user/plan — 修改用户套餐
      if (url.pathname === "/api/admin/user/plan" && req.method === "POST") {
        const { updateUserPlan } = await import("./lib/db.js");
        const body = await readBody(req);
        updateUserPlan(body.userId, body.plan, body.quota);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/admin/invite — 创建邀请码
      if (url.pathname === "/api/admin/invite" && req.method === "POST") {
        const { createInviteCode } = await import("./lib/db.js");
        const body = await readBody(req);
        const code = body.code || Math.random().toString(36).slice(2, 10).toUpperCase();
        createInviteCode(code, body.plan || "basic", body.quota || 100, body.maxUses || 10, auth.userId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code, plan: body.plan || "basic", quota: body.quota || 100 }));
        return;
      }

      // GET /api/admin/invites — 邀请码列表
      if (url.pathname === "/api/admin/invites" && req.method === "GET") {
        const { listInviteCodes } = await import("./lib/db.js");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ codes: listInviteCodes() }));
        return;
      }

      // GET /api/admin/usage/:userId — 用户用量明细
      if (url.pathname.startsWith("/api/admin/usage/") && req.method === "GET") {
        const { getUserUsage } = await import("./lib/db.js");
        const targetId = parseInt(safePath(url.pathname.split("/").pop()));
        if (!targetId) { res.writeHead(400); res.end("invalid user id"); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ usage: getUserUsage(targetId) }));
        return;
      }

      res.writeHead(404); res.end("not found"); return;
    }

    // ─── 前端页面 ───
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
      return;
    }

    // ─── Auth guard for all other /api/* endpoints ───
    let userId = null;
    if (url.pathname.startsWith("/api/")) {
      const auth = authMiddleware(req);
      if (!auth) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "未登录" }));
        return;
      }
      userId = auth.userId;
      await ensureUserDirs(userId);
    }

    // ─── Per-user paths (computed once per request) ───
    const USER_PRODUCTS = userId ? getUserProductsDir(userId) : KB_PRODUCTS;
    const USER_OZON_CONFIG_DIR = userId ? getUserConfigDir(userId) : OZON_CONFIG_DIR;
    const USER_OZON_CONFIG_PATH = userId ? getUserOzonConfigPath(userId) : OZON_CONFIG_PATH;

    // Per-user Ozon config loader
    async function loadUserOzonCfg() {
      try {
        const raw = await fs.readFile(USER_OZON_CONFIG_PATH, "utf8");
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }

    // Per-user readAllMappings
    async function readUserMappings() {
      const entries = await fs.readdir(USER_PRODUCTS, { withFileTypes: true }).catch(() => []);
      const mappings = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const mjson = path.join(USER_PRODUCTS, entry.name, "ozon-import-mapping.json");
          const raw = await fs.readFile(mjson, "utf8");
          const m = JSON.parse(raw);
          m._dir = entry.name;
          mappings.push(m);
        } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
      }
      return mappings;
    }

    // ─── API: 检查cookie状态 ───
    if (url.pathname.startsWith("/api/status/")) {
      const platform = url.pathname.split("/").pop();
      const status = await checkCookieStatus(platform);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    // ─── API: 检查登录session ───
    if (url.pathname.startsWith("/api/session/")) {
      const platform = url.pathname.split("/").pop();
      const session = activeSessions[platform];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: session?.status || null }));
      return;
    }

    // ─── API: 启动登录 ───
    if (url.pathname.startsWith("/api/login/") && req.method === "POST") {
      const platform = url.pathname.split("/").pop();
      try {
        const result = await startLogin(platform);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── API: 运行管道 ───
    if (url.pathname === "/api/pipeline" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });
      const { execFile } = await import("node:child_process");
      const child = execFile("node", [
        path.resolve("scripts", "run-pipeline.js"),
        "--limit", "5",
      ], { cwd: path.resolve(""), timeout: 1800_000 });

      child.stdout?.on("data", (chunk) => res.write(chunk));
      child.stderr?.on("data", (chunk) => res.write(chunk));
      child.on("close", (code) => {
        res.write(`\n--- 完成 (exit code: ${code}) ---\n`);
        res.end();
      });
      return;
    }

    // ─── API: 产品列表 ───
    if (url.pathname === "/api/products" && req.method === "GET") {
      try {
        const entries = await fs.readdir(USER_PRODUCTS, { withFileTypes: true }).catch(() => []);
        const products = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const slug = entry.name;
          const pjson = path.join(USER_PRODUCTS, slug, "product.json");
          const mapping = await readJson(path.join(USER_PRODUCTS, slug, "ozon-import-mapping.json"), null);
          const inferred = await readJson(path.join(USER_PRODUCTS, slug, "inferred.json"), null);
          try {
            const raw = await fs.readFile(pjson, "utf8");
            const data = JSON.parse(raw);
            const best = data.candidates?.[0];
            // 从采集数据提取价格
            const priceNums = (best?.prices || [])
              .map(p => parseFloat(String(p).replace(/[¥￥,]/g, "")))
              .filter(n => n > 0 && n < 9999);
            const supplyCny = priceNums.length ? priceNums.sort((a, b) => a - b)[Math.floor(priceNums.length / 2)] : 0;
            const targetRub = supplyCny ? Math.round(supplyCny * 12.5 * 8) : 0;

            // 判断阶段
            let stage = "已采集";
            if (inferred) stage = "已推理";
            if (mapping?.status === "可提交") stage = "待上架";
            if (mapping?.status === "已上传") stage = "已上架";

            products.push({
              slug,
              product: {
                name: inferred?.title_ru || best?.title || data.keyword || slug,
                category: data.seed?.category || "",
                target_price_rub: targetRub || "--",
                supply_price_cny: supplyCny || "--",
                total_score: mapping ? 91 : (best ? 80 : 0),
                source_url: best?.source_url || "",
                why_it_can_sell: data.seed?.why || "",
              },
              workflow: { current_stage: stage },
            });
          } catch { /* skip invalid */ }
        }
        products.sort((a, b) => (b.product?.total_score ?? 0) - (a.product?.total_score ?? 0));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(products));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── API: 单个产品详情 ───
    if (url.pathname.startsWith("/api/products/") && req.method === "GET") {
      const slug = safePath(url.pathname.split("/").pop());
      if (!slug) { res.writeHead(400); res.end("invalid slug"); return; }
      try {
        const pjson = path.join(USER_PRODUCTS, slug, "product.json");
        const raw = await fs.readFile(pjson, "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(raw);
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "product not found" }));
      }
      return;
    }

    // ─── API: 关键词词库状态 ───
    if (url.pathname === "/api/keywords" && req.method === "GET") {
      try {
        const usedPath = path.join(AI_ROOT, "knowledge-base", ".used-keywords.json");
        let used = [];
        try {
          used = JSON.parse(await fs.readFile(usedPath, "utf8"));
        } catch { /* file may not exist */ }
        // 从词库文件动态计算总数
        let total = 0;
        try {
          const pool = JSON.parse(await fs.readFile(path.join(AI_ROOT, "knowledge-base", "keyword-pool.json"), "utf8"));
          for (const cat of Object.values(pool.categories || {})) {
            if (cat.enabled) total += (cat.keywords || []).length;
          }
        } catch { total = 0; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          used: used.length,
          total,
          remaining: Math.max(0, total - used.length),
          keywords_used: used,
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── API: 智能链接导入 (streaming) ───
    if (url.pathname === "/api/smart-import" && req.method === "POST") {
      const body = await readBody(req);
      const targetUrl = body.url;
      if (!targetUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少url参数" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });
      try {
        const { smartImport } = await import("./smart-link-import.js");
        const result = await smartImport(targetUrl, (msg) => {
          res.write(msg + "\n");
        });
        if (result.success) {
          res.write(`\n✅ 导入完成: ${result.title?.slice(0, 40)} [${result.source}]\n`);
          res.write(`   slug: ${result.slug}\n`);

          // ── 自动生成mapping并上架 ──
          const cfg = await loadUserOzonCfg();
          if (cfg.clientId && cfg.apiKey) {
            res.write(`\n[自动上架] 生成mapping...\n`);
            try {
              // 读取刚保存的product.json，生成简单mapping
              const productDir = path.join(USER_PRODUCTS, result.slug);
              const pdata = result.data;
              const seed = pdata.seed || {};
              const best = (pdata.candidates || [])[0] || {};
              const images = (best.images || []).slice(0, 6);
              const supply = seed.supply_price_cny || 0;
              const weightKg = seed.est_weight_kg || 0.3;
              const SHIP = 20, PKG = 4, COMM = 0.18, PROFIT = 1.5, MIN = 30;
              const cost = supply + weightKg * SHIP + PKG;
              let price = supply > 0 ? Math.ceil(cost * PROFIT / (1 - COMM)) : MIN;
              if (price < MIN) price = MIN;
              const NO_BRAND = 126745801;
              // 简单类目匹配（默认家居收纳）
              const catId = 17027937;
              const typeId = 970896147;
              const typeName = "Органайзер для хранения вещей";
              const model = result.slug.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 20) + "-" + Date.now().toString(36).slice(-4);

              const mapping = {
                slug: result.slug, status: "可提交", offer_id: result.slug,
                title_override: result.title || "Product", title_lang: "zh",
                price_override: price + ".00", old_price_override: Math.ceil(price * 1.3) + ".00",
                currency_code: cfg.currency || "CNY", initial_stock: 100,
                warehouse_id: cfg.warehouseId || 1020005009633310,
                primary_image_override: images[0] || "", images_override: images,
                weight_override_g: Math.round(weightKg * 1000),
                depth_override_mm: 300, width_override_mm: 200, height_override_mm: 100,
                import_fields: {
                  description_category_id: catId, type_id: typeId,
                  attributes: [
                    { id: 9048, complex_id: 0, values: [{ dictionary_value_id: 0, value: model }] },
                    { id: 85, complex_id: 0, values: [{ dictionary_value_id: NO_BRAND, value: "Нет бренда" }] },
                    { id: 8229, complex_id: 0, values: [{ dictionary_value_id: typeId, value: typeName }] },
                  ],
                },
              };
              await fs.writeFile(path.join(productDir, "ozon-import-mapping.json"), JSON.stringify(mapping, null, 2), "utf8");
              res.write(`[自动上架] mapping已生成: ¥${price} CNY\n`);

              // 提交到Ozon
              res.write(`[自动上架] 提交到Ozon...\n`);
              const item = {
                description_category_id: catId, type_id: typeId,
                name: mapping.title_override, offer_id: mapping.offer_id,
                barcode: "", price: mapping.price_override, old_price: mapping.old_price_override,
                currency_code: mapping.currency_code, vat: "0",
                depth: mapping.depth_override_mm, width: mapping.width_override_mm, height: mapping.height_override_mm,
                dimension_unit: "mm", weight: mapping.weight_override_g, weight_unit: "g",
                primary_image: images[0] || "", images: images.slice(1),
                attributes: mapping.import_fields.attributes,
              };
              const ir = await ozonApi("/v3/product/import", { items: [item] }, cfg);
              if (ir.ok && ir.data.result) {
                const taskId = ir.data.result.task_id;
                res.write(`[自动上架] 提交成功 task_id=${taskId}\n`);
                mapping.ozon_task_id = taskId;
                mapping.status = "已上传";
                await fs.writeFile(path.join(productDir, "ozon-import-mapping.json"), JSON.stringify(mapping, null, 2), "utf8");
                res.write(`\n🚀 上架完成! 从粘贴链接到上架Ozon，全自动。\n`);
              } else {
                res.write(`[自动上架] 提交失败: ${ir.data?.message || JSON.stringify(ir.data).slice(0, 100)}\n`);
              }
            } catch (uploadErr) {
              res.write(`[自动上架] 异常: ${uploadErr.message}\n`);
            }
          } else {
            res.write(`\n提示: 配置Ozon API后可自动上架\n`);
          }
        } else {
          res.write(`\n❌ 导入失败: ${result.reason}\n`);
        }
      } catch (err) {
        res.write(`\n错误: ${err.message}\n`);
      }
      res.end();
      return;
    }

    // ─── API: 运行选品 (streaming) ───
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  Ozon API Endpoints (new paths: /api/ozon/*)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // ─── GET /api/ozon/config ───
    if (url.pathname === "/api/ozon/config" && req.method === "GET") {
      try {
        const cfg = await loadUserOzonCfg();
        const masked = cfg.apiKey ? cfg.apiKey.slice(0, 4) + "****" + cfg.apiKey.slice(-4) : "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          clientId: cfg.clientId || "",
          apiKeyMasked: masked,
          warehouseId: cfg.warehouseId || "",
          warehouseName: cfg.warehouseName || "",
          currency: cfg.currency || "CNY",
        }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ clientId: "", apiKeyMasked: "" }));
      }
      return;
    }

    // ─── POST /api/ozon/config ───
    if (url.pathname === "/api/ozon/config" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await ensureDir(USER_OZON_CONFIG_DIR);
        let existing = await loadUserOzonCfg();
        if (body.clientId) existing.clientId = body.clientId;
        if (body.apiKey) existing.apiKey = body.apiKey;
        if (!existing.currency) existing.currency = "CNY";
        await fs.writeFile(USER_OZON_CONFIG_PATH, JSON.stringify(existing, null, 2), "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ─── GET /api/ozon/check ─── validate key + return warehouse info
    if (url.pathname === "/api/ozon/check" && req.method === "GET") {
      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "未配置 API 凭据" }));
          return;
        }
        const r = await ozonApi("/v1/warehouse/list", {}, cfg);
        if (r.ok && r.data.result) {
          const wh = r.data.result[0];
          // Save warehouse info to config
          cfg.warehouseId = wh?.warehouse_id;
          cfg.warehouseName = wh?.name;
          cfg.currency = "CNY";
          await ensureDir(USER_OZON_CONFIG_DIR);
          await fs.writeFile(USER_OZON_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            warehouse_id: wh?.warehouse_id,
            warehouse_name: wh?.name,
            warehouses: r.data.result.length,
            currency: "CNY",
          }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: r.data.message || "API 返回错误" }));
        }
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ─── GET /api/ozon/upload-ready ─── count submittable products
    if (url.pathname === "/api/ozon/upload-ready" && req.method === "GET") {
      try {
        const mappings = await readUserMappings();
        const readyCount = mappings.filter(m => m.status === "可提交").length;
        const uploadedCount = mappings.filter(m => m.status === "已上传" || m.ozon_product_id).length;
        const cfg = await loadUserOzonCfg();
        const apiConfigured = !!(cfg.clientId && cfg.apiKey);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: readyCount, uploaded: uploadedCount, apiConfigured }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: 0, uploaded: 0, apiConfigured: false, error: err.message }));
      }
      return;
    }

    // ─── POST /api/ozon/upload ─── batch import to Ozon via v3/product/import
    if (url.pathname === "/api/ozon/upload" && req.method === "POST") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      });

      const write = (obj) => res.write(JSON.stringify(obj) + "\n");

      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          write({ type: "error", message: "未配置 Ozon API 凭据" });
          res.end();
          return;
        }

        const mappings = await readUserMappings();
        const ready = mappings.filter(m => m.status === "可提交");

        if (ready.length === 0) {
          write({ type: "error", message: "没有可提交的产品" });
          res.end();
          return;
        }

        write({ type: "log", message: `找到 ${ready.length} 个可提交产品，开始上传...` });

        // Build Ozon import items
        const items = [];
        for (const m of ready) {
          const images = [];
          if (m.primary_image_override) images.push(m.primary_image_override);
          if (m.images_override) {
            for (const img of m.images_override) {
              if (img !== m.primary_image_override) images.push(img);
            }
          }

          // 标准化attributes为Ozon要求的格式
          const rawAttrs = m.import_fields?.attributes || [];
          const normalizedAttrs = rawAttrs.map(a => {
            if (a.values) return a; // 已经是标准格式
            return {
              id: a.id,
              complex_id: a.complex_id || 0,
              values: [{ dictionary_value_id: a.dictionary_value_id || 0, value: String(a.value || "") }],
            };
          });

          const item = {
            description_category_id: m.import_fields?.description_category_id || 0,
            type_id: m.import_fields?.type_id || 0,
            name: m.title_override || m.slug || "Product",
            offer_id: m.offer_id || m.slug,
            barcode: "",
            price: String(m.price_override || "0"),
            old_price: String(m.old_price_override || "0"),
            currency_code: m.currency_code || cfg.currency || "CNY",
            vat: "0",
            height: m.height_override_mm || 100,
            depth: m.depth_override_mm || 100,
            width: m.width_override_mm || 100,
            dimension_unit: "mm",
            weight: m.weight_override_g || 500,
            weight_unit: "g",
            images: images.slice(1),
            primary_image: images[0] || "",
            attributes: normalizedAttrs,
          };
          items.push({ item, mapping: m });
        }

        // Submit in batches of 20
        const BATCH = 20;
        const allResults = [];
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < items.length; i += BATCH) {
          const batch = items.slice(i, i + BATCH);
          const payload = {
            items: batch.map(b => b.item),
          };

          write({ type: "log", message: `提交批次 ${Math.floor(i/BATCH)+1} (${batch.length} 个产品)...` });

          try {
            const r = await ozonApi("/v3/product/import", payload, cfg);

            if (r.ok && r.data.result) {
              const taskId = r.data.result.task_id;
              write({ type: "log", message: `批次提交成功, task_id: ${taskId}` });

              // Report progress for each item
              for (let j = 0; j < batch.length; j++) {
                const b = batch[j];
                write({
                  type: "progress",
                  current: i + j + 1,
                  total: items.length,
                  offer_id: b.item.offer_id,
                  status: "submitted",
                });
              }

              // Wait and check import status
              write({ type: "log", message: "等待 Ozon 处理..." });
              await new Promise(resolve => setTimeout(resolve, 5000));

              // Check status
              const statusR = await ozonApi("/v1/product/import/info", { task_id: taskId }, cfg);
              if (statusR.ok && statusR.data.result) {
                const statusItems = statusR.data.result.items || [];
                for (const si of statusItems) {
                  const offerId = si.offer_id;
                  const productId = si.product_id || "";
                  const allErrs = si.errors || [];
                  const severeErrs = allErrs.filter(e => e.level === "error");
                  const warnErrs = allErrs.filter(e => e.level !== "error");
                  const errors = allErrs.map(e => `[${e.level}] ${e.code}: ${(e.description || e.message || "").slice(0, 80)}`).join("\n");
                  const success = (si.status === "imported" || productId > 0) && severeErrs.length === 0;

                  if (success) successCount++;
                  else failCount++;

                  allResults.push({
                    type: "result",
                    offer_id: offerId,
                    product_id: productId,
                    success,
                    errors,
                    status: si.status,
                  });

                  // Update mapping file status
                  const mapping = batch.find(b => b.item.offer_id === offerId)?.mapping;
                  if (mapping && mapping._dir) {
                    const mjsonPath = path.join(USER_PRODUCTS, mapping._dir, "ozon-import-mapping.json");
                    try {
                      const mRaw = await fs.readFile(mjsonPath, "utf8");
                      const mData = JSON.parse(mRaw);
                      if (success) {
                        mData.status = "已上传";
                        mData.ozon_product_id = productId;
                        mData.ozon_task_id = taskId;
                      } else {
                        mData.ozon_import_errors = errors;
                      }
                      mData.ozon_import_at = new Date().toISOString();
                      await fs.writeFile(mjsonPath, JSON.stringify(mData, null, 2), "utf8");
                    } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
                  }
                }
              } else {
                // Could not get status, mark all as pending
                for (const b of batch) {
                  allResults.push({
                    type: "result",
                    offer_id: b.item.offer_id,
                    product_id: "",
                    success: false,
                    errors: "无法获取导入状态",
                    status: "pending",
                  });
                  failCount++;
                }
              }
            } else {
              const errMsg = r.data.message || r.data.error || "API 错误";
              write({ type: "log", message: `批次失败: ${errMsg}` });
              for (const b of batch) {
                allResults.push({
                  type: "result",
                  offer_id: b.item.offer_id,
                  product_id: "",
                  success: false,
                  errors: errMsg,
                  status: "error",
                });
                failCount++;
              }
            }
          } catch (batchErr) {
            write({ type: "log", message: `批次异常: ${batchErr.message}` });
            for (const b of batch) {
              allResults.push({
                type: "result",
                offer_id: b.item.offer_id,
                product_id: "",
                success: false,
                errors: batchErr.message,
                status: "error",
              });
              failCount++;
            }
          }
        }

        // Send all results
        for (const r of allResults) write(r);

        // Send done summary
        write({ type: "done", success: successCount, failed: failCount, total: items.length });

      } catch (err) {
        write({ type: "error", message: err.message });
      }

      res.end();
      return;
    }

    // ─── GET /api/ozon/errors ─── 实时查询所有产品错误（不依赖旧task_id）
    if (url.pathname === "/api/ozon/errors") {
      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"未配置API"})); return; }

        // 用v3实时查
        const listR = await ozonApi("/v3/product/list", { filter: { visibility: "ALL" }, limit: 200 }, cfg);
        const items = listR.data?.result?.items || [];
        if (items.length === 0) {
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({totalProducts:0,totalSevere:0,totalWarn:0,products:[]}));
          return;
        }

        const pids = items.map(p => p.product_id);
        const infoR = await ozonApi("/v3/product/info/list", { product_id: pids }, cfg);
        const infoItems = infoR.data?.items || [];

        const productErrors = [];
        let totalSevere = 0, totalWarn = 0;
        for (const p of infoItems) {
          const errs = p.item_errors || [];
          if (errs.length === 0) continue;
          const severe = errs.filter(e => e.level === "error");
          const warn = errs.filter(e => e.level !== "error" && e.level !== "info");
          totalSevere += severe.length;
          totalWarn += warn.length;
          productErrors.push({
            offer_id: p.offer_id, product_id: p.id, status: p.status?.state || "unknown",
            severe: severe.map(e => ({code:e.code,attr_id:e.attribute_id,attr_name:e.attribute_name,desc:(e.description||e.message||"").slice(0,120)})),
            warnings: warn.map(e => ({code:e.code,attr_id:e.attribute_id,attr_name:e.attribute_name,desc:(e.description||e.message||"").slice(0,120)})),
          });
        }
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({totalProducts:items.length,totalSevere,totalWarn,products:productErrors}));
      } catch (err) {
        res.writeHead(500, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:err.message}));
      }
      return;
    }

    // ─── POST /api/ozon/stock ─── set stock=100 for all imported products
    if (url.pathname === "/api/ozon/stock" && req.method === "POST") {
      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "未配置 Ozon API" }));
          return;
        }

        const mappings = await readUserMappings();
        const imported = mappings.filter(m => m.status === "已上传" || m.ozon_product_id);

        if (imported.length === 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "没有已上传的产品" }));
          return;
        }

        const warehouseId = cfg.warehouseId || 1020005009633310;
        const stocks = imported.map(m => ({
          offer_id: m.offer_id || m.slug,
          product_id: m.ozon_product_id || 0,
          stock: m.initial_stock || 100,
          warehouse_id: warehouseId,
        }));

        // Submit in batches of 100
        let updated = 0;
        const errors = [];
        for (let i = 0; i < stocks.length; i += 100) {
          const batch = stocks.slice(i, i + 100);
          const r = await ozonApi("/v2/products/stocks", { stocks: batch }, cfg);
          if (r.ok && r.data.result) {
            for (const item of r.data.result) {
              if (item.updated) updated++;
              else if (item.errors?.length) {
                errors.push(item.offer_id + ": " + item.errors.map(e => e.message).join("; "));
              }
            }
          } else {
            errors.push(r.data.message || "API 错误");
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, updated, total: imported.length, errors }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ─── DEBUG test ───
    if (url.pathname === "/api/ozon/debug-test") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, msg: "debug route works" }));
      return;
    }

    // ─── POST /api/ozon/fix ─── smart auto-fix: query Ozon API for correct types, fix SPU, fix images
    if (url.pathname === "/api/ozon/fix" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked", "Cache-Control": "no-cache" });
      const write = (obj) => res.write(JSON.stringify(obj) + "\n");

      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) { write({ type: "error", message: "未配置 Ozon API" }); res.end(); return; }

        // ── 1. 用v3/product/info/list获取实时错误（不依赖旧task_id）──
        write({ type: "log", message: "正在获取所有产品实时状态..." });
        const listR = await ozonApi("/v3/product/list", { filter: { visibility: "ALL" }, limit: 200 }, cfg);
        const allProducts = listR.data?.result?.items || [];
        write({ type: "log", message: `Ozon上共 ${allProducts.length} 个产品` });

        if (allProducts.length === 0) {
          write({ type: "done", message: "店铺无产品", fixed: 0, remaining: 0 });
          res.end(); return;
        }

        const pids = allProducts.map(p => p.product_id);
        const infoR = await ozonApi("/v3/product/info/list", { product_id: pids }, cfg);
        const infoItems = infoR.data?.items || [];

        const errorProducts = [];
        for (const p of infoItems) {
          const errs = p.item_errors || [];
          if (errs.length > 0) {
            errorProducts.push({
              offer_id: p.offer_id, product_id: p.id,
              description_category_id: p.description_category_id, type_id: p.type_id,
              name: p.name, errors: errs,
            });
          }
        }

        if (errorProducts.length === 0) {
          write({ type: "done", message: "所有产品零错误! 无需修复。", fixed: 0, remaining: 0 });
          res.end(); return;
        }

        write({ type: "log", message: `发现 ${errorProducts.length} 个产品有错误，开始智能修复...` });

        // ── 2. 缓存类目树（用于查正确type）──
        let categoryTree = null;
        async function getCategoryTree() {
          if (categoryTree) return categoryTree;
          write({ type: "log", message: "加载Ozon类目树..." });
          const r = await ozonApi("/v1/description-category/tree", { language: "DEFAULT" }, cfg);
          categoryTree = r.data?.result || [];
          return categoryTree;
        }

        // 查找某个category下的有效type列表
        function findTypesForCategory(cats, targetCatId) {
          for (const c of cats || []) {
            if (c.description_category_id === targetCatId) {
              return (c.children || []).filter(ch => ch.type_id).map(ch => ({ type_id: ch.type_id, type_name: ch.type_name || ch.category_name }));
            }
            const found = findTypesForCategory(c.children, targetCatId);
            if (found) return found;
          }
          return null;
        }

        // ── 3. 逐个产品修复 ──
        const fixItems = [];
        let modelCounter = Date.now() % 10000;
        const NO_BRAND_ID = 126745801;
        const allMappingsCache = await readUserMappings(); // 缓存一次，不在循环内反复读磁盘

        for (const prod of errorProducts) {
          const mapping = allMappingsCache.find(m => m.offer_id === prod.offer_id);
          const fixes = [];
          let newTypeId = prod.type_id;
          let newName = prod.name;

          for (const err of prod.errors) {
            // ── Fix: type不匹配 ──
            if (err.code === "description_category_has_no_description_type" || (err.code === "DESCRIPTION_DECLINE" && err.attribute_id === 8229)) {
              const tree = await getCategoryTree();
              const validTypes = findTypesForCategory(tree, prod.description_category_id);
              if (validTypes && validTypes.length > 0) {
                // 用产品名匹配最相关的type
                const nameLow = (prod.name || "").toLowerCase();
                const bestMatch = validTypes.find(t => nameLow.includes((t.type_name || "").toLowerCase().split(" ")[0])) || validTypes[0];
                newTypeId = bestMatch.type_id;
                fixes.push("type: " + bestMatch.type_id + " (" + bestMatch.type_name + ")");
              } else {
                fixes.push("type: 无法自动匹配(category " + prod.description_category_id + " 下无可用type)");
              }
            }

            // ── Fix: SPU冲突（同名商品在其他店铺）──
            if (err.code === "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT") {
              // 改名+改model让SPU唯一
              const suffix = " #" + String(++modelCounter).slice(-4);
              newName = (prod.name || "Product") + suffix;
              fixes.push("rename: " + newName.slice(0, 40));
            }

            // ── Fix: model名为空/冲突 ──
            if (err.attribute_id === 9048 || err.code === "CONDITIONAL_ATTRIBUTE_ERROR" || err.code === "double_without_merger_offer") {
              fixes.push("model: 生成唯一值");
            }

            // ── Fix: 图片分辨率/下载失败 ──
            if (err.code === "pics_invalid_dimensions" || err.code === "some_image_failed") {
              fixes.push("images: 重新处理URL");
            }

            // ── Fix: 图片含中文 ──
            if (err.code === "DESCRIPTION_DECLINE" && err.attribute_id === 4194) {
              fixes.push("images: 移除含中文图片");
            }
          }

          if (fixes.length === 0) continue;

          write({ type: "log", message: `修复 ${prod.offer_id}: ${fixes.join(" | ")}` });

          // 构建修复后的import item
          const uniqueModel = prod.offer_id.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 16) + "-" + String(++modelCounter).slice(-4);

          // 图片处理
          let images = mapping ? [mapping.primary_image_override, ...(mapping.images_override || [])].filter(Boolean) : [];
          // 移除含中文的图片（通常是第一张1688主图）
          if (prod.errors.some(e => e.code === "DESCRIPTION_DECLINE" && e.attribute_id === 4194) && images.length > 1) {
            images = images.slice(1);
          }
          // 确保URL格式正确
          images = images.map(u => {
            if (!u || !/^https?:\/\//.test(u)) return "";
            return u.replace(/_.webp$/, "").replace(/\?.+$/, "");
          }).filter(Boolean).slice(0, 6);

          const catId = mapping?.import_fields?.description_category_id || prod.description_category_id;
          const typeId = newTypeId || mapping?.import_fields?.type_id || prod.type_id;

          // 查该type的正确type_name（用于attr 8229）
          let typeName = "";
          const tree = await getCategoryTree();
          const validTypes = findTypesForCategory(tree, catId);
          if (validTypes) {
            const match = validTypes.find(t => t.type_id === typeId);
            typeName = match?.type_name || "";
          }

          fixItems.push({
            description_category_id: catId,
            type_id: typeId,
            name: newName,
            offer_id: prod.offer_id,
            barcode: "",
            price: String(mapping?.price_override || "10.00"),
            old_price: String(mapping?.old_price_override || "14.00"),
            currency_code: mapping?.currency_code || cfg.currency || "CNY",
            vat: "0",
            height: mapping?.height_override_mm || 100,
            depth: mapping?.depth_override_mm || 100,
            width: mapping?.width_override_mm || 100,
            dimension_unit: "mm",
            weight: mapping?.weight_override_g || 500,
            weight_unit: "g",
            primary_image: images[0] || "",
            images: images.slice(1),
            attributes: [
              { id: 9048, complex_id: 0, values: [{ dictionary_value_id: 0, value: uniqueModel }] },
              { id: 85, complex_id: 0, values: [{ dictionary_value_id: NO_BRAND_ID, value: "Нет бренда" }] },
              ...(typeName ? [{ id: 8229, complex_id: 0, values: [{ dictionary_value_id: typeId, value: typeName }] }] : []),
            ],
          });

          // 更新mapping文件
          if (mapping?._dir) {
            try {
              const mjsonPath = path.join(USER_PRODUCTS, mapping._dir, "ozon-import-mapping.json");
              const mData = JSON.parse(await fs.readFile(mjsonPath, "utf8"));
              mData.import_fields = mData.import_fields || {};
              mData.import_fields.type_id = typeId;
              mData.title_override = newName;
              await fs.writeFile(mjsonPath, JSON.stringify(mData, null, 2), "utf8");
            } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
          }
        }

        // ── 4. 重新提交 ──
        if (fixItems.length > 0) {
          write({ type: "log", message: `重新提交 ${fixItems.length} 个修复后的产品...` });
          const r = await ozonApi("/v3/product/import", { items: fixItems }, cfg);
          if (r.ok && r.data.result) {
            const taskId = r.data.result.task_id;
            write({ type: "log", message: `提交成功 task_id=${taskId}，等待Ozon处理...` });

            // 更新mapping的task_id
            for (const fi of fixItems) {
              const mapping = allMappingsCache.find(m => m.offer_id === fi.offer_id);
              if (mapping?._dir) {
                try {
                  const mjsonPath = path.join(USER_PRODUCTS, mapping._dir, "ozon-import-mapping.json");
                  const mData = JSON.parse(await fs.readFile(mjsonPath, "utf8"));
                  mData.ozon_task_id = taskId;
                  await fs.writeFile(mjsonPath, JSON.stringify(mData, null, 2), "utf8");
                } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
              }
            }

            await new Promise(resolve => setTimeout(resolve, 8000));

            // 检查修复结果
            const statusR = await ozonApi("/v1/product/import/info", { task_id: taskId }, cfg);
            let fixed = 0, remaining = 0;
            if (statusR.ok && statusR.data.result) {
              for (const si of (statusR.data.result.items || [])) {
                const severeErrs = (si.errors || []).filter(e => e.level === "error");
                const warnErrs = (si.errors || []).filter(e => e.level !== "error");
                if (severeErrs.length === 0 && warnErrs.length === 0) {
                  fixed++;
                  write({ type: "log", message: `  [OK] ${si.offer_id} — 零错误` });
                } else {
                  remaining++;
                  const errSummary = [...severeErrs, ...warnErrs].map(e => e.code).join(", ");
                  write({ type: "log", message: `  [ERR] ${si.offer_id} — 剩余: ${errSummary}` });
                }
              }
            }
            write({ type: "done", message: `修复完成: ${fixed} 个已修复, ${remaining} 个仍有错误`, fixed, remaining });
          } else {
            write({ type: "error", message: "提交失败: " + (r.data?.message || "API错误") });
          }
        } else {
          write({ type: "done", message: "没有可自动修复的产品", fixed: 0, remaining: errorProducts.length });
        }
      } catch (err) {
        write({ type: "error", message: "修复异常: " + err.message });
      }
      res.end();
      return;
    }

    // ─── GET /api/ozon/orders ─── fetch recent orders
    if (url.pathname === "/api/ozon/orders" && req.method === "GET") {
      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "未配置 Ozon API", orders: [] }));
          return;
        }
        const statusFilter = url.searchParams.get("status") || "";
        const filter = {};
        if (statusFilter) filter.status = statusFilter;
        // Last 30 days
        const since = new Date(Date.now() - 30 * 86400_000).toISOString();
        const to = new Date(Date.now() + 86400_000).toISOString();
        filter.since = since;
        filter.to = to;

        const r = await ozonApi("/v3/posting/fbs/list", {
          filter,
          limit: 50,
          offset: 0,
          with: { analytics_data: false, financial_data: false },
        }, cfg);

        if (r.ok && r.data.result) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ orders: r.data.result.postings || [] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: r.data.message || "API 错误", orders: [] }));
        }
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message, orders: [] }));
      }
      return;
    }

    // ─── GET /api/source/:offer_id ─── 查询商品的1688/义乌购货源链接
    if (url.pathname.startsWith("/api/source/") && req.method === "GET") {
      const offerId = safePath(decodeURIComponent(url.pathname.split("/api/source/")[1]));
      if (!offerId) { res.writeHead(400); res.end(JSON.stringify({ error: "invalid offer_id" })); return; }
      try {
        // 在知识库中查找
        const entries = await fs.readdir(USER_PRODUCTS).catch(() => []);
        let sourceUrl = "";
        let sourcePlatform = "";
        let productName = "";

        for (const dir of entries) {
          const mapPath = path.join(USER_PRODUCTS, dir, "ozon-import-mapping.json");
          try {
            const m = JSON.parse(await fs.readFile(mapPath, "utf8"));
            if (m.offer_id === offerId || dir === offerId) {
              // 找到了，读product.json拿source_url
              const pPath = path.join(USER_PRODUCTS, dir, "product.json");
              const p = JSON.parse(await fs.readFile(pPath, "utf8"));
              const best = (p.candidates || [])[0] || {};
              sourceUrl = best.source_url || p.source_url || "";
              sourcePlatform = p.source_platform || p.import_source?.split("-")[0] || "1688";
              productName = best.title || p.keyword || m.title_override || dir;
              break;
            }
          } catch (e) { if (e?.message) console.warn("warn:", e.message.slice(0, 60)); }
        }

        // 如果没有直接链接，生成1688搜索链接
        const searchUrl = sourceUrl || (productName
          ? `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(productName)}`
          : "");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          offer_id: offerId,
          source_url: sourceUrl,
          search_url: searchUrl,
          platform: sourcePlatform || "1688",
          product_name: productName,
        }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ offer_id: offerId, source_url: "", search_url: "", error: err.message }));
      }
      return;
    }

    // ─── GET /api/ozon/label/:posting_number ─── download label PDF
    if (url.pathname.startsWith("/api/ozon/label/") && req.method === "GET") {
      try {
        const postingNumber = safePath(decodeURIComponent(url.pathname.split("/api/ozon/label/")[1]));
        if (!postingNumber) { res.writeHead(400); res.end(JSON.stringify({ error: "invalid posting_number" })); return; }
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "未配置 Ozon API" }));
          return;
        }
        const ozonRes = await ozonApiRaw("/v2/posting/fbs/package-label", {
          posting_number: [postingNumber],
        }, cfg);

        if (ozonRes.ok) {
          const ct = ozonRes.headers.get("content-type") || "application/pdf";
          res.writeHead(200, {
            "Content-Type": ct,
            "Content-Disposition": `attachment; filename="label-${postingNumber}.pdf"`,
          });
          const buf = Buffer.from(await ozonRes.arrayBuffer());
          res.end(buf);
        } else {
          const errData = await ozonRes.json().catch(() => ({}));
          res.writeHead(ozonRes.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errData.message || "获取面单失败" }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── POST /api/ozon/ship ─── FBS发货: 设置物流单号 + 标记发货
    if (url.pathname === "/api/ozon/ship" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) { res.writeHead(400); res.end(JSON.stringify({ error: "未配置API" })); return; }

        const { posting_number, tracking_number, shipping_provider } = body;
        if (!posting_number) { res.writeHead(400); res.end(JSON.stringify({ error: "缺少 posting_number" })); return; }

        const results = [];

        // 1) 设置物流单号（如果有）
        if (tracking_number) {
          const tr = await ozonApi("/v2/fbs/posting/tracking-number/set", {
            posting_number,
            tracking_number,
            shipping_provider_id: 0,
          }, cfg);
          results.push({ step: "tracking", ok: tr.ok, message: tr.data?.message || "ok" });
        }

        // 2) 标记为发货中
        const dr = await ozonApi("/v2/fbs/posting/delivering", {
          posting_number: [posting_number],
        }, cfg);
        results.push({ step: "delivering", ok: dr.ok, message: dr.data?.message || "ok" });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: results.every(r => r.ok), results }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── POST /api/ozon/deliver ─── 标记已送达
    if (url.pathname === "/api/ozon/deliver" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const cfg = await loadUserOzonCfg();
        const dr = await ozonApi("/v2/fbs/posting/last-mile", {
          posting_number: [body.posting_number],
        }, cfg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: dr.ok, data: dr.data }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── GET /api/ozon/analytics ─── 商品浏览率分析（过去30天）
    if (url.pathname === "/api/ozon/analytics" && req.method === "GET") {
      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) { res.writeHead(400); res.end(JSON.stringify({ error: "未配置API" })); return; }

        const days = parseInt(url.searchParams?.get("days") || "30") || 30;
        const dateFrom = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
        const dateTo = new Date().toISOString().slice(0, 10);

        // 查浏览/转化数据
        const r = await ozonApi("/v1/analytics/data", {
          date_from: dateFrom,
          date_to: dateTo,
          metrics: ["hits_view_search", "hits_view_pdp", "hits_view", "session_view", "conv_todirect_percentage"],
          dimension: ["sku"],
          filters: [],
          limit: 1000,
          offset: 0,
          sort: [{ key: "hits_view_pdp", order: "DESC" }],
        }, cfg);

        if (r.ok && r.data.result?.data) {
          const items = r.data.result.data.map(d => ({
            sku: d.dimensions?.[0]?.id || "",
            name: d.dimensions?.[0]?.name || "",
            search_views: d.metrics?.[0] || 0,
            pdp_views: d.metrics?.[1] || 0,
            total_views: d.metrics?.[2] || 0,
            sessions: d.metrics?.[3] || 0,
            conversion_pct: d.metrics?.[4] || 0,
          }));

          // 计算总浏览量用于百分比
          const totalViews = items.reduce((s, i) => s + i.total_views, 0);
          items.forEach(i => {
            i.view_share_pct = totalViews > 0 ? Math.round(i.total_views / totalViews * 10000) / 100 : 0;
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ period: `${dateFrom} ~ ${dateTo}`, total_views: totalViews, items }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: r.data?.message || "分析API错误", items: [] }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── POST /api/ozon/prune ─── 自动下架浏览率低于阈值的商品
    if (url.pathname === "/api/ozon/prune" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) { res.writeHead(400); res.end(JSON.stringify({ error: "未配置API" })); return; }

        const threshold = parseFloat(body.threshold || "3"); // 默认3%
        const days = parseInt(body.days || "30") || 30;
        const dryRun = body.dry_run !== false; // 默认dry run

        const dateFrom = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
        const dateTo = new Date().toISOString().slice(0, 10);

        // 获取分析数据
        const ar = await ozonApi("/v1/analytics/data", {
          date_from: dateFrom, date_to: dateTo,
          metrics: ["hits_view", "session_view", "conv_todirect_percentage"],
          dimension: ["sku"], filters: [], limit: 1000, offset: 0,
          sort: [{ key: "hits_view", order: "ASC" }],
        }, cfg);

        if (!ar.ok) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: ar.data?.message || "分析API错误" }));
          return;
        }

        const data = ar.data.result?.data || [];
        const totalViews = data.reduce((s, d) => s + (d.metrics?.[0] || 0), 0);
        const toPrune = data.filter(d => {
          const views = d.metrics?.[0] || 0;
          const share = totalViews > 0 ? (views / totalViews * 100) : 0;
          return share < threshold;
        }).map(d => ({
          sku: d.dimensions?.[0]?.id || "",
          name: d.dimensions?.[0]?.name || "",
          views: d.metrics?.[0] || 0,
          share_pct: totalViews > 0 ? Math.round((d.metrics?.[0] || 0) / totalViews * 10000) / 100 : 0,
        }));

        const result = { threshold, days, total_products: data.length, total_views: totalViews, to_prune: toPrune.length, dry_run: dryRun, items: toPrune };

        // 真正下架
        if (!dryRun && toPrune.length > 0) {
          // sku → product_id 映射（分析返回的是sku，归档需要product_id）
          const skuSet = new Set(toPrune.map(p => String(p.sku)));
          let cursor = "";
          const skuToProductId = {};
          for (let page = 0; page < 10; page++) {
            const body = { filter: { visibility: "ALL" }, limit: 100 };
            if (cursor) body.cursor = cursor;
            const sr = await ozonApi("/v4/product/info/stocks", body, cfg);
            for (const item of (sr.data?.items || [])) {
              const sku = String(item.stocks?.[0]?.sku || "");
              if (skuSet.has(sku)) skuToProductId[sku] = item.product_id;
            }
            cursor = sr.data?.cursor || "";
            if (!cursor || (sr.data?.items || []).length < 100) break;
          }

          const productIds = toPrune.map(p => skuToProductId[String(p.sku)]).filter(Boolean);
          if (productIds.length) {
            const archiveR = await ozonApi("/v1/product/archive", { product_id: productIds }, cfg);
            result.archive_result = { ok: archiveR.ok, count: productIds.length, message: archiveR.data?.message || "ok" };
          } else {
            result.archive_result = { ok: false, message: "无法映射SKU到product_id" };
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── GET /api/ozon/stock-alert ─── 库存预警（低于阈值的商品）
    if (url.pathname === "/api/ozon/stock-alert" && req.method === "GET") {
      try {
        const cfg = await loadUserOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) { res.writeHead(400); res.end(JSON.stringify({ error: "未配置API" })); return; }
        const threshold = parseInt(url.searchParams?.get("threshold") || "10") || 10;

        // 获取所有库存 (v4 endpoint, paginated)
        let allStockItems = [];
        let cursor = "";
        for (let page = 0; page < 10; page++) {
          const body = { filter: { visibility: "ALL" }, limit: 100 };
          if (cursor) body.cursor = cursor;
          const r = await ozonApi("/v4/product/info/stocks", body, cfg);
          if (!r.ok) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: r.data?.message || "API错误", alerts: [] }));
            return;
          }
          allStockItems.push(...(r.data.items || []));
          cursor = r.data.cursor || "";
          if (!cursor || (r.data.items || []).length < 100) break;
        }

        const alerts = [];
        for (const item of allStockItems) {
          const stocks = item.stocks || [];
          const fbsStock = stocks.find(s => s.type === "rfbs" || s.type === "fbs");
          const qty = fbsStock?.present || 0;
          if (qty < threshold) {
            alerts.push({
              product_id: item.product_id,
              offer_id: item.offer_id,
              stock: qty,
              warehouse_id: fbsStock?.warehouse_id,
            });
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ threshold, total_products: allStockItems.length, low_stock: alerts.length, alerts }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── Legacy redirect: old endpoints → new paths ───
    if (url.pathname === "/api/ozon-config") {
      const newPath = "/api/ozon/config";
      res.writeHead(307, { Location: newPath });
      res.end();
      return;
    }
    if (url.pathname === "/api/ozon-test") {
      res.writeHead(307, { Location: "/api/ozon/check" });
      res.end();
      return;
    }
    if (url.pathname === "/api/upload-ready") {
      res.writeHead(307, { Location: "/api/ozon/upload-ready" });
      res.end();
      return;
    }
    if (url.pathname === "/api/upload-all" && req.method === "POST") {
      res.writeHead(307, { Location: "/api/ozon/upload" });
      res.end();
      return;
    }
    if (url.pathname === "/api/orders") {
      res.writeHead(307, { Location: "/api/ozon/orders" });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/label/")) {
      const pn = url.pathname.split("/api/label/")[1];
      res.writeHead(307, { Location: "/api/ozon/label/" + pn });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`\n  Ozon Pilot 管理控制台已启动`);
    console.log(`  ➜ http://localhost:${port}\n`);
    console.log(`  功能:`);
    console.log(`    - Ozon API 配置 (保存到 ai选品/config/ozon-api.json)`);
    console.log(`    - 查看1688/拼多多登录状态`);
    console.log(`    - 一键打开登录窗口扫码`);
    console.log(`    - 登录后自动保存cookie`);
    console.log(`    - 智能选品 (词库驱动)`);
    console.log(`    - 产品库浏览与搜索`);
    console.log(`    - 运行采集管道`);
    console.log(`    - Ozon v3/product/import 批量上架`);
    console.log(`    - 库存批量设置`);
    console.log(`    - 订单监控与面单PDF下载\n`);
  });
}

const args = parseCliArgs(process.argv.slice(2), { port: "3456" });
const port = parseInt(process.env.PORT || args.port || "3456");
createServer(port);

/* ─── 后台定时监测 (每30分钟) ─── */
const MONITOR_INTERVAL = 30 * 60 * 1000; // 30分钟
const STOCK_THRESHOLD = 10;

async function backgroundMonitor() {
  try {
    const cfg = await loadOzonCfg();
    if (!cfg.clientId || !cfg.apiKey) return;
    const ts = new Date().toLocaleTimeString();

    // 1) 拉取新订单
    const since = new Date(Date.now() - MONITOR_INTERVAL - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const ordersR = await ozonApi("/v3/posting/fbs/list", {
      filter: { status: "awaiting_packaging", since, to },
      limit: 50, offset: 0,
      with: { analytics_data: false, financial_data: false },
    }, cfg);
    const newOrders = ordersR.ok ? (ordersR.data.result?.postings || []) : [];
    if (newOrders.length) {
      console.log(`\n[${ts}] 📦 ${newOrders.length} 个新订单待处理!`);
      newOrders.forEach(o => console.log(`  → ${o.posting_number} | ${o.products?.map(p => p.name?.slice(0, 25)).join(", ")}`));
    }

    // 2) 库存预警
    const stockR = await ozonApi("/v4/product/info/stocks", { filter: { visibility: "ALL" }, limit: 100 }, cfg);
    const stockItems = stockR.ok ? (stockR.data.items || []) : [];
    const lowStock = stockItems.filter(i => {
      const s = (i.stocks || []).find(s => s.type === "rfbs" || s.type === "fbs");
      return s && s.present < STOCK_THRESHOLD && s.present >= 0;
    });
    if (lowStock.length) {
      console.log(`[${ts}] ⚠ 库存预警: ${lowStock.length} 个商品库存 < ${STOCK_THRESHOLD}`);
      lowStock.slice(0, 5).forEach(i => {
        const s = (i.stocks || []).find(s => s.type === "rfbs" || s.type === "fbs");
        console.log(`  → ${i.offer_id?.slice(0, 25)} | 库存: ${s?.present}`);
      });
    }
  } catch (err) {
    // 静默失败，不阻塞服务器
  }
}

// 启动后等30秒执行第一次，之后每30分钟
setTimeout(backgroundMonitor, 30_000);
setInterval(backgroundMonitor, MONITOR_INTERVAL);
console.log(`  后台监测: 每30分钟 (订单+库存预警)`);

/* ─── 自动选品上架循环 (每6小时) ─── */
const AUTO_CYCLE_INTERVAL = 30 * 60_000; // 30分钟
let autoCycleRunning = false;

async function autoCycle() {
  if (autoCycleRunning) return;
  autoCycleRunning = true;
  const ts = new Date().toLocaleTimeString();
  console.log(`\n[${ts}] 自动循环: 选品上架 + 淘汰低效...`);
  try {
    const { execFile } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      const child = execFile("node", [
        path.resolve("scripts", "auto-cycle.js"),
      ], { cwd: path.resolve(""), timeout: 900_000, env: process.env });
      child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
      child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      child.on("close", (code) => {
        console.log(`[${new Date().toLocaleTimeString()}] 自动循环完成 (exit: ${code})`);
        resolve();
      });
      child.on("error", reject);
    });
  } catch (e) {
    console.log(`[auto-cycle] 异常: ${e.message?.slice(0, 60)}`);
  }
  autoCycleRunning = false;
}

// 启动后5分钟跑第一轮，之后每6小时
setTimeout(autoCycle, 5 * 60_000);
setInterval(autoCycle, AUTO_CYCLE_INTERVAL);
console.log(`  自动循环: 每30分钟 (8件选品上架, 约384件/天)`);
