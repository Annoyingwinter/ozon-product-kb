import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getWorkflowPaths, refreshWorkflowArtifacts, writeJson as writeWorkflowJson } from "./merchant-workflow-lib.js";
import { buildSupplierChatPlan, DEFAULT_PRODUCT_SLUG, loadProductRecordBySlug } from "./supplier-chat-lib.js";

const STORAGE_STATE_PATH = path.resolve(".profiles", "alphashop", "storage-state.json");
const OUTPUT_DIR = path.resolve("output", "playwright");
const DEFAULT_KEYWORD = "汽车座椅缝隙收纳袋";
const DEFAULT_MESSAGE =
  "老板你好，这款汽车座椅缝隙收纳袋我这边想拿去做跨境，先跟你确认几个基础信息：起订量怎么做？500件和1000件分别什么价？材质和颜色有哪些？单个重量、包装尺寸多少？现在有没有现货，大货多久能发？方便的话直接发我参数和报价就行，谢谢。";

function parseArgs(argv) {
  const args = {
    slug: DEFAULT_PRODUCT_SLUG,
    keyword: "",
    message: "",
    headless: false,
    keepOpen: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--keyword" && next) {
      args.keyword = next;
      index += 1;
    } else if (current === "--slug" && next) {
      args.slug = next;
      index += 1;
    } else if (current === "--message" && next) {
      args.message = next;
      index += 1;
    } else if (current === "--headless") {
      args.headless = true;
    } else if (current === "--keep-open") {
      args.keepOpen = true;
    }
  }

  return args;
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseMetric(text, marker) {
  const match = normalize(text).match(new RegExp(`${marker}(\\d+(?:\\.\\d+)?)\\+?`));
  return match ? Number(match[1]) : 0;
}

function scoreCandidate(candidate) {
  const haystack = `${candidate.title} ${candidate.text}`;
  let score = 0;

  if (/座椅/.test(haystack)) score += 20;
  if (/缝隙|夹缝/.test(haystack)) score += 18;
  if (/收纳|储物|置物/.test(haystack)) score += 14;
  if (/袋|盒/.test(haystack)) score += 8;
  if (/皮革|防水/.test(haystack)) score += 4;
  if (/退货包运费|先采后付/.test(haystack)) score += 3;
  if (/验厂报告/.test(haystack)) score += 5;

  if (/USB|无线充电|快充|数显/.test(haystack)) score -= 50;
  if (/垃圾袋|垃圾桶/.test(haystack)) score -= 50;
  if (/塞条|防漏|填补边缝/.test(haystack)) score -= 30;
  if (/后备箱|椅背|悬挂式/.test(haystack)) score -= 30;

  score += Math.min(parseMetric(haystack, "回头率"), 30);
  score += Math.min(parseMetric(haystack, "已售"), 20);

  return score;
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function collectCandidates(page) {
  return page.evaluate(() => {
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(document.querySelectorAll(".search-offer-item, .major-offer"));

    return cards.slice(0, 12).map((card, index) => {
      const anchors = Array.from(card.querySelectorAll("a"));
      const informativeAnchors = anchors
        .map((link) => ({
          text: normalizeText(link.textContent || ""),
          href: link.href || "",
        }))
        .filter(
          (link) =>
            link.text &&
            !["找相似", "验厂报告", "旺旺在线"].includes(link.text) &&
            !/similar_search/.test(link.href),
        );

      const titleLink =
        informativeAnchors.find((link) => /offerId|detail\.m\.1688\.com/.test(link.href)) ||
        informativeAnchors.sort((left, right) => right.text.length - left.text.length)[0];

      const shopLink = informativeAnchors.find(
        (link) =>
          /\.1688\.com/.test(link.href) &&
          !/detail\.m\.1688\.com/.test(link.href) &&
          !/offerId/.test(link.href),
      );
      const imLink = Array.from(card.querySelectorAll("a")).find((link) =>
        normalizeText(link.textContent).includes("旺旺在线"),
      );

      return {
        index,
        title: normalizeText(titleLink?.textContent || ""),
        text: normalizeText(card.textContent || ""),
        offerHref: titleLink?.href || "",
        shopName: normalizeText(shopLink?.textContent || ""),
        shopHref: shopLink?.href || "",
        imHref: imLink?.href || "",
      };
    });
  });
}

async function clickChooseChatTool(page, events) {
  const selectors = [
    'button:has-text("确定")',
    'button:has-text("确认")',
    '[role="dialog"] button',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => {});
        events.push({ type: "action", text: `clicked ${selector}` });
        await page.waitForTimeout(2000);
        return true;
      }
    }
  }

  return false;
}

async function getCoreFrame(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frames().find((entry) => entry.url().includes("def_cbu_web_im_core"));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  return null;
}

