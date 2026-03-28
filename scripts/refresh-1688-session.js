import { ensureHostsDirectConnection } from "./browser-network.js";
import {
  launch1688Runtime,
  openSearchPage,
  save1688StorageState,
  scrapeDetailPage,
} from "./source-1688-lib.js";

const DEFAULT_KEYWORD = "宠物粘毛器";
const DEFAULT_DETAIL_URL = "https://detail.1688.com/offer/979663612935.html";
const DEFAULT_TIMEOUT_MS = 300000;
const POLL_INTERVAL_MS = 3000;

const LOGIN_SIGNAL_RE =
  /(登录|密码登录|短信登录|扫码登录|member\/signin|signin|User not login in|FAIL_SYS_SESSION_EXPIRED)/i;
const CAPTCHA_SIGNAL_RE =
  /(验证码|captcha|拖动下方滑块|验证拦截|x5secdata|_____tmd_____\/punish)/i;

function parseArgs(argv) {
  const args = {
    keyword: DEFAULT_KEYWORD,
    detailUrl: DEFAULT_DETAIL_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepOpen: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--keyword" && next) {
      args.keyword = String(next).trim() || DEFAULT_KEYWORD;
      index += 1;
    } else if (current === "--detail-url" && next) {
      args.detailUrl = String(next).trim() || DEFAULT_DETAIL_URL;
      index += 1;
    } else if (current === "--timeout-ms" && next) {
      args.timeoutMs = Math.max(10000, Number(next) || DEFAULT_TIMEOUT_MS);
      index += 1;
    } else if (current === "--keep-open") {
      args.keepOpen = true;
    }
  }

  return args;
}

function compactText(value, limit = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function detectPageType(title = "", body = "", signals = {}) {
  const bundle = `${title} ${body}`;
  if (CAPTCHA_SIGNAL_RE.test(bundle)) return "captcha";
  if (LOGIN_SIGNAL_RE.test(bundle) && !signals.hasProductSignals) return "login";
  return "normal";
}

async function inspectCurrentSearchPage(page) {
  const snapshot = await page.evaluate(() => {
    const body = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const title = String(document.title || "").trim();
    const cardCount = document.querySelectorAll(".search-offer-item, .major-offer").length;
    const offerLinkCount = document.querySelectorAll(
      'a[href*="offerId="], a[href*="detail.1688.com/offer/"]',
    ).length;

    return {
      title,
      body,
      cardCount,
      offerLinkCount,
      currentUrl: location.href,
    };
  });

  const pageType = detectPageType(snapshot.title, snapshot.body);
  return {
    ...snapshot,
    page_type: pageType === "normal" ? "search" : pageType,
  };
}

async function inspectCurrentDetailPage(page) {
  const snapshot = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const bodyText = clean(document.body?.innerText || "");
    const title = clean(document.title || "");
    const imageCount = Array.from(document.querySelectorAll("img"))
      .map(
        (img) =>
          img.getAttribute("data-lazy-src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("src") ||
          "",
      )
      .map((value) => clean(value))
      .filter((value) => /^https?:/i.test(value))
      .length;
    const attrCount =
      Array.from(document.querySelectorAll("table tr")).length +
      Array.from(document.querySelectorAll("li, dt, dd")).filter((node) =>
        /^([^:：]{1,20})[:：]\s*(.+)$/.test(clean(node.textContent || "")),
      ).length;
    const hasProductSignals =
      (title && (imageCount >= 1 || attrCount >= 1)) ||
      /(商品属性|包装信息|评价|颜色|规格|库存|运费)/.test(bodyText);

    return {
      title,
      bodyText,
      imageCount,
      attrCount,
      hasProductSignals,
      currentUrl: location.href,
    };
  });

  const pageType = detectPageType(snapshot.title, snapshot.bodyText, snapshot);
  return {
    ...snapshot,
    page_type: pageType === "normal" ? "detail" : pageType,
  };
}

