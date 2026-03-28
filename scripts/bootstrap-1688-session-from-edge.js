import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { ensureHostsDirectConnection } from "./browser-network.js";
import { ensureDir, parseArgs } from "./merchant-workflow-lib.js";

const EDGE_USER_DATA_DIR = path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "User Data");
const EDGE_PROFILE_NAME = "Default";
const TARGET_PROFILE_DIR = path.resolve(".profiles", "1688");
const TARGET_STORAGE_STATE_PATH = path.join(TARGET_PROFILE_DIR, "storage-state.json");
const TARGET_BROWSER_PROFILE_DIR = path.join(TARGET_PROFILE_DIR, "browser-user-data");
const MARKETPLACE_COOKIE_DOMAIN_RE = /(^|\.)1688\.com$|(^|\.)taobao\.com$|(^|\.)alibaba\.com$/i;

function countMarketplaceCookies(storageState) {
  return (storageState?.cookies || []).filter((cookie) =>
    MARKETPLACE_COOKIE_DOMAIN_RE.test(String(cookie?.domain || "")),
  ).length;
}

async function isEdgeRunning() {
  try {
    const marker = path.join(EDGE_USER_DATA_DIR, "SingletonLock");
    await fs.access(marker);
    return true;
  } catch {
    return false;
  }
}

async function launchSourceContext(headless) {
  return chromium.launchPersistentContext(EDGE_USER_DATA_DIR, {
    channel: "msedge",
    headless,
    args: [
      "--profile-directory=Default",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const headless = Boolean(args.headless);

  if (!(await fs.stat(EDGE_USER_DATA_DIR).catch(() => null))) {
    throw new Error(`Edge 用户目录不存在: ${EDGE_USER_DATA_DIR}`);
  }

  if (await isEdgeRunning()) {
    throw new Error(
      "Edge Default 正在被占用。先彻底关闭 Edge，再运行这个导入脚本。这样才能稳定导出真实登录态。",
    );
  }

  await ensureDir(TARGET_PROFILE_DIR);
  await ensureDir(TARGET_BROWSER_PROFILE_DIR);

  const context = await launchSourceContext(headless);
  try {
    const page = await context.newPage();
    await ensureHostsDirectConnection(["detail.1688.com", "1688.com", "taobao.com", "alibaba.com"]);
    await page.goto("https://detail.1688.com/offer/979663612935.html", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(5000);

    const storageState = await context.storageState();
    const marketplaceCookieCount = countMarketplaceCookies(storageState);
    if (!marketplaceCookieCount) {
      throw new Error("Edge Default 已打开，但没有导出到任何 1688/淘宝/阿里系 cookie。");
    }

    await fs.writeFile(TARGET_STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2), "utf8");

    const pageSummary = await page.evaluate(() => {
      const body = String(document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 800);
      const joined = `${document.title} ${location.href} ${body}`;
      const loginPromptVisible = /登录查看更多优惠|登录查看全部规格|登录/.test(joined);
      const hardLoginGate = /密码登录|短信登录|扫码登录|member\/signin|请拖动下方滑块完成验证|通过验证以确保正常访问/.test(joined);
      return {
        href: location.href,
        title: document.title,
        loginPromptVisible,
        hardLoginGate,
      };
    });

    console.log(
      JSON.stringify(
        {
          sourceUserDataDir: EDGE_USER_DATA_DIR,
          sourceProfile: EDGE_PROFILE_NAME,
          targetStorageStatePath: TARGET_STORAGE_STATE_PATH,
          marketplaceCookieCount,
          pageSummary,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
