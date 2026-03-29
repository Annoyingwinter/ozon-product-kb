/**
 * 浏览器启动 + 代理 + 反检测 — 从旧项目提炼
 */
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { normalize, readJson, writeJson, ensureDir } from "./shared.js";

const CAPTCHA_TIMEOUT_MS = 300_000;
const LOGIN_RE = /登录|密码登录|短信登录|扫码登录|FAIL_SYS_SESSION_EXPIRED|User not login/i;
const CAPTCHA_RE = /验证码|拖动下方滑块|请按住滑块|通过验证|captcha/i;

// ─── v2rayN 代理例外自动维护 ───
const V2RAYN_CANDIDATES = [
  path.resolve(process.env.USERPROFILE || "", "Downloads", "v2rayN-windows-64-desktop", "v2rayN-windows-64", "guiConfigs", "guiNConfig.json"),
];

export async function ensureDirectConnection(hosts = []) {
  for (const configPath of V2RAYN_CANDIDATES) {
    const config = await readJson(configPath, null);
    if (!config?.SystemProxyItem) continue;
    const current = config.SystemProxyItem.SystemProxyExceptions || "";
    const segments = current.split(";").map(s => s.trim()).filter(Boolean);
    const known = new Set(segments.map(s => s.toLowerCase()));
    let changed = false;
    for (const host of hosts) {
      const h = normalize(host).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      if (h && !known.has(h.toLowerCase())) {
        segments.push(h);
        if (!h.startsWith("*.")) segments.push(`*.${h}`);
        changed = true;
      }
    }
    if (!changed) return;
    config.SystemProxyItem.SystemProxyExceptions = segments.join(";");
    await fs.copyFile(configPath, `${configPath}.bak`).catch(() => {});
    await writeJson(configPath, config);
    return;
  }
}

// ─── 导航(自动重试+代理调整) ───
export async function gotoSafe(page, url, opts = {}) {
  const attempts = opts.attempts || 3;
  const timeout = opts.timeout || 120_000;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(opts.wait || 2500);
      return;
    } catch (err) {
      lastErr = err;
      if (i === 1) await ensureDirectConnection([new URL(url).hostname]).catch(() => {});
      if (i < attempts) await page.waitForTimeout(2000 * i).catch(() => {});
    }
  }
  throw lastErr;
}

// ─── 页面类型检测 ───
export async function detectPageType(page) {
  const text = await page.evaluate(() =>
    `${document.title} ${document.body?.innerText || ""}`.replace(/\s+/g, " ").slice(0, 2000)
  );
  if (CAPTCHA_RE.test(text)) return "captcha";
  if (LOGIN_RE.test(text)) return "login";
  return "normal";
}

// ─── 验证码等待(人工干预) ───
export async function waitForCaptcha(page, label = "", timeoutMs = CAPTCHA_TIMEOUT_MS) {
  const start = Date.now();
  console.log(`[captcha] 等待人工验证: ${label} (${timeoutMs / 1000}s超时)`);
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2000);
    const type = await detectPageType(page);
    if (type === "normal") return true;
  }
  console.warn(`[captcha] 超时: ${label}`);
  return false;
}

// ─── 通用浏览器启动(支持1688/拼多多) ───
export async function launchBrowser(profileDir, opts = {}) {
  const headless = opts.headless ?? false;
  const storageStatePath = opts.storageStatePath;
  const launchOpts = {
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  const ctxOpts = {
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  };

  await ensureDir(profileDir);

  // 尝试持久化上下文 (Edge优先)
  for (const channel of ["msedge", "chrome"]) {
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        ...launchOpts, ...ctxOpts, channel,
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
      });
      // 注入已保存的cookie
      if (storageStatePath) {
        const saved = await readJson(storageStatePath, null);
        if (saved?.cookies?.length) {
          await context.addCookies(saved.cookies.filter(c => c.name && c.value && c.domain));
        }
      }
      return { context, browser: null, mode: "persistent" };
    } catch (err) {
      if (/user data dir.*already in use|Singleton/i.test(String(err))) break;
    }
  }

  // 回退: 独立浏览器 + storageState
  const browser = await chromium.launch({ channel: "msedge", ...launchOpts })
    .catch(() => chromium.launch(launchOpts));
  const saved = storageStatePath ? await readJson(storageStatePath, null) : null;
  const context = await browser.newContext({
    ...ctxOpts,
    storageState: saved?.cookies?.length ? saved : undefined,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });
  return { context, browser, mode: "fallback" };
}

// ─── 保存session ───
export async function saveSession(context, savePath) {
  if (!context || !savePath) return;
  await ensureDir(path.dirname(savePath));
  await context.storageState({ path: savePath }).catch(() => {});
}

// ─── 关闭 ───
export async function closeBrowser({ context, browser }) {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
