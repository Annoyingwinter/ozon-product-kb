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
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { readJson, writeJson, ensureDir, parseCliArgs } from "./lib/shared.js";
import { launchBrowser, saveSession, closeBrowser, detectPageType } from "./lib/browser.js";

/* ─── Project root paths ─── */
const AI_ROOT = path.resolve(".");
const KB_PRODUCTS = path.join(AI_ROOT, "knowledge-base", "products");
const OZON_CONFIG_DIR = path.join(AI_ROOT, "config");
const OZON_CONFIG_PATH = path.join(OZON_CONFIG_DIR, "ozon-api.json");

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
  });
  return { status: r.status, ok: r.ok, data: await r.json() };
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
    } catch {}
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
  const expired = domainCookies.filter(c => c.expires && c.expires > 0 && c.expires < now);
  const valid = domainCookies.filter(c => !c.expires || c.expires <= 0 || c.expires > now);

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

  return {
    valid: valid.length > 0 && keyCookies.length > 0,
    totalCookies: domainCookies.length,
    validCookies: valid.length,
    expiredCookies: expired.length,
    daysUntilExpiry: daysLeft,
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

  const page = await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

  activeSessions[platform] = { context, browser, page, status: "waiting_login" };
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
        const hasKeyCookie = domainCookies.some(c => keyNames.some(k => c.name?.includes(k)));
        // Ozon登录后URL会跳到seller.ozon.ru/app，靠URL判断即可
        cookieReady = platform === "ozon"
          ? domainCookies.length >= 5
          : hasKeyCookie && domainCookies.length >= 3;
        if (cookieReady) {
          console.log(`[${platform}] 检测到登录cookie: ${domainCookies.length}个 (含关键cookie)`);
        }
      } catch {}

      if (urlLeft || cookieReady) {
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
      } catch {}
    }
  } else {
    console.log("[ozon] 未能从页面提取API信息，可能需要在Ozon后台先生成API Key");
  }
}