async function collectImState(coreFrame) {
  return coreFrame.evaluate(() => {
    const normalizeInnerText = (value) => String(value || "").replace(/\s+/g, " ").trim();

    return {
      href: location.href,
      text: normalizeInnerText(document.body?.innerText || ""),
      buttons: Array.from(document.querySelectorAll("button"))
        .map((button) => ({
          text: normalizeInnerText(button.textContent || ""),
          disabled: Boolean(button.disabled),
        }))
        .slice(0, 40),
      inputs: Array.from(document.querySelectorAll("textarea,input,[contenteditable='true']"))
        .map((node) => ({
          tag: node.tagName,
          placeholder: node.getAttribute("placeholder") || "",
          value: "value" in node ? node.value || "" : node.textContent || "",
          contenteditable: node.getAttribute("contenteditable") || "",
        }))
        .slice(0, 40),
    };
  });
}

async function clickReconnectIfPresent(coreFrame, events) {
  const reconnect = coreFrame.locator("button").filter({ hasText: "点此重连" }).first();
  if (await reconnect.count()) {
    if (await reconnect.isVisible().catch(() => false)) {
      await reconnect.click().catch(() => {});
      events.push({ type: "action", text: "clicked reconnect" });
      await coreFrame.page().waitForTimeout(4000);
      return true;
    }
  }
  return false;
}

async function trySelectConversation(coreFrame, candidate, events) {
  const targets = [candidate.shopName, candidate.wangwangUid].filter(Boolean);

  for (const target of targets) {
    const searchBox = coreFrame.locator('input[placeholder*="搜索"]').first();
    if (await searchBox.count()) {
      await searchBox.fill(target).catch(() => {});
      const searchButton = coreFrame.locator(".ant-input-search-button").first();
      if (await searchButton.count()) {
        await searchButton.click().catch(() => {});
      } else {
        await searchBox.press("Enter").catch(() => {});
      }
      events.push({ type: "action", text: `searched ${target}` });
      await coreFrame.page().waitForTimeout(3000);
    }

    const onlineLookup = coreFrame.locator("text=在线中查找").or(coreFrame.locator("text=网络中查找")).first();
    if (await onlineLookup.count()) {
      if (await onlineLookup.isVisible().catch(() => false)) {
        await onlineLookup.click().catch(() => {});
        events.push({ type: "action", text: `clicked online lookup for ${target}` });
        await coreFrame.page().waitForTimeout(3000);
      }
    }

    const contactSelectors = [
      `.conversation-item:has-text("${target}")`,
      `.conversation-list-item:has-text("${target}")`,
      `.ant-list-item:has-text("${target}")`,
      `text=${target}`,
    ];

    for (const selector of contactSelectors) {
      const contact = coreFrame.locator(selector).first();
      if (await contact.count()) {
        if (await contact.isVisible().catch(() => false)) {
          await contact.click().catch(() => {});
          events.push({ type: "action", text: `clicked contact ${target} via ${selector}` });
          await coreFrame.page().waitForTimeout(3000);
          return true;
        }
      }
    }
  }

  return false;
}

