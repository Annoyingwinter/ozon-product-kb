import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const EDGE_USER_DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Microsoft",
  "Edge",
  "User Data",
);

const STORAGE_STATE_PATH = path.resolve(".profiles", "alphashop", "storage-state.json");
const TARGET_URL = "https://www.alphashop.cn/select-product/general-agent";

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function main() {
  await ensureDir(path.dirname(STORAGE_STATE_PATH));

  const context = await chromium.launchPersistentContext(EDGE_USER_DATA_DIR, {
    channel: "msedge",
    headless: false,
    args: [
      "--profile-directory=Default",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 1440, height: 1200 },
    ignoreHTTPSErrors: true,
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    }).catch(() => {});
    await page.waitForTimeout(5000);
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`Saved storage state: ${STORAGE_STATE_PATH}`);
    console.log(`Current URL: ${page.url()}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