// ─── HTTP 服务器 ───
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ozon Pilot</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --s0: #060810;
      --s1: #0c0f19;
      --s2: #121624;
      --s3: #191e30;
      --s4: #212740;
      --edge: rgba(140,160,220,0.08);
      --edge-hi: rgba(140,160,220,0.16);
      --t0: #e8ecf4;
      --t1: #94a0b8;
      --t2: #586478;
      --t3: #384050;
      --ok: #34d399;
      --ok-bg: rgba(52,211,153,0.07);
      --ok-ring: rgba(52,211,153,0.25);
      --warn: #f59e0b;
      --warn-bg: rgba(245,158,11,0.07);
      --warn-ring: rgba(245,158,11,0.25);
      --info: #818cf8;
      --info-bg: rgba(129,140,248,0.07);
      --info-ring: rgba(129,140,248,0.25);
      --err: #f87171;
      --err-bg: rgba(248,113,113,0.07);
      --err-ring: rgba(248,113,113,0.25);
      --off: #475569;
      --sans: 'Plus Jakarta Sans', system-ui, sans-serif;
      --mono: 'DM Mono', 'Consolas', monospace;
      --ease: cubic-bezier(0.25, 1, 0.5, 1);
      --ease-snappy: cubic-bezier(0.16, 1, 0.3, 1);
      --r: 8px;
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--sans);
      background: var(--s0);
      color: var(--t0);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      line-height: 1.55;
      background-image: radial-gradient(rgba(140,160,220,0.03) 1px, transparent 1px);
      background-size: 24px 24px;
    }

    /* ── header ── */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 56px;
      padding: 0 24px;
      background: var(--s1);
      border-bottom: 1px solid var(--edge);
    }
    .hdr-left { display: flex; align-items: center; gap: 12px; }
    .hdr-logo {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, var(--ok), #22d3ee);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 700;
      color: var(--s0);
      letter-spacing: -0.04em;
      flex-shrink: 0;
    }
    .hdr-dot {
      width: 8px; height: 8px;
      background: var(--ok);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--ok-ring);
      animation: dot-pulse 3s ease-in-out infinite;
    }
    @keyframes dot-pulse {
      0%,100% { opacity: .6; }
      50% { opacity: 1; box-shadow: 0 0 14px var(--ok-ring); }
    }
    .hdr-name {
      font-weight: 700;
      font-size: 15px;
      letter-spacing: -0.02em;
    }
    .hdr-name em {
      font-style: normal;
      font-weight: 400;
      color: var(--t2);
      font-size: 13px;
      margin-left: 8px;
    }
    .hdr-ver {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--t3);
      background: rgba(140,160,220,0.06);
      padding: 2px 7px;
      border-radius: 4px;
      letter-spacing: 0.02em;
    }
    .hdr-right { display: flex; align-items: center; gap: 14px; }
    .hdr-time {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--t2);
    }

    /* ── tab nav ── */
    .tab-nav {
      display: flex;
      gap: 0;
      background: var(--s1);
      border-bottom: 1px solid var(--edge);
      padding: 0 24px;
    }
    .tab-btn {
      font-family: var(--sans);
      font-weight: 600;
      font-size: 13px;
      padding: 10px 20px;
      border: none;
      background: none;
      color: var(--t2);
      cursor: pointer;
      position: relative;
      transition: color 200ms var(--ease);
    }
    .tab-btn:hover { color: var(--t1); }
    .tab-btn.active { color: var(--t0); }
    .tab-btn.active::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 12px;
      right: 12px;
      height: 2px;
      background: var(--ok);
      border-radius: 2px 2px 0 0;
    }
    .tab-btn .tab-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      margin-left: 6px;
      border-radius: 9px;
      font-size: 10px;
      font-weight: 700;
      font-family: var(--mono);
      background: var(--err-bg);
      color: var(--err);
      vertical-align: middle;
    }
    .tab-content { display: none; opacity: 0; transition: opacity 250ms var(--ease); }
    .tab-content.active { display: block; opacity: 1; animation: tab-fade-in 250ms var(--ease); }
    @keyframes tab-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* ── main ── */
    .wrap {
      max-width: 900px;
      margin: 0 auto;
      padding: 32px 20px 64px;
    }

    /* ── stats bar ── */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: linear-gradient(160deg, var(--s2), var(--s1));
      border: 1px solid var(--edge);
      border-radius: var(--r);
      padding: 18px 16px;
      text-align: center;
      transition: border-color 200ms var(--ease), transform 200ms var(--ease);
    }
    .stat-card:hover {
      border-color: var(--edge-hi);
      transform: translateY(-1px);
    }
    .stat-icon {
      font-size: 16px;
      margin-bottom: 6px;
      display: block;
      opacity: 0.8;
    }
    .stat-val {
      font-family: var(--mono);
      font-size: 24px;
      font-weight: 700;
      color: var(--t0);
      line-height: 1.2;
    }
    .stat-val.ok { color: var(--ok); }
    .stat-val.warn { color: var(--warn); }
    .stat-val.info { color: var(--info); }
    .stat-val.info.pulse-ready {
      animation: ready-pulse 2s ease-in-out infinite;
    }
    @keyframes ready-pulse {
      0%,100% { opacity: 0.7; text-shadow: none; }
      50% { opacity: 1; text-shadow: 0 0 12px var(--info-ring); }
    }
    .stat-label {
      font-size: 11px;
      color: var(--t2);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    /* ── section titles ── */
    .sec {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--t2);
      margin-bottom: 12px;
      padding-left: 12px;
      border-left: 3px solid var(--info);
    }

    /* ── collapsible section ── */
    .collapse-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
      margin-bottom: 12px;
    }
    .collapse-header .sec { margin-bottom: 0; }
    .collapse-arrow {
      font-size: 10px;
      color: var(--t2);
      transition: transform 200ms var(--ease);
    }
    .collapse-header.collapsed .collapse-arrow { transform: rotate(-90deg); }
    .collapse-body { overflow: hidden; transition: max-height 300ms var(--ease-snappy); }
    .collapse-body.collapsed { max-height: 0 !important; }

    /* ── platform row ── */
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 12px;
    }
    .row-full {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      margin-bottom: 32px;
    }
    .tile {
      background: var(--s2);
      border: 1px solid var(--edge);
      border-radius: var(--r);
      padding: 24px 20px;
      position: relative;
      transition: border-color 300ms var(--ease), transform 300ms var(--ease);
      overflow: hidden;
    }
    .tile:hover {
      border-color: var(--edge-hi);
      transform: translateY(-2px);
    }
    .tile::after {
      content: '';
      position: absolute;
      inset: -1px -1px auto -1px;
      height: 3px;
      border-radius: var(--r) var(--r) 0 0;
      background: var(--off);
      transition: background 400ms var(--ease);
    }
    .tile.live::after { background: linear-gradient(90deg, var(--ok), transparent 70%); }
    .tile.expiring::after { background: linear-gradient(90deg, var(--warn), transparent 70%); }
    /* platform-specific accent lines */
    .tile.plat-1688::after { background: linear-gradient(90deg, #f97316, transparent 70%); }
    .tile.plat-1688.live::after { background: linear-gradient(90deg, #f97316, var(--ok) 70%); }
    .tile.plat-pdd::after { background: linear-gradient(90deg, #ef4444, transparent 70%); }
    .tile.plat-pdd.live::after { background: linear-gradient(90deg, #ef4444, var(--ok) 70%); }
    .tile.plat-ozon::after { background: linear-gradient(90deg, #3b82f6, transparent 70%); }
    .tile.plat-ozon.live::after { background: linear-gradient(90deg, #3b82f6, var(--ok) 70%); }
    /* platform watermark */
    .tile .tile-watermark {
      position: absolute;
      right: 12px;
      bottom: 8px;
      font-size: 48px;
      opacity: 0.035;
      pointer-events: none;
      user-select: none;
      line-height: 1;
    }

    .tile-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .tile-label {
      font-weight: 600;
      font-size: 15px;
      letter-spacing: -0.01em;
    }
    .tile-sub {
      font-size: 12px;
      color: var(--t2);
      margin-top: 2px;
    }

    /* ── status pill ── */
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 99px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 500;
    }
    .pill i {
      width: 6px; height: 6px;
      border-radius: 50%;
      display: block;
    }
    .pill-ok { background: var(--ok-bg); color: var(--ok); }
    .pill-ok i { background: var(--ok); box-shadow: 0 0 6px var(--ok-ring); }
    .pill-warn { background: var(--warn-bg); color: var(--warn); }
    .pill-warn i { background: var(--warn); box-shadow: 0 0 6px var(--warn-ring); animation: dot-pulse-warn 2s ease-in-out infinite; }
    @keyframes dot-pulse-warn {
      0%,100% { opacity: .6; }
      50% { opacity: 1; }
    }
    .pill-off { background: rgba(255,255,255,0.04); color: var(--t3); }
    .pill-off i { background: var(--t3); }
    .pill-info { background: var(--info-bg); color: var(--info); }
    .pill-info i { background: var(--info); box-shadow: 0 0 6px var(--info-ring); }
    .pill-err { background: var(--err-bg); color: var(--err); }
    .pill-err i { background: var(--err); box-shadow: 0 0 6px var(--err-ring); }

    /* ── kv pairs ── */
    .kv { margin-bottom: 16px; }
    .kv-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 6px 0;
    }
    .kv-row + .kv-row { border-top: 1px solid var(--edge); }
    .kv-k { font-size: 13px; color: var(--t1); }
    .kv-v { font-family: var(--mono); font-size: 13px; font-weight: 500; }

    /* ── buttons ── */
    .act {
      font-family: var(--sans);
      font-weight: 600;
      font-size: 13px;
      padding: 8px 16px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      transition: all 200ms var(--ease);
    }
    .act-go {
      background: var(--ok-bg);
      color: var(--ok);
      border: 1px solid rgba(52,211,153,0.2);
    }
    .act-go:hover {
      background: rgba(52,211,153,0.14);
      border-color: var(--ok);
      box-shadow: 0 2px 12px var(--ok-bg);
    }
    .act-info {
      background: var(--info-bg);
      color: var(--info);
      border: 1px solid rgba(129,140,248,0.2);
    }
    .act-info:hover {
      background: rgba(129,140,248,0.14);
      border-color: var(--info);
      box-shadow: 0 2px 12px var(--info-bg);
    }
    .act-warn {
      background: var(--warn-bg);
      color: var(--warn);
      border: 1px solid rgba(245,158,11,0.2);
    }
    .act-warn:hover {
      background: rgba(245,158,11,0.14);
      border-color: var(--warn);
    }
    .act-dl {
      background: rgba(52,211,153,0.08);
      color: var(--ok);
      border: 1px solid rgba(52,211,153,0.2);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .act-dl:hover {
      background: rgba(52,211,153,0.18);
      border-color: var(--ok);
    }
    .act-dl::before {
      content: '\\2193';
      font-size: 14px;
      font-weight: 700;
    }
    .act:disabled { opacity: 0.3; cursor: not-allowed; }

    /* ── launch buttons ── */
    .launch {
      width: 100%;
      padding: 18px;
      font-family: var(--sans);
      font-weight: 700;
      font-size: 15px;
      letter-spacing: -0.01em;
      border: 1px solid rgba(52,211,153,0.18);
      border-radius: var(--r);
      background: linear-gradient(180deg, var(--ok-bg), transparent);
      color: var(--ok);
      cursor: pointer;
      transition: all 400ms var(--ease-snappy);
    }
    .launch:hover:not(:disabled) {
      border-color: var(--ok);
      box-shadow: 0 6px 32px -4px var(--ok-ring);
      transform: translateY(-2px);
    }
    .launch:active:not(:disabled) { transform: translateY(0); }
    .launch:disabled {
      border-color: var(--edge);
      background: var(--s2);
      color: var(--t3);
      cursor: not-allowed;
      box-shadow: none;
    }
    .launch-info {
      border-color: rgba(129,140,248,0.18);
      background: linear-gradient(180deg, var(--info-bg), transparent);
      color: var(--info);
    }
    .launch-info:hover:not(:disabled) {
      border-color: var(--info);
      box-shadow: 0 6px 32px -4px var(--info-ring);
    }

    /* ── log ── */
    .log-wrap {
      margin-top: 12px;
      border: 1px solid var(--edge);
      border-radius: var(--r);
      overflow: hidden;
      display: none;
    }
    .log-wrap.open {
      display: block;
      animation: reveal 400ms var(--ease-snappy);
    }
    @keyframes reveal {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .log-bar {
      display: flex;
      justify-content: space-between;
      padding: 8px 14px;
      background: var(--s1);
      border-bottom: 1px solid var(--edge);
      font-size: 11px;
      color: var(--t2);
    }
    .log-out {
      padding: 14px 16px;
      background: var(--s0);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.8;
      color: var(--t1);
      max-height: 340px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-out::-webkit-scrollbar { width: 3px; }
    .log-out::-webkit-scrollbar-thumb { background: var(--t3); border-radius: 2px; }

    /* ── select section ── */
    .select-meta {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .select-meta-item {
      font-size: 12px;
      color: var(--t2);
    }
    .select-meta-item strong {
      color: var(--t1);
      font-family: var(--mono);
    }

    /* ── search box ── */
    .search-box {
      width: 100%;
      padding: 10px 14px;
      font-family: var(--sans);
      font-size: 13px;
      background: var(--s2);
      border: 1px solid var(--edge);
      border-radius: var(--r);
      color: var(--t0);
      outline: none;
      transition: border-color 200ms var(--ease);
      margin-bottom: 16px;
    }
    .search-box::placeholder { color: var(--t3); }
    .search-box:focus {
      border-color: var(--edge-hi);
      box-shadow: 0 0 0 3px rgba(140,160,220,0.06);
    }

    /* ── product table ── */
    .ptable {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .ptable th {
      text-align: left;
      padding: 10px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--t2);
      border-bottom: 1px solid var(--edge);
      background: var(--s1);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .ptable td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--edge);
      color: var(--t1);
      vertical-align: top;
    }
    .ptable tbody tr:nth-child(even):not(.pdetail-row) { background: rgba(140,160,220,0.015); }
    .ptable tr.prow {
      cursor: pointer;
      transition: background 150ms var(--ease);
    }
    .ptable tr.prow:hover { background: var(--s3); }
    .ptable tr.prow.expanded { background: var(--s2); }
    .ptable .pname {
      color: var(--t0);
      font-weight: 500;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ptable .pscore {
      font-family: var(--mono);
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .score-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .score-dot-hi { background: var(--ok); box-shadow: 0 0 6px var(--ok-ring); }
    .score-dot-mid { background: var(--warn); box-shadow: 0 0 6px var(--warn-ring); }
    .score-dot-lo { background: var(--off); }
    .score-hi { color: var(--ok); }
    .score-mid { color: var(--warn); }
    .score-lo { color: var(--off); }
    .ptable th.sortable {
      cursor: pointer;
      user-select: none;
      transition: color 150ms var(--ease);
    }
    .ptable th.sortable:hover { color: var(--t0); }
    .ptable th .sort-arrow {
      font-size: 9px;
      margin-left: 4px;
      opacity: 0.4;
    }
    .ptable th.sort-active .sort-arrow { opacity: 1; color: var(--ok); }

    /* ── product detail row ── */
    .pdetail-row td {
      padding: 0;
      border-bottom: 1px solid var(--edge);
    }
    .pdetail {
      padding: 16px 20px;
      background: var(--s2);
      animation: reveal 300ms var(--ease-snappy);
    }
    .pdetail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 24px;
    }
    .pdetail-section { margin-bottom: 12px; }
    .pdetail-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--t2);
      margin-bottom: 6px;
    }
    .pdetail p { font-size: 13px; color: var(--t1); line-height: 1.6; }
    .pdetail a {
      color: var(--info);
      text-decoration: none;
      font-size: 12px;
      font-family: var(--mono);
    }
    .pdetail a:hover { text-decoration: underline; }
    .score-breakdown { display: flex; flex-wrap: wrap; gap: 6px; }
    .score-chip {
      font-family: var(--mono);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--s3);
      color: var(--t1);
      border: 1px solid var(--edge);
    }
    .score-chip strong { color: var(--t0); }

    /* stage pills */
    .stage-pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 8px;
      border-radius: 4px;
    }
    .stage-approved { background: var(--ok-bg); color: var(--ok); }
    .stage-evaluated { background: var(--info-bg); color: var(--info); }
    .stage-draft { background: var(--warn-bg); color: var(--warn); }
    .stage-other { background: rgba(255,255,255,0.04); color: var(--t2); }

    /* ── product table wrapper ── */
    .ptable-wrap {
      border: 1px solid var(--edge);
      border-radius: var(--r);
      overflow: auto;
      max-height: 600px;
    }
    .ptable-wrap::-webkit-scrollbar { width: 3px; }
    .ptable-wrap::-webkit-scrollbar-thumb { background: var(--t3); border-radius: 2px; }

    .products-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .products-count {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--t1);
      background: var(--info-bg);
      padding: 4px 10px;
      border-radius: 12px;
      border: 1px solid rgba(129,140,248,0.12);
    }
    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--t3);
      font-size: 14px;
    }
    .empty-state-icon {
      font-size: 36px;
      margin-bottom: 12px;
      opacity: 0.5;
      display: block;
    }

    /* ── config inputs ── */
    .cfg-row {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
      align-items: center;
    }
    .cfg-input {
      flex: 1;
      padding: 12px 16px;
      font-family: var(--mono);
      font-size: 14px;
      background: var(--s1);
      border: 1px solid var(--edge);
      border-radius: var(--r);
      color: var(--t0);
      outline: none;
      transition: border-color 200ms var(--ease), box-shadow 200ms var(--ease);
    }
    .cfg-input::placeholder { color: var(--t3); }
    .cfg-input:focus {
      border-color: var(--info);
      box-shadow: 0 0 0 3px var(--info-bg);
    }
    .cfg-label {
      font-size: 12px;
      color: var(--t2);
      min-width: 80px;
      text-align: right;
      font-weight: 500;
    }
    /* config save checkmark animation */
    .cfg-saved-check {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--ok);
      font-size: 13px;
      font-weight: 600;
      animation: check-pop 500ms var(--ease-snappy);
    }
    @keyframes check-pop {
      0% { transform: scale(0.5); opacity: 0; }
      60% { transform: scale(1.15); }
      100% { transform: scale(1); opacity: 1; }
    }
    .cfg-btn-row {
      display: flex;
      gap: 10px;
      margin-top: 8px;
      align-items: center;
    }
    .cfg-status {
      font-family: var(--mono);
      font-size: 12px;
      margin-top: 8px;
    }
    .cfg-status.connected { color: var(--ok); }
    .cfg-status.disconnected { color: var(--t3); }

    /* ── config meta row ── */
    .cfg-meta {
      display: flex;
      gap: 20px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--edge);
      flex-wrap: wrap;
    }
    .cfg-meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--t2);
    }
    .cfg-meta-item strong {
      font-family: var(--mono);
      color: var(--t1);
      font-weight: 500;
    }
    .cfg-meta-icon {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      opacity: 0.6;
    }

    /* ── upload section ── */
    .upload-stats {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-bottom: 12px;
    }
    .upload-stat {
      font-size: 13px;
      color: var(--t1);
    }
    .upload-stat strong {
      font-family: var(--mono);
      color: var(--ok);
    }
    .upload-result {
      display: flex;
      gap: 16px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .upload-result .pill { font-size: 12px; }

    /* ── progress bar ── */
    .progress-wrap {
      width: 100%;
      height: 8px;
      background: var(--s3);
      border-radius: 4px;
      overflow: hidden;
      margin: 12px 0;
      display: none;
    }
    .progress-wrap.active { display: block; }
    .progress-bar {
      height: 100%;
      border-radius: 4px;
      background: linear-gradient(90deg, var(--ok), #22d3ee, var(--ok));
      background-size: 200% 100%;
      transition: width 300ms var(--ease);
      position: relative;
    }
    .progress-bar.animate {
      animation: progress-shimmer 1.5s linear infinite;
      box-shadow: 0 0 12px var(--ok-ring), 0 0 4px rgba(34,211,238,0.3);
    }
    @keyframes progress-shimmer {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
    .progress-text {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--t1);
      margin-top: 4px;
    }

    /* ── upload results table ── */
    .result-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 12px;
    }
    .result-table th {
      text-align: left;
      padding: 8px 10px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--t2);
      border-bottom: 1px solid var(--edge);
      background: var(--s1);
    }
    .result-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--edge);
      color: var(--t1);
      font-family: var(--mono);
    }
    .result-table tbody tr:nth-child(even) { background: rgba(140,160,220,0.02); }
    .result-table tbody tr:hover { background: var(--s3); }
    .result-table .r-ok { color: var(--ok); }
    .result-table .r-err { color: var(--err); }

    /* ── orders section ── */
    .order-card {
      background: var(--s2);
      border: 1px solid var(--edge);
      border-radius: var(--r);
      padding: 16px 20px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: border-color 200ms var(--ease), transform 200ms var(--ease);
    }
    .order-card:hover { border-color: var(--edge-hi); transform: translateY(-1px); }
    .order-card + .order-card { border-top: none; }
    .orders-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .orders-last-update {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--t3);
    }
    .order-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }
    .order-id {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--t0);
      font-weight: 500;
    }
    .order-detail {
      font-size: 12px;
      color: var(--t2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .order-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 8px;
      border-radius: 4px;
    }
    .os-awaiting { background: var(--warn-bg); color: var(--warn); }
    .os-delivering { background: var(--info-bg); color: var(--info); }
    .os-delivered { background: var(--ok-bg); color: var(--ok); }
    .os-other { background: rgba(255,255,255,0.04); color: var(--t2); }
    .order-actions { display: flex; gap: 8px; flex-shrink: 0; margin-left: 12px; }
    .order-total {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--t0);
      font-weight: 600;
      white-space: nowrap;
    }

    footer {
      margin-top: 48px;
      text-align: center;
      font-size: 11px;
      color: var(--t3);
      padding: 20px 0;
      border-top: 1px solid var(--edge);
    }
    footer .footer-brand {
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    /* ── loading spinner ── */
    .spinner {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid var(--edge-hi);
      border-top-color: var(--ok);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 600px) {
      .row { grid-template-columns: 1fr; }
      .stats-bar { grid-template-columns: 1fr 1fr; }
      .pdetail-grid { grid-template-columns: 1fr; }
      .tab-btn { padding: 10px 14px; font-size: 12px; }
      .order-card { flex-direction: column; gap: 10px; align-items: flex-start; }
      .order-actions { margin-left: 0; }
      .cfg-row { flex-direction: column; gap: 6px; }
      .cfg-label { text-align: left; min-width: auto; }
      .cfg-meta { flex-direction: column; gap: 8px; }
      .cfg-btn-row { flex-wrap: wrap; }
      .orders-meta { flex-direction: column; align-items: flex-start; gap: 8px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="hdr-left">
      <div class="hdr-logo">OP</div>
      <div class="hdr-dot"></div>
      <div class="hdr-name">Ozon Pilot<em>管理控制台</em></div>
      <span class="hdr-ver">v1.0</span>
    </div>
    <div class="hdr-right">
      <div class="hdr-time" id="clock"></div>
    </div>
  </header>

  <nav class="tab-nav">
    <button class="tab-btn active" onclick="switchTab('console')">控制台</button>
    <button class="tab-btn" onclick="switchTab('products')">产品库</button>
    <button class="tab-btn" onclick="switchTab('orders')">订单<span class="tab-badge" id="orders-badge" style="display:none;">0</span></button>
  </nav>

  <!-- TAB: 控制台 -->
  <div class="tab-content active" id="tab-console">
    <div class="wrap">
      <!-- stats bar -->
      <div class="stats-bar" id="stats-bar">
        <div class="stat-card"><span class="stat-icon">&#128230;</span><div class="stat-val" id="stat-products">--</div><div class="stat-label">产品总数</div></div>
        <div class="stat-card"><span class="stat-icon">&#9989;</span><div class="stat-val ok" id="stat-approved">--</div><div class="stat-label">已审核</div></div>
        <div class="stat-card"><span class="stat-icon">&#128640;</span><div class="stat-val info" id="stat-ready">--</div><div class="stat-label">就绪</div></div>
        <div class="stat-card"><span class="stat-icon">&#128273;</span><div class="stat-val warn" id="stat-keywords">--</div><div class="stat-label">词库</div></div>
      </div>

      <!-- Ozon API Config (collapsible) -->
      <div class="collapse-header" id="cfg-collapse-hdr" onclick="toggleCollapse('cfg')">
        <div class="sec" style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:14px;opacity:0.6;">&#128272;</span> Ozon API 配置
        </div>
        <span class="collapse-arrow">&#9660;</span>
      </div>
      <div class="collapse-body" id="cfg-collapse-body" style="max-height:600px;">
        <div class="tile" id="ozon-cfg-tile" style="margin-bottom:28px;">
          <div class="tile-head">
            <div><div class="tile-label">Ozon Seller API</div><div class="tile-sub">api-seller.ozon.ru</div></div>
            <span class="pill pill-off" id="ozon-cfg-pill"><i></i>未配置</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-label">Client-Id</span>
            <input class="cfg-input" id="ozon-client-id" type="text" placeholder="输入 Ozon Client-Id" autocomplete="off">
          </div>
          <div class="cfg-row">
            <span class="cfg-label">Api-Key</span>
            <input class="cfg-input" id="ozon-api-key" type="password" placeholder="输入 Ozon Api-Key" autocomplete="off">
          </div>
          <div class="cfg-btn-row">
            <button class="act act-go" onclick="saveOzonConfig()">保存</button>
            <button class="act act-info" onclick="testOzonConnection()">测试连接</button>
            <button class="act act-warn" onclick="window.open('https://seller.ozon.ru/app/settings/api-keys','_blank')">打开API Key管理页</button>
            <span id="cfg-save-check"></span>
          </div>
          <div class="cfg-status disconnected" id="ozon-cfg-status"></div>
          <div class="cfg-meta" id="ozon-cfg-meta" style="display:none;">
            <div class="cfg-meta-item"><span class="cfg-meta-icon">&#9881;</span> 仓库: <strong id="cfg-wh-id">--</strong></div>
            <div class="cfg-meta-item"><span class="cfg-meta-icon">&#128176;</span> 货币: <strong id="cfg-currency">CNY</strong></div>
            <div class="cfg-meta-item"><span class="cfg-meta-icon">&#127981;</span> 仓库名: <strong id="cfg-wh-name">--</strong></div>
          </div>
        </div>
      </div>

      <div class="sec">数据源</div>
      <div id="platforms"></div>

      <div class="sec">智能选品</div>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px;">
        <button class="launch launch-info" id="select-btn" onclick="runSelect()" style="flex:1;">启动选品</button>
      </div>
      <div class="select-meta" id="select-meta"></div>
      <div class="log-wrap" id="select-log-panel">
        <div class="log-bar">
          <span>选品输出</span>
          <span id="select-log-status"></span>
        </div>
        <div class="log-out" id="select-log"></div>
      </div>

      <div style="height:28px;"></div>

      <div class="sec">管道</div>
      <button class="launch" id="pipeline-btn" onclick="runPipeline()">启动采集管道</button>
      <div class="log-wrap" id="log-panel">
        <div class="log-bar">
          <span>输出</span>
          <span id="log-status"></span>
        </div>
        <div class="log-out" id="pipeline-log"></div>
      </div>

      <div style="height:28px;"></div>

      <div class="sec">一键上架</div>
      <div class="tile" style="margin-bottom:12px;">
        <div class="tile-head">
          <div><div class="tile-label">Ozon 批量上架</div><div class="tile-sub">从知识库直接上传到 Ozon</div></div>
          <span class="pill pill-info" id="upload-ready-pill"><i></i>检查中...</span>
        </div>
        <div class="upload-stats" id="upload-stats"></div>
        <div style="display:flex;gap:10px;">
          <button class="launch" id="upload-btn" onclick="runUpload()" disabled style="flex:1;">开始上架</button>
          <button class="act act-warn" id="stock-btn" onclick="setStock()" style="display:none;">设置库存 (100)</button>
        </div>
        <div class="progress-wrap" id="upload-progress-wrap">
          <div class="progress-bar animate" id="upload-progress-bar" style="width:0%;"></div>
        </div>
        <div class="progress-text" id="upload-progress-text"></div>
        <div class="upload-result" id="upload-result"></div>
        <div id="upload-result-table"></div>
      </div>
      <div class="log-wrap" id="upload-log-panel">
        <div class="log-bar">
          <span>上架日志</span>
          <span id="upload-log-status"></span>
        </div>
        <div class="log-out" id="upload-log"></div>
      </div>

      <!-- 错误检查 & 修复 -->
      <div class="sec" style="margin-top:32px;">商品健康检查</div>
      <div class="tile">
        <div class="tile-head">
          <div>
            <div class="tile-label">Ozon 错误扫描</div>
            <div class="tile-sub">检查已上架商品的严重/非严重错误</div>
          </div>
          <span class="pill pill-off" id="error-check-pill"><i></i>未检查</span>
        </div>
        <div id="error-summary" style="margin:12px 0;font-size:13px;color:var(--t1);"></div>
        <div style="display:flex;gap:10px;">
          <button class="act act-info" onclick="checkErrors()">扫描错误</button>
          <button class="act act-go" id="fix-btn" onclick="runAutoFix()" style="display:none;">一键修复</button>
        </div>
        <div id="error-list" style="margin-top:12px;max-height:300px;overflow-y:auto;"></div>
        <div class="log-wrap" id="fix-log-panel">
          <div class="log-bar">
            <span>修复日志</span>
            <span id="fix-log-status"></span>
          </div>
          <div class="log-out" id="fix-log"></div>
        </div>
      </div>

      <footer><span class="footer-brand">Ozon Pilot v1.0</span> &middot; 跨境电商一站式管理</footer>
    </div>
  </div>

  <!-- TAB: 产品库 -->
  <div class="tab-content" id="tab-products">
    <div class="wrap">
      <div class="sec">产品库</div>
      <div class="products-header">
        <input class="search-box" id="product-search" type="text" placeholder="搜索产品名称、品类..." oninput="filterProducts()" style="max-width:360px;margin-bottom:0;">
        <span class="products-count" id="products-count"></span>
      </div>
      <div class="ptable-wrap">
        <table class="ptable">
          <thead>
            <tr>
              <th class="sortable" onclick="sortProducts('name')">名称 <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable" onclick="sortProducts('category')">品类 <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable" onclick="sortProducts('price_rub')">售价 (RUB) <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable" onclick="sortProducts('price_cny')">供货价 (CNY) <span class="sort-arrow">&#9650;</span></th>
              <th class="sortable sort-active" onclick="sortProducts('score')">评分 <span class="sort-arrow">&#9660;</span></th>
              <th>阶段</th>
            </tr>
          </thead>
          <tbody id="products-tbody"></tbody>
        </table>
      </div>
      <footer><span class="footer-brand">Ozon Pilot v1.0</span> &middot; 跨境电商一站式管理</footer>
    </div>
  </div>

  <!-- TAB: 订单 -->
  <div class="tab-content" id="tab-orders">
    <div class="wrap">
      <div class="sec">订单监控</div>
      <div class="orders-meta">
        <span style="font-size:13px;color:var(--t1);">待处理订单: <strong style="font-family:var(--mono);color:var(--ok);" id="orders-count-tab">--</strong></span>
        <button class="act act-info" onclick="refreshOrders()" id="orders-refresh-btn">&#8635; 刷新</button>
        <select class="cfg-input" id="order-status-filter" style="flex:0;width:auto;min-width:160px;" onchange="refreshOrders()">
          <option value="awaiting_packaging">待打包</option>
          <option value="awaiting_deliver">待发货</option>
          <option value="delivering">配送中</option>
          <option value="delivered">已送达</option>
          <option value="">全部</option>
        </select>
        <span class="orders-last-update" id="orders-last-update"></span>
      </div>
      <div id="orders-list-tab"></div>
      <footer><span class="footer-brand">Ozon Pilot v1.0</span> &middot; 跨境电商一站式管理</footer>
    </div>
  </div>

  <script>
    /* === State === */
    const platforms = ['1688', 'pdd', 'ozon'];
    const NAMES = { '1688': '1688', 'pdd': '拼多多', 'ozon': 'Ozon Seller' };
    const SUBS = { '1688': '阿里巴巴批发平台', 'pdd': '拼多多电商平台', 'ozon': 'Ozon卖家后台 (自动获取API Key)' };
    const WATERMARKS = { '1688': '&#127981;', 'pdd': '&#128722;', 'ozon': '&#127759;' };
    let allProducts = [];
    let expandedSlug = null;
    let lastOrderCount = 0;
    let currentSort = { field: 'score', dir: 'desc' };
    let ordersLastRefresh = null;

    /* === Clock === */
    function tickClock() {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      document.getElementById('clock').textContent =
        d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) +
        '  ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    tickClock(); setInterval(tickClock, 1000);

    /* === Tabs === */
    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
      const btns = document.querySelectorAll('.tab-btn');
      const tabMap = { console: 0, products: 1, orders: 2 };
      btns[tabMap[name] ?? 0].classList.add('active');
      if (name === 'products') loadProducts();
      if (name === 'orders') refreshOrders();
    }

    /* === Collapse === */
    function toggleCollapse(id) {
      const hdr = document.getElementById(id + '-collapse-hdr');
      const body = document.getElementById(id + '-collapse-body');
      hdr.classList.toggle('collapsed');
      body.classList.toggle('collapsed');
    }

    /* === API helper === */
    async function api(path, method = 'GET') {
      const res = await fetch('/api' + path, { method });
      return res.json();
    }

    /* === Pills === */
    function pillHtml(status) {
      if (status.valid) {
        const d = status.daysUntilExpiry;
        if (d > 7) return '<span class="pill pill-ok"><i></i>' + d + '天</span>';
        if (d > 0) return '<span class="pill pill-warn"><i></i>' + d + '天</span>';
        return '<span class="pill pill-ok"><i></i>在线</span>';
      }
      return '<span class="pill pill-off"><i></i>离线</span>';
    }

    function stagePill(stage) {
      if (!stage) return '<span class="stage-pill stage-other">未知</span>';
      if (stage.includes('approved') || stage.includes('listing')) return '<span class="stage-pill stage-approved">' + stage + '</span>';
      if (stage.includes('draft')) return '<span class="stage-pill stage-draft">' + stage + '</span>';
      if (stage.includes('evaluat')) return '<span class="stage-pill stage-evaluated">' + stage + '</span>';
      return '<span class="stage-pill stage-other">' + stage + '</span>';
    }

    function scoreClass(s) {
      if (s >= 70) return 'score-hi';
      if (s >= 50) return 'score-mid';
      return 'score-lo';
    }

    function orderStatusPill(status) {
      const map = {
        awaiting_packaging: ['os-awaiting', '待打包'],
        awaiting_deliver: ['os-awaiting', '待发货'],
        delivering: ['os-delivering', '配送中'],
        delivered: ['os-delivered', '已送达'],
      };
      const [cls, label] = map[status] || ['os-other', status || '未知'];
      return '<span class="order-status-pill ' + cls + '">' + label + '</span>';
    }

    /* === Stats === */
    async function refreshStats() {
      try {
        const [prods, kw, ready] = await Promise.all([api('/products'), api('/keywords'), api('/ozon/upload-ready')]);
        document.getElementById('stat-products').textContent = prods.length;
        const approved = prods.filter(p => (p.workflow?.current_stage || '').includes('approved')).length;
        document.getElementById('stat-approved').textContent = approved;
        const readyEl = document.getElementById('stat-ready');
        const readyCount = ready.count || 0;
        readyEl.textContent = readyCount;
        if (readyCount > 0) {
          readyEl.classList.add('pulse-ready');
        } else {
          readyEl.classList.remove('pulse-ready');
        }
        document.getElementById('stat-keywords').textContent = kw.remaining + '/' + kw.total;
      } catch {}
    }

    /* === Platform refresh === */
    function buildTile(p, status, session, ozonCfg) {
      const tileCls = status.valid ? (status.daysUntilExpiry > 7 ? 'live' : 'expiring') : '';
      let h = '<div class="tile plat-' + p + ' ' + tileCls + '">';
      h += '<span class="tile-watermark">' + (WATERMARKS[p] || '') + '</span>';
      h += '<div class="tile-head">';
      h += '<div><div class="tile-label">' + NAMES[p] + '</div><div class="tile-sub">' + SUBS[p] + '</div></div>';
      h += pillHtml(status);
      h += '</div>';
      h += '<div class="kv">';
      if (status.valid) {
        h += '<div class="kv-row"><span class="kv-k">有效令牌</span><span class="kv-v">' + status.validCookies + '</span></div>';
        if (status.daysUntilExpiry > 0) h += '<div class="kv-row"><span class="kv-k">剩余天数</span><span class="kv-v">' + status.daysUntilExpiry + '</span></div>';
      } else {
        h += '<div class="kv-row"><span class="kv-k">状态</span><span class="kv-v" style="color:var(--t2)">需要授权</span></div>';
      }
      if (p === 'ozon' && ozonCfg) {
        if (ozonCfg.clientId) {
          h += '<div class="kv-row"><span class="kv-k">Client-Id</span><span class="kv-v">' + ozonCfg.clientId + '</span></div>';
          h += '<div class="kv-row"><span class="kv-k">API Key</span><span class="kv-v" style="color:var(--ok);">' + (ozonCfg.apiKeyMasked || '已配置') + '</span></div>';
          if (ozonCfg.warehouseName) h += '<div class="kv-row"><span class="kv-k">仓库</span><span class="kv-v">' + ozonCfg.warehouseName + '</span></div>';
        } else {
          h += '<div class="kv-row"><span class="kv-k">API</span><span class="kv-v" style="color:var(--t2);">登录后自动获取</span></div>';
        }
      }
      h += '</div>';
      // 按钮
      if (session.status === 'waiting_login') {
        h += '<button class="act act-go" onclick="login(\\'' + p + '\\')" style="opacity:0.6">' + (p === 'ozon' ? '登录中...' : '扫码中...') + '</button>';
      } else if (p === 'ozon') {
        h += '<button class="act act-go" onclick="login(\\'ozon\\')">' + (status.valid ? '重新登录' : '登录 Ozon') + '</button>';
      } else {
        h += '<button class="act act-go" onclick="login(\\'' + p + '\\')">' + (status.valid ? '重新授权' : '扫码登录') + '</button>';
      }
      h += '</div>';
      return h;
    }

    async function refresh() {
      const container = document.getElementById('platforms');
      const [s1688, sPdd, sOzon] = await Promise.all([api('/status/1688'), api('/status/pdd'), api('/status/ozon')]);
      const [e1688, ePdd, eOzon] = await Promise.all([api('/session/1688'), api('/session/pdd'), api('/session/ozon')]);
      let ozonCfg = null;
      try { ozonCfg = await api('/ozon/config'); } catch {}

      // 第一行：1688 + 拼多多（两列）
      let html = '<div class="row">';
      html += buildTile('1688', s1688, e1688);
      html += buildTile('pdd', sPdd, ePdd);
      html += '</div>';
      // 第二行：Ozon（独占一行）
      html += '<div class="row-full">';
      html += buildTile('ozon', sOzon, eOzon, ozonCfg);
      html += '</div>';

      container.innerHTML = html;
      document.getElementById('pipeline-btn').disabled = !s1688.valid;
    }

    /* === Login === */
    async function login(platform) {
      await api('/login/' + platform, 'POST');
      refresh();
      const interval = setInterval(async () => {
        await refresh();
        const session = await api('/session/' + platform);
        if (!session.status || session.status === 'cookie_saved' || session.status === 'error' || session.status === 'timeout') {
          clearInterval(interval);
        }
      }, 2000);
    }

    /* === Pipeline === */
    async function runPipeline() {
      const panel = document.getElementById('log-panel');
      const logEl = document.getElementById('pipeline-log');
      const statusEl = document.getElementById('log-status');
      panel.classList.add('open');
      logEl.textContent = '';
      statusEl.innerHTML = '<span class="spinner"></span>running';
      document.getElementById('pipeline-btn').disabled = true;

      try {
        const res = await fetch('/api/pipeline', { method: 'POST' });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          logEl.textContent += decoder.decode(value);
          logEl.scrollTop = logEl.scrollHeight;
        }
        statusEl.textContent = 'done';
      } catch (err) {
        logEl.textContent += '\\n错误: ' + err.message;
        statusEl.textContent = 'error';
      }

      document.getElementById('pipeline-btn').disabled = false;
      refresh();
      refreshStats();
    }

    /* === Select (选品) === */
    async function refreshSelectMeta() {
      try {
        const kw = await api('/keywords');
        const meta = document.getElementById('select-meta');
        meta.innerHTML =
          '<span class="select-meta-item">词库: <strong>' + kw.used + '</strong> 已用 / <strong>' + kw.total + '</strong> 总计</span>' +
          '<span class="select-meta-item">剩余: <strong>' + kw.remaining + '</strong></span>';
      } catch {}
    }

    async function runSelect() {
      const panel = document.getElementById('select-log-panel');
      const logEl = document.getElementById('select-log');
      const statusEl = document.getElementById('select-log-status');
      const btn = document.getElementById('select-btn');
      panel.classList.add('open');
      logEl.textContent = '';
      statusEl.innerHTML = '<span class="spinner"></span>running';
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>选品运行中...';

      try {
        const res = await fetch('/api/select', { method: 'POST' });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          logEl.textContent += decoder.decode(value);
          logEl.scrollTop = logEl.scrollHeight;
        }
        statusEl.textContent = 'done';
      } catch (err) {
        logEl.textContent += '\\n错误: ' + err.message;
        statusEl.textContent = 'error';
      }

      btn.disabled = false;
      btn.textContent = '启动选品';
      refreshStats();
      refreshSelectMeta();
    }

    /* === Products === */
    async function loadProducts() {
      try {
        allProducts = await api('/products');
        renderProducts(allProducts);
      } catch {}
    }

    function filterProducts() {
      const q = document.getElementById('product-search').value.toLowerCase().trim();
      if (!q) { renderProducts(allProducts); return; }
      const filtered = allProducts.filter(p => {
        const prod = p.product || {};
        return (prod.name || '').toLowerCase().includes(q) ||
               (prod.category || '').toLowerCase().includes(q) ||
               (p.slug || '').toLowerCase().includes(q);
      });
      renderProducts(filtered);
    }

    function sortProducts(field) {
      if (currentSort.field === field) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.field = field;
        currentSort.dir = field === 'score' ? 'desc' : 'asc';
      }
      // Update header visual
      document.querySelectorAll('.ptable th.sortable').forEach(th => {
        th.classList.remove('sort-active');
        th.querySelector('.sort-arrow').innerHTML = '&#9650;';
      });
      const idx = { name: 0, category: 1, price_rub: 2, price_cny: 3, score: 4 }[field] || 0;
      const ths = document.querySelectorAll('.ptable th.sortable');
      if (ths[idx]) {
        ths[idx].classList.add('sort-active');
        ths[idx].querySelector('.sort-arrow').innerHTML = currentSort.dir === 'asc' ? '&#9650;' : '&#9660;';
      }
      // Sort
      const sorted = [...allProducts].sort((a, b) => {
        const pa = a.product || {}, pb = b.product || {};
        let va, vb;
        switch (field) {
          case 'name': va = (pa.name || ''); vb = (pb.name || ''); break;
          case 'category': va = (pa.category || ''); vb = (pb.category || ''); break;
          case 'price_rub': va = pa.target_price_rub ?? 0; vb = pb.target_price_rub ?? 0; break;
          case 'price_cny': va = pa.supply_price_cny ?? 0; vb = pb.supply_price_cny ?? 0; break;
          case 'score': va = pa.total_score ?? 0; vb = pb.total_score ?? 0; break;
          default: va = 0; vb = 0;
        }
        if (typeof va === 'string') {
          const cmp = va.localeCompare(vb, 'zh-CN');
          return currentSort.dir === 'asc' ? cmp : -cmp;
        }
        return currentSort.dir === 'asc' ? va - vb : vb - va;
      });
      renderProducts(sorted);
    }

    function renderProducts(list) {
      const tbody = document.getElementById('products-tbody');
      document.getElementById('products-count').textContent = list.length + ' 件产品';
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><span class="empty-state-icon">&#128230;</span>暂无产品数据<br><span style="font-size:12px;color:var(--t3);">运行选品后产品将显示在这里</span></div></td></tr>';
        return;
      }
      let html = '';
      for (const item of list) {
        const prod = item.product || {};
        const stage = item.workflow?.current_stage || '未知';
        const score = prod.total_score ?? '--';
        const sc = typeof score === 'number' ? scoreClass(score) : '';
        const slug = item.slug || '';
        const isExpanded = slug === expandedSlug;

        html += '<tr class="prow' + (isExpanded ? ' expanded' : '') + '" onclick="toggleProduct(\\'' + slug + '\\')">';
        html += '<td class="pname">' + (prod.name || slug) + '</td>';
        html += '<td>' + (prod.category || '--') + '</td>';
        html += '<td style="font-family:var(--mono);">' + (prod.target_price_rub ?? '--') + '</td>';
        html += '<td style="font-family:var(--mono);">' + (prod.supply_price_cny ?? '--') + '</td>';
        const dotCls = typeof score === 'number' ? (score >= 70 ? 'score-dot-hi' : score >= 50 ? 'score-dot-mid' : 'score-dot-lo') : '';
        html += '<td class="pscore ' + sc + '">' + (dotCls ? '<span class="score-dot ' + dotCls + '"></span>' : '') + score + '</td>';
        html += '<td>' + stagePill(stage) + '</td>';
        html += '</tr>';

        if (isExpanded) {
          html += '<tr class="pdetail-row"><td colspan="6"><div class="pdetail">';
          html += '<div class="pdetail-grid">';

          html += '<div>';
          if (prod.why_it_can_sell) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">卖点分析</div>';
            html += '<p>' + prod.why_it_can_sell + '</p></div>';
          }
          if (prod.source_url) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">来源</div>';
            html += '<a href="' + prod.source_url + '" target="_blank">' + prod.source_url.slice(0, 60) + '...</a></div>';
          }
          if (prod.risk_notes?.length) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">风险备注</div>';
            html += '<p>' + prod.risk_notes.join('; ') + '</p></div>';
          }
          if (prod.issue_summary?.length) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">问题</div>';
            html += '<p>' + prod.issue_summary.join('; ') + '</p></div>';
          }
          html += '</div>';

          html += '<div>';
          if (prod.score_breakdown) {
            html += '<div class="pdetail-section"><div class="pdetail-section-title">评分明细</div>';
            html += '<div class="score-breakdown">';
            for (const [k, v] of Object.entries(prod.score_breakdown)) {
              html += '<span class="score-chip">' + k.replace(/_/g, ' ') + ': <strong>' + v + '</strong></span>';
            }
            html += '</div></div>';
          }

          const extras = ['est_weight_kg', 'fragility', 'certification_risk', 'return_risk', 'competition_level', 'seasonality'];
          const extraLabels = { est_weight_kg: '重量(kg)', fragility: '易碎度', certification_risk: '认证风险', return_risk: '退货风险', competition_level: '竞争度', seasonality: '季节性' };
          html += '<div class="pdetail-section"><div class="pdetail-section-title">属性</div><div class="kv">';
          for (const k of extras) {
            if (prod[k] != null) {
              html += '<div class="kv-row"><span class="kv-k">' + (extraLabels[k] || k) + '</span><span class="kv-v">' + prod[k] + '</span></div>';
            }
          }
          html += '</div></div>';
          html += '</div>';

          html += '</div></div></td></tr>';
        }
      }
      tbody.innerHTML = html;
    }

    function toggleProduct(slug) {
      expandedSlug = expandedSlug === slug ? null : slug;
      filterProducts();
    }

    /* === Ozon API Config === */
    async function loadOzonConfig() {
      try {
        const res = await fetch('/api/ozon/config');
        const cfg = await res.json();
        if (cfg.clientId) {
          document.getElementById('ozon-client-id').value = cfg.clientId;
          document.getElementById('ozon-api-key').placeholder = cfg.apiKeyMasked || '已保存';
          const pill = document.getElementById('ozon-cfg-pill');
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>已配置';
          const tile = document.getElementById('ozon-cfg-tile');
          tile.classList.add('live');
          document.getElementById('ozon-cfg-status').textContent = '';
          document.getElementById('ozon-cfg-status').className = 'cfg-status connected';
          // Show meta if available
          if (cfg.warehouseId) {
            const meta = document.getElementById('ozon-cfg-meta');
            meta.style.display = 'flex';
            document.getElementById('cfg-wh-id').textContent = cfg.warehouseId;
            document.getElementById('cfg-wh-name').textContent = cfg.warehouseName || '--';
            document.getElementById('cfg-currency').textContent = cfg.currency || 'CNY';
          }
        }
      } catch {}
    }

    async function saveOzonConfig() {
      const clientId = document.getElementById('ozon-client-id').value.trim();
      const apiKey = document.getElementById('ozon-api-key').value.trim();
      if (!clientId) { alert('请输入 Client-Id'); return; }
      const body = { clientId };
      if (apiKey) body.apiKey = apiKey;
      try {
        const res = await fetch('/api/ozon/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const r = await res.json();
        if (r.ok) {
          document.getElementById('ozon-cfg-status').textContent = '配置已保存';
          document.getElementById('ozon-cfg-status').className = 'cfg-status connected';
          const checkEl = document.getElementById('cfg-save-check');
          checkEl.innerHTML = '<span class="cfg-saved-check">&#10003; 已保存</span>';
          setTimeout(() => { checkEl.innerHTML = ''; }, 3000);
          loadOzonConfig();
          refreshUploadReady();
        } else {
          document.getElementById('ozon-cfg-status').textContent = '保存失败: ' + (r.error || '未知错误');
          document.getElementById('ozon-cfg-status').className = 'cfg-status disconnected';
        }
      } catch (e) {
        document.getElementById('ozon-cfg-status').textContent = '保存失败: ' + e.message;
        document.getElementById('ozon-cfg-status').className = 'cfg-status disconnected';
      }
    }

    async function testOzonConnection() {
      const st = document.getElementById('ozon-cfg-status');
      st.innerHTML = '<span class="spinner"></span>测试连接中...';
      st.className = 'cfg-status';
      try {
        const res = await fetch('/api/ozon/check');
        const r = await res.json();
        if (r.ok) {
          st.textContent = '连接成功! 仓库: ' + r.warehouse_name + ' (' + r.warehouse_id + ')';
          st.className = 'cfg-status connected';
          const pill = document.getElementById('ozon-cfg-pill');
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>已连接';
          document.getElementById('ozon-cfg-tile').classList.add('live');
          // Update meta
          const meta = document.getElementById('ozon-cfg-meta');
          meta.style.display = 'flex';
          document.getElementById('cfg-wh-id').textContent = r.warehouse_id;
          document.getElementById('cfg-wh-name').textContent = r.warehouse_name || '--';
          document.getElementById('cfg-currency').textContent = r.currency || 'CNY';
        } else {
          st.textContent = '连接失败: ' + (r.error || '未知错误');
          st.className = 'cfg-status disconnected';
        }
      } catch (e) {
        st.textContent = '请求失败: ' + e.message;
        st.className = 'cfg-status disconnected';
      }
    }

    /* === Upload === */
    async function refreshUploadReady() {
      try {
        const r = await api('/ozon/upload-ready');
        const pill = document.getElementById('upload-ready-pill');
        const stats = document.getElementById('upload-stats');
        const btn = document.getElementById('upload-btn');
        const stockBtn = document.getElementById('stock-btn');
        if (r.count > 0) {
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>' + r.count + ' 个就绪';
          stats.innerHTML = '<span class="upload-stat">可提交: <strong>' + r.count + '</strong></span>';
          btn.disabled = !r.apiConfigured;
          btn.textContent = r.apiConfigured ? '上架到 Ozon (' + r.count + ' 个产品)' : '请先配置 Ozon API';
        } else {
          pill.className = 'pill pill-off';
          pill.innerHTML = '<i></i>无就绪产品';
          stats.innerHTML = '<span class="upload-stat">暂无可上架产品</span>';
          btn.disabled = true;
          btn.textContent = '无可上架产品';
        }
        if (r.apiConfigured && r.uploaded > 0) {
          stockBtn.style.display = 'inline-flex';
        }
      } catch {
        document.getElementById('upload-ready-pill').innerHTML = '<i></i>检查失败';
      }
    }

    async function runUpload() {
      const panel = document.getElementById('upload-log-panel');
      const logEl = document.getElementById('upload-log');
      const statusEl = document.getElementById('upload-log-status');
      const btn = document.getElementById('upload-btn');
      const resultEl = document.getElementById('upload-result');
      const tableEl = document.getElementById('upload-result-table');
      const progressWrap = document.getElementById('upload-progress-wrap');
      const progressBar = document.getElementById('upload-progress-bar');
      const progressText = document.getElementById('upload-progress-text');
      panel.classList.add('open');
      logEl.textContent = '';
      statusEl.innerHTML = '<span class="spinner"></span>running';
      resultEl.innerHTML = '';
      tableEl.innerHTML = '';
      progressWrap.classList.add('active');
      progressBar.style.width = '5%';
      progressText.textContent = '准备上传...';
      btn.disabled = true;
      btn.textContent = '上架中...';

      try {
        const res = await fetch('/api/ozon/upload', { method: 'POST' });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        const results = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          fullText += chunk;
          buffer += chunk;

          // Parse JSON lines
          const lines = buffer.split('\\n');
          buffer = lines.pop(); // keep incomplete line
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed);
              if (msg.type === 'progress') {
                const pct = Math.round((msg.current / msg.total) * 100);
                progressBar.style.width = pct + '%';
                progressText.textContent = '上传中 ' + msg.current + '/' + msg.total + '... ' + (msg.offer_id || '');
                logEl.textContent += '上传: ' + msg.offer_id + ' -> ' + msg.status + '\\n';
              } else if (msg.type === 'result') {
                results.push(msg);
              } else if (msg.type === 'done') {
                progressBar.style.width = '100%';
                progressBar.classList.remove('animate');
                progressText.textContent = '上传完成: 成功 ' + msg.success + ', 失败 ' + msg.failed;
                let rhtml = '';
                if (msg.success > 0) rhtml += '<span class="pill pill-ok"><i></i>成功 ' + msg.success + '</span>';
                if (msg.failed > 0) rhtml += '<span class="pill pill-err"><i></i>失败 ' + msg.failed + '</span>';
                resultEl.innerHTML = rhtml;
                // Show stock button
                if (msg.success > 0) document.getElementById('stock-btn').style.display = 'inline-flex';
              } else if (msg.type === 'error') {
                logEl.textContent += '错误: ' + msg.message + '\\n';
              } else if (msg.type === 'log') {
                logEl.textContent += msg.message + '\\n';
              }
              logEl.scrollTop = logEl.scrollHeight;
            } catch {
              // Not JSON, show as plain text
              logEl.textContent += trimmed + '\\n';
              logEl.scrollTop = logEl.scrollHeight;
            }
          }
        }

        // Render results table
        if (results.length > 0) {
          let thtml = '<table class="result-table"><thead><tr><th>Offer ID</th><th>Product ID</th><th>状态</th><th>错误</th></tr></thead><tbody>';
          for (const r of results) {
            const cls = r.success ? 'r-ok' : 'r-err';
            thtml += '<tr>';
            thtml += '<td>' + (r.offer_id || '--') + '</td>';
            thtml += '<td>' + (r.product_id || '--') + '</td>';
            thtml += '<td class="' + cls + '">' + (r.success ? '成功' : '失败') + '</td>';
            thtml += '<td style="color:var(--err);font-size:11px;">' + (r.errors || '') + '</td>';
            thtml += '</tr>';
          }
          thtml += '</tbody></table>';
          tableEl.innerHTML = thtml;
        }

        statusEl.textContent = 'done';
      } catch (err) {
        logEl.textContent += '\\n错误: ' + err.message;
        statusEl.textContent = 'error';
        progressBar.classList.remove('animate');
        progressText.textContent = '上传失败';
      }

      btn.disabled = false;
      btn.textContent = '上架到 Ozon';
      refreshUploadReady();
      refreshStats();
    }

    async function setStock() {
      const btn = document.getElementById('stock-btn');
      btn.disabled = true;
      btn.textContent = '设置中...';
      try {
        const res = await fetch('/api/ozon/stock', { method: 'POST' });
        const r = await res.json();
        if (r.ok) {
          btn.textContent = '已设置 (' + r.updated + ' 个)';
          btn.disabled = false;
        } else {
          btn.textContent = '失败: ' + (r.error || '未知');
          btn.disabled = false;
        }
      } catch (e) {
        btn.textContent = '失败: ' + e.message;
        btn.disabled = false;
      }
    }

    /* === Orders === */
    async function refreshOrders() {
      const filterEl = document.getElementById('order-status-filter');
      const statusFilter = filterEl ? filterEl.value : 'awaiting_packaging';
      ordersLastRefresh = Date.now();
      const updateEl = document.getElementById('orders-last-update');
      if (updateEl) updateEl.textContent = '刷新中...';
      try {
        const res = await fetch('/api/ozon/orders?status=' + encodeURIComponent(statusFilter));
        const r = await res.json();
        if (updateEl) updateEl.textContent = '最后更新: 刚刚';
        // Update both tab badge and in-tab count
        const countTabEl = document.getElementById('orders-count-tab');
        const badgeEl = document.getElementById('orders-badge');
        const listEl = document.getElementById('orders-list-tab');

        if (r.error) {
          countTabEl.textContent = '--';
          listEl.innerHTML = '<div style="font-size:13px;color:var(--t2);">' + r.error + '</div>';
          return;
        }
        const orders = r.orders || [];
        lastOrderCount = orders.length;
        countTabEl.textContent = orders.length;
        if (orders.length > 0) {
          badgeEl.textContent = orders.length;
          badgeEl.style.display = 'inline-flex';
        } else {
          badgeEl.style.display = 'none';
        }
        if (orders.length === 0) {
          listEl.innerHTML = '<div style="font-size:13px;color:var(--t2);">暂无订单</div>';
          return;
        }
        let html = '';
        for (const o of orders) {
          const pn = o.posting_number || '';
          const items = (o.products || []).map(p => p.name || p.offer_id).join(', ');
          const qty = (o.products || []).reduce((s, p) => s + (p.quantity || 0), 0);
          const created = o.created_at ? new Date(o.created_at).toLocaleString('zh-CN') : '';
          const st = o.status || '';
          const totalPrice = (o.products || []).reduce((s, p) => s + parseFloat(p.price || 0) * (p.quantity || 1), 0);

          html += '<div class="order-card">';
          html += '<div class="order-info">';
          html += '<div style="display:flex;gap:10px;align-items:center;">';
          html += '<div class="order-id">' + pn + '</div>';
          html += orderStatusPill(st);
          html += '</div>';
          html += '<div class="order-detail">' + items.slice(0, 80) + (items.length > 80 ? '...' : '') + ' (' + qty + '件)</div>';
          html += '<div class="order-detail">' + created + '</div>';
          html += '</div>';
          html += '<div style="display:flex;align-items:center;gap:16px;">';
          if (totalPrice > 0) {
            html += '<div class="order-total">' + totalPrice.toFixed(2) + '</div>';
          }
          html += '<div class="order-actions">';
          if (st === 'awaiting_packaging' || st === 'awaiting_deliver') {
            html += '<button class="act act-dl" onclick="downloadLabel(\\'' + pn + '\\')">面单</button>';
          }
          html += '</div>';
          html += '</div>';
          html += '</div>';
        }
        listEl.innerHTML = html;
      } catch (e) {
        document.getElementById('orders-count-tab').textContent = '--';
        document.getElementById('orders-list-tab').innerHTML = '<div style="font-size:13px;color:var(--t2);">加载失败: ' + e.message + '</div>';
      }
    }

    function downloadLabel(postingNumber) {
      window.open('/api/ozon/label/' + encodeURIComponent(postingNumber), '_blank');
    }

    /* === Error Check & Fix === */
    async function checkErrors() {
      const pill = document.getElementById('error-check-pill');
      const summary = document.getElementById('error-summary');
      const list = document.getElementById('error-list');
      const fixBtn = document.getElementById('fix-btn');
      pill.className = 'pill pill-off';
      pill.innerHTML = '<i></i>扫描中...';
      summary.textContent = '';
      list.innerHTML = '';

      try {
        const res = await fetch('/api/ozon/errors');
        const r = await res.json();
        if (r.error) {
          pill.innerHTML = '<i></i>' + r.error;
          return;
        }

        const total = r.totalProducts || 0;
        const severe = r.totalSevere || 0;
        const warn = r.totalWarn || 0;
        const prods = r.products || [];

        if (severe === 0 && warn === 0) {
          pill.className = 'pill pill-ok';
          pill.innerHTML = '<i></i>零错误';
          summary.innerHTML = '<span style="color:var(--ok);">' + total + ' 个产品全部通过检查</span>';
          fixBtn.style.display = 'none';
          return;
        }

        pill.className = severe > 0 ? 'pill pill-err' : 'pill pill-warn';
        pill.innerHTML = '<i></i>' + (severe > 0 ? severe + ' 严重' : '') + (warn > 0 ? ' ' + warn + ' 警告' : '');
        summary.innerHTML = total + ' 个已上架, <span style="color:var(--err);">' + severe + ' 严重错误</span>, <span style="color:var(--warn);">' + warn + ' 警告</span>';

        if (severe > 0) fixBtn.style.display = 'inline-flex';

        let html = '';
        for (const p of prods) {
          const icon = p.severe.length > 0 ? '<span style="color:var(--err);">&#9679;</span>' : '<span style="color:var(--warn);">&#9679;</span>';
          html += '<div style="padding:8px 0;border-bottom:1px solid var(--edge);font-size:12px;">';
          html += icon + ' <strong>' + p.offer_id + '</strong> (pid=' + p.product_id + ')';
          for (const e of p.severe) {
            html += '<div style="margin-left:16px;color:var(--err);">[严重] ' + e.code + (e.attr_name ? ' (' + e.attr_name + ')' : '') + '</div>';
            html += '<div style="margin-left:16px;color:var(--t2);font-size:11px;">' + e.desc + '</div>';
          }
          for (const e of p.warnings) {
            html += '<div style="margin-left:16px;color:var(--warn);">[警告] ' + e.code + (e.attr_name ? ' (' + e.attr_name + ')' : '') + '</div>';
            html += '<div style="margin-left:16px;color:var(--t2);font-size:11px;">' + e.desc + '</div>';
          }
          html += '</div>';
        }
        list.innerHTML = html;
      } catch (e) {
        pill.innerHTML = '<i></i>检查失败';
        summary.textContent = e.message;
      }
    }

    async function runAutoFix() {
      const panel = document.getElementById('fix-log-panel');
      const logEl = document.getElementById('fix-log');
      const statusEl = document.getElementById('fix-log-status');
      const btn = document.getElementById('fix-btn');
      panel.classList.add('open');
      logEl.textContent = '';
      statusEl.textContent = 'running';
      btn.disabled = true;
      btn.textContent = '修复中...';

      try {
        const res = await fetch('/api/ozon/fix', { method: 'POST' });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\\n')) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line.trim());
              if (msg.type === 'log' || msg.type === 'error') {
                logEl.textContent += (msg.message || '') + '\\n';
              } else if (msg.type === 'done') {
                logEl.textContent += '\\n' + msg.message + '\\n';
                statusEl.textContent = 'done';
              }
            } catch {
              logEl.textContent += line.trim() + '\\n';
            }
            logEl.scrollTop = logEl.scrollHeight;
          }
        }
      } catch (e) {
        logEl.textContent += '错误: ' + e.message;
        statusEl.textContent = 'error';
      }

      btn.disabled = false;
      btn.textContent = '一键修复';
      // Re-check errors
      setTimeout(checkErrors, 2000);
    }

    /* === Init === */
    refresh();
    refreshStats();
    refreshSelectMeta();
    loadOzonConfig();
    refreshUploadReady();
    refreshOrders();
    setInterval(refresh, 5000);
    setInterval(refreshStats, 15000);
    setInterval(refreshOrders, 60000);
    // Update orders "last updated" display
    setInterval(() => {
      if (!ordersLastRefresh) return;
      const secs = Math.round((Date.now() - ordersLastRefresh) / 1000);
      const el = document.getElementById('orders-last-update');
      if (el) {
        if (secs < 5) el.textContent = '最后更新: 刚刚';
        else if (secs < 60) el.textContent = '最后更新: ' + secs + ' 秒前';
        else el.textContent = '最后更新: ' + Math.round(secs / 60) + ' 分钟前';
      }
    }, 5000);
  </script>