async function typeAndSendMessage(page, coreFrame, message, events) {
  const textarea = coreFrame.locator('textarea, input[placeholder*="请输入消息"]').first();
  if (await textarea.count()) {
    if (await textarea.isVisible().catch(() => false)) {
      await textarea.fill(message).catch(() => {});
      events.push({ type: "action", text: "filled textarea" });
    }
  } else {
    const editor = coreFrame.locator('[contenteditable="true"]').last();
    if (!(await editor.count())) return false;
    await editor.click().catch(() => {});
    await page.keyboard.insertText(message);
    events.push({ type: "action", text: "typed contenteditable" });
  }

  const sendButton = coreFrame.locator("button").filter({ hasText: "发送" }).first();
  if (await sendButton.count()) {
    await sendButton.click().catch(() => {});
    events.push({ type: "action", text: "clicked send" });
  } else {
    await page.keyboard.press("Enter").catch(() => {});
    events.push({ type: "action", text: "pressed Enter" });
  }

  await page.waitForTimeout(4000);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const productRecord = await loadProductRecordBySlug(process.cwd(), args.slug);
  const chatPlan = productRecord ? buildSupplierChatPlan(productRecord) : null;
  const keyword = args.keyword || chatPlan?.keyword || DEFAULT_KEYWORD;
  const message = args.message || chatPlan?.firstMessage || DEFAULT_MESSAGE;
  const runId = `1688-inquiry-${timestamp()}`;
  const outputBase = path.join(OUTPUT_DIR, runId);
  const events = [];

  await ensureDir(outputBase);

  const browser = await chromium.launch({
    channel: "msedge",
    headless: args.headless,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });

  try {
    const homePage = await context.newPage();
    await homePage.goto("https://www.1688.com/?src=desktop", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await homePage.waitForTimeout(3000);

    const searchInput = homePage.locator("input.ali-search-input").first();
    await searchInput.fill(keyword);

    const [searchPageMaybe] = await Promise.all([
      context.waitForEvent("page").catch(() => null),
      searchInput.press("Enter"),
    ]);

    const resultsPage = searchPageMaybe || homePage;
    await resultsPage.waitForLoadState("domcontentloaded").catch(() => {});
    await resultsPage.waitForTimeout(5000);

    const rawCandidates = await collectCandidates(resultsPage);
    const candidates = rawCandidates
      .filter((candidate) => candidate.imHref)
      .map((candidate) => {
        const wangwangUid = (() => {
          try {
            return decodeURIComponent(new URL(candidate.imHref).searchParams.get("uid") || "");
          } catch {
            return "";
          }
        })();

        return {
          ...candidate,
          wangwangUid,
          score: scoreCandidate(candidate),
        };
      })
      .sort((left, right) => right.score - left.score);

    const selectedCandidate = candidates[0];
    if (!selectedCandidate) {
      throw new Error("No searchable supplier candidate with 旺旺在线 link was found.");
    }

    await resultsPage.screenshot({
      path: path.join(outputBase, "search-results.png"),
      fullPage: true,
    });

    const imPage = await context.newPage();
    const responses = [];
    imPage.on("response", async (response) => {
      const url = response.url();
      if (/wwwebim|mtop|accs|sendmsg|conversation|message|relation/i.test(url)) {
        let text = "";
        try {
          text = await response.text();
        } catch {}
        responses.push({
          url,
          status: response.status(),
          text: text.slice(0, 1200),
        });
      }
    });
    imPage.on("console", (message) => {
      events.push({ type: "console", text: message.text() });
    });

    await imPage.goto(selectedCandidate.imHref, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await imPage.waitForTimeout(4000);
    await clickChooseChatTool(imPage, events);

    const coreFrame = await getCoreFrame(imPage);
    if (!coreFrame) {
      throw new Error("IM core frame not found.");
    }

    await clickReconnectIfPresent(coreFrame, events);
    let stateBeforeSelection = await collectImState(coreFrame);

    if (stateBeforeSelection.text.includes("尚未选择联系人")) {
      await trySelectConversation(coreFrame, selectedCandidate, events);
      await clickReconnectIfPresent(coreFrame, events);
      stateBeforeSelection = await collectImState(coreFrame);
    }

    const sendAttempted = await typeAndSendMessage(imPage, coreFrame, message, events);
    const finalState = await collectImState(coreFrame);

    await imPage.screenshot({
      path: path.join(outputBase, "im-page.png"),
      fullPage: true,
    });

    const summary = {
      runId,
      slug: productRecord?.slug || args.slug || "",
      productName: productRecord?.product?.name || "",
      profile: chatPlan?.profile || "",
      keyword,
      message,
      selectedCandidate,
      candidates,
      resultsUrl: resultsPage.url(),
      imUrl: imPage.url(),
      stateBeforeSelection,
      finalState,
      sendAttempted,
      responses,
      events,
    };

    await writeJson(path.join(outputBase, "summary.json"), summary);
    if (productRecord && sendAttempted) {
      productRecord.research.outreach = {
        ...(productRecord.research.outreach || {}),
        status: "contacted_waiting_reply",
        supplier_name: selectedCandidate.wangwangUid || selectedCandidate.shopName || "",
        supplier_im_url: selectedCandidate.imHref || "",
        supplier_shop_url: selectedCandidate.shopHref || "",
        search_summary_path: path.join(outputBase, "summary.json"),
        first_message_sent_at:
          productRecord.research.outreach?.first_message_sent_at || new Date().toISOString(),
        last_contacted_at: new Date().toISOString(),
        follow_up_sent_count: productRecord.research.outreach?.follow_up_sent_count || 0,
        nudge_sent_count: productRecord.research.outreach?.nudge_sent_count || 0,
      };
      productRecord.workflow.current_stage = "supplier_contacted_waiting_reply";
      productRecord.workflow.updated_at = new Date().toISOString();
      await writeWorkflowJson(productRecord.paths.product_json, productRecord);
      await refreshWorkflowArtifacts(getWorkflowPaths(process.cwd()));
    }
    console.log(JSON.stringify(summary, null, 2));

    if (args.keepOpen) {
      console.log("Keeping browser open. Close the browser window when done.");
      await new Promise(() => {});
    }
  } finally {
    if (!args.keepOpen) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