function isSearchReady(state) {
  return state?.page_type === "search" && (Number(state.offerLinkCount || 0) > 0 || Number(state.cardCount || 0) > 0);
}

function isDetailReady(state) {
  return state?.page_type === "detail" && (Number(state.attrCount || 0) >= 3 || Number(state.imageCount || 0) >= 1);
}

function buildSummary(runtime, searchState, detailState, timedOut = false) {
  return {
    ready: isSearchReady(searchState) && isDetailReady(detailState),
    timedOut,
    runtimeMode: runtime.mode,
    storageStatePath: runtime.storageStatePath,
    browserProfileDir: runtime.browserProfileDir,
    bootstrapSource: runtime.bootstrapSource,
    search: {
      pageType: searchState.page_type,
      cardCount: Number(searchState.cardCount || 0),
      offerLinkCount: Number(searchState.offerLinkCount || 0),
      title: searchState.title,
      currentUrl: searchState.currentUrl,
      bodySnippet: compactText(searchState.body),
    },
    detail: {
      pageType: detailState.page_type,
      attrCount: Number(detailState.attrCount || 0),
      imageCount: Number(detailState.imageCount || 0),
      title: detailState.title,
      currentUrl: detailState.currentUrl,
      bodySnippet: compactText(detailState.bodyText),
    },
  };
}

async function waitForReady(context, searchPage, detailPage, timeoutMs) {
  const startedAt = Date.now();
  let searchState = await inspectCurrentSearchPage(searchPage);
  let detailState = await inspectCurrentDetailPage(detailPage);

  while (Date.now() - startedAt < timeoutMs) {
    if (isSearchReady(searchState) && isDetailReady(detailState)) {
      return { ready: true, searchState, detailState };
    }

    await save1688StorageState(context);
    await searchPage.waitForTimeout(POLL_INTERVAL_MS);
    searchState = await inspectCurrentSearchPage(searchPage);
    detailState = await inspectCurrentDetailPage(detailPage);
  }

  return {
    ready: false,
    searchState,
    detailState,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await launch1688Runtime(false);
  const { browser, context } = runtime;
  const searchPage = await context.newPage();
  const detailPage = await context.newPage();

  try {
    await ensureHostsDirectConnection([
      "s.1688.com",
      "detail.1688.com",
      "1688.com",
      "taobao.com",
      "alibaba.com",
    ]);

    await openSearchPage(searchPage, args.keyword);
    await scrapeDetailPage(detailPage, args.detailUrl);
    await save1688StorageState(context);

    await searchPage.bringToFront().catch(() => {});

    let searchState = await inspectCurrentSearchPage(searchPage);
    let detailState = await inspectCurrentDetailPage(detailPage);

    if (runtime.mode !== "persistent") {
      console.log(
        "[1688-session] Dedicated profile is busy, so this run fell back to storage-state mode. Close other automation browsers and rerun if the login still does not persist.",
      );
    }

    if (!isSearchReady(searchState) || !isDetailReady(detailState)) {
      console.log("[1688-session] Complete 1688 login or captcha in the opened browser window. The script will save the session automatically when both tabs are ready.");
      console.log(`[1688-session] Search keyword: ${args.keyword}`);
      console.log(`[1688-session] Detail URL: ${args.detailUrl}`);

      const waited = await waitForReady(context, searchPage, detailPage, args.timeoutMs);
      searchState = waited.searchState;
      detailState = waited.detailState;

      await save1688StorageState(context);
      console.log(JSON.stringify(buildSummary(runtime, searchState, detailState, !waited.ready), null, 2));

      if (!waited.ready) {
        process.exitCode = 1;
      }
      return;
    }

    await save1688StorageState(context);
    console.log(JSON.stringify(buildSummary(runtime, searchState, detailState, false), null, 2));
  } finally {
    if (!args.keepOpen) {
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