</body>
</html>`;

// ─── helper: read JSON body from request ───
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function createServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // ─── 前端页面 ───
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
      return;
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
        "--skip-seeds",
        "--input", "examples/sample-seeds.json",
        "--limit", "3",
        "--skip-infer",
      ], { cwd: path.resolve(""), timeout: 600_000 });

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
        const entries = await fs.readdir(KB_PRODUCTS, { withFileTypes: true }).catch(() => []);
        const products = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const pjson = path.join(KB_PRODUCTS, entry.name, "product.json");
          try {
            const raw = await fs.readFile(pjson, "utf8");
            const data = JSON.parse(raw);
            products.push(data);
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
      const slug = url.pathname.split("/").pop();
      try {
        const pjson = path.join(KB_PRODUCTS, slug, "product.json");
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
        const total = 67;
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

    // ─── API: 运行选品 (streaming) ───
    if (url.pathname === "/api/select" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });
      const selectCwd = AI_ROOT;
      const child = spawn("node", [
        path.join(AI_ROOT, "scripts", "select-1688-for-ozon.js"),
        "--headless", "--max-keywords", "8",
      ], { cwd: selectCwd, env: { ...process.env }, timeout: 600_000 });

      child.stdout?.on("data", (chunk) => res.write(chunk));
      child.stderr?.on("data", (chunk) => res.write(chunk));
      child.on("error", (err) => {
        res.write(`\n--- 启动失败: ${err.message} ---\n`);
        res.end();
      });
      child.on("close", (code) => {
        res.write(`\n--- 选品完成 (exit code: ${code}) ---\n`);
        res.end();
      });
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  Ozon API Endpoints (new paths: /api/ozon/*)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    // ─── GET /api/ozon/config ───
    if (url.pathname === "/api/ozon/config" && req.method === "GET") {
      try {
        const cfg = await loadOzonCfg();
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
        await ensureDir(OZON_CONFIG_DIR);
        let existing = await loadOzonCfg();
        if (body.clientId) existing.clientId = body.clientId;
        if (body.apiKey) existing.apiKey = body.apiKey;
        if (!existing.currency) existing.currency = "CNY";
        await fs.writeFile(OZON_CONFIG_PATH, JSON.stringify(existing, null, 2), "utf8");
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
        const cfg = await loadOzonCfg();
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
          await ensureDir(OZON_CONFIG_DIR);
          await fs.writeFile(OZON_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
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
        const mappings = await readAllMappings();
        const readyCount = mappings.filter(m => m.status === "可提交").length;
        const uploadedCount = mappings.filter(m => m.status === "已上传" || m.ozon_product_id).length;
        const cfg = await loadOzonCfg();
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
        const cfg = await loadOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          write({ type: "error", message: "未配置 Ozon API 凭据" });
          res.end();
          return;
        }

        const mappings = await readAllMappings();
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
                    const mjsonPath = path.join(KB_PRODUCTS, mapping._dir, "ozon-import-mapping.json");
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
                    } catch {}
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
        const cfg = await loadOzonCfg();
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
        const cfg = await loadOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "未配置 Ozon API" }));
          return;
        }

        const mappings = await readAllMappings();
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

    // ─── GET /api/ozon/errors ─── check all product errors from Ozon
    if (url.pathname === "/api/ozon/errors" && req.method === "GET") {
      try {
        const cfg = await loadOzonCfg();
        if (!cfg.clientId || !cfg.apiKey) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "未配置 Ozon API" }));
          return;
        }
        // Get all task_ids from mappings
        const mappings = await readAllMappings();
        const taskIds = [...new Set(mappings.map(m => m.ozon_task_id).filter(Boolean))];
        const productErrors = [];
        let totalSevere = 0, totalWarn = 0;

        for (const tid of taskIds) {
          const r = await ozonApi("/v1/product/import/info", { task_id: tid }, cfg);
          if (!r.ok || !r.data.result) continue;
          for (const si of (r.data.result.items || [])) {
            const errs = si.errors || [];
            if (errs.length === 0) continue;
            const severe = errs.filter(e => e.level === "error");
            const warn = errs.filter(e => e.level !== "error");
            totalSevere += severe.length;
            totalWarn += warn.length;
            productErrors.push({
              offer_id: si.offer_id,
              product_id: si.product_id,
              status: si.status,
              severe: severe.map(e => ({ code: e.code, attr_id: e.attribute_id, attr_name: e.attribute_name, desc: (e.description || "").slice(0, 120) })),
              warnings: warn.map(e => ({ code: e.code, attr_id: e.attribute_id, attr_name: e.attribute_name, desc: (e.description || "").slice(0, 120) })),
            });
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ totalProducts: mappings.filter(m => m.ozon_product_id).length, totalSevere, totalWarn, products: productErrors }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ─── POST /api/ozon/fix ─── smart auto-fix: query Ozon API for correct types, fix SPU, fix images
    if (url.pathname === "/api/ozon/fix" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked", "Cache-Control": "no-cache" });
      const write = (obj) => res.write(JSON.stringify(obj) + "\n");

      try {
        const cfg = await loadOzonCfg();
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

        for (const prod of errorProducts) {
          const mapping = (await readAllMappings()).find(m => m.offer_id === prod.offer_id);
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
              const mjsonPath = path.join(KB_PRODUCTS, mapping._dir, "ozon-import-mapping.json");
              const mData = JSON.parse(await fs.readFile(mjsonPath, "utf8"));
              mData.import_fields = mData.import_fields || {};
              mData.import_fields.type_id = typeId;
              mData.title_override = newName;
              await fs.writeFile(mjsonPath, JSON.stringify(mData, null, 2), "utf8");
            } catch {}
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
              const mapping = (await readAllMappings()).find(m => m.offer_id === fi.offer_id);
              if (mapping?._dir) {
                try {
                  const mjsonPath = path.join(KB_PRODUCTS, mapping._dir, "ozon-import-mapping.json");
                  const mData = JSON.parse(await fs.readFile(mjsonPath, "utf8"));
                  mData.ozon_task_id = taskId;
                  await fs.writeFile(mjsonPath, JSON.stringify(mData, null, 2), "utf8");
                } catch {}
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
        const cfg = await loadOzonCfg();
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

    // ─── GET /api/ozon/label/:posting_number ─── download label PDF
    if (url.pathname.startsWith("/api/ozon/label/") && req.method === "GET") {
      try {
        const postingNumber = decodeURIComponent(url.pathname.split("/api/ozon/label/")[1]);
        const cfg = await loadOzonCfg();
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

  server.listen(port, () => {
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
createServer(parseInt(args.port));
