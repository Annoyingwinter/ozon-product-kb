import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  buildSupplierResponseTemplate,
  getWorkflowPaths,
  listProductRecords,
  parseArgs,
  refreshWorkflowArtifacts,
  timestamp,
  writeJson,
} from "./merchant-workflow-lib.js";
import { buildSupplierChatPlan, DEFAULT_PRODUCT_SLUG } from "./supplier-chat-lib.js";

const STORAGE_STATE_PATH = path.resolve(".profiles", "alphashop", "storage-state.json");
const DEFAULT_SLUG = DEFAULT_PRODUCT_SLUG;
const DEFAULT_WAIT_REPLY_MS = 180000;
const DEFAULT_FOLLOW_UP_AFTER_MS = 30000;
const DEFAULT_NUDGE_MESSAGE =
  "老板，方便的话先把这款的起订量、价格、材质、重量尺寸和交期发我，我这边今天要先做一轮筛选。";
const LEGACY_FOLLOW_UP_MESSAGES = [
  "收到推荐卡片了。我现在只需要基础参数，请直接回复：1. MOQ；2. 500件和1000件单价；3. 材质；4. 单个净重和包装尺寸；5. 现货交期。谢谢。",
  "老板，我先不看推荐款，这边就确认这一款。麻烦直接回我 5 个信息就行：1）起订量；2）500件和1000件单价；3）材质和颜色；4）单个重量、包装尺寸；5）现货和交期。方便的话直接文字回我，谢谢。",
];
const DEFAULT_FOLLOW_UP_MESSAGE =
  "老板，我先不看推荐款，这边就确认这一款。麻烦直接回我 5 个信息就行：1）起订量；2）500件和1000件单价；3）材质和颜色；4）单个重量、包装尺寸；5）现货和交期。方便的话直接文字回我，谢谢。";

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function convertWeightToKg(rawValue, unit) {
  const amount = parseNumber(rawValue);
  if (!amount) return 0;
  if (/g|克/i.test(unit)) return Number((amount / 1000).toFixed(3));
  return amount;
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function findLatestInquirySummary(baseDir) {
  const outputDir = path.join(baseDir, "output", "playwright");
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const matches = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("1688-inquiry-")) continue;
    const summaryPath = path.join(outputDir, entry.name, "summary.json");
    try {
      const stats = await fs.stat(summaryPath);
      matches.push({ summaryPath, mtimeMs: stats.mtimeMs });
    } catch {}
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.summaryPath || "";
}

async function clickChooseChatTool(page, events) {
  const selectors = [
    'button:has-text("确定")',
    'button:has-text("确认")',
    '[role="dialog"] button',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click().catch(() => {});
    events.push({ type: "action", text: `clicked ${selector}` });
    await page.waitForTimeout(1500);
    return true;
  }

  return false;
}

async function getCoreFrame(page, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const frame = page.frames().find((entry) => entry.url().includes("def_cbu_web_im_core"));
    if (frame) return frame;
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickReconnectIfPresent(coreFrame, events) {
  const reconnect = coreFrame.locator("button").filter({ hasText: "点此重连" }).first();
  if (!(await reconnect.count())) return false;
  if (!(await reconnect.isVisible().catch(() => false))) return false;
  await reconnect.click().catch(() => {});
  events.push({ type: "action", text: "clicked reconnect" });
  await coreFrame.page().waitForTimeout(3000);
  return true;
}

async function trySelectConversation(coreFrame, target, events) {
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
    await coreFrame.page().waitForTimeout(2500);
  }

  const onlineLookup = coreFrame.locator("text=在线中查找").or(coreFrame.locator("text=网络中查找")).first();
  if (await onlineLookup.count()) {
    if (await onlineLookup.isVisible().catch(() => false)) {
      await onlineLookup.click().catch(() => {});
      events.push({ type: "action", text: `clicked online lookup for ${target}` });
      await coreFrame.page().waitForTimeout(2500);
    }
  }

  const selectors = [
    `.conversation-item:has-text("${target}")`,
    `.conversation-list-item:has-text("${target}")`,
    `.ant-list-item:has-text("${target}")`,
    `text=${target}`,
  ];

  for (const selector of selectors) {
    const locator = coreFrame.locator(selector).first();
    if (!(await locator.count())) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click().catch(() => {});
    events.push({ type: "action", text: `clicked contact ${target} via ${selector}` });
    await coreFrame.page().waitForTimeout(2500);
    return true;
  }

  return false;
}

async function typeAndSendMessage(page, coreFrame, message, events, label = "sent message") {
  const textarea = coreFrame.locator("textarea").first();
  if (await textarea.count()) {
    await textarea.fill(message).catch(() => {});
  } else {
    const editor = coreFrame.locator('[contenteditable="true"]').last();
    if (!(await editor.count())) return false;
    await editor.click().catch(() => {});
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.insertText(message);
  }

  const sendButton = coreFrame.locator("button").filter({ hasText: "发送" }).first();
  if (await sendButton.count()) {
    await sendButton.click().catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }

  events.push({ type: "action", text: label });
  await page.waitForTimeout(2500);
  return true;
}

async function collectConversationSnapshot(coreFrame) {
  return coreFrame.evaluate(() => {
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const messageRoot =
      document.querySelector(".message-list .rc-scrollbars-view") ||
      document.querySelector(".message-list") ||
      document.body;

    const text = normalizeText(messageRoot?.innerText || "");
    const lines = text
      .split(/\n+/)
      .map((item) => normalizeText(item))
      .filter(Boolean);

    const bubbles = Array.from(
      document.querySelectorAll(
        '.message-list .message-item, .message-list .msg-item, .message-list .message, .message-list [class*="message"], .message-list [class*="card"]',
      ),
    )
      .map((node) => normalizeText(node.textContent || ""))
      .filter(Boolean)
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 60);

    const header = normalizeText(
      document.querySelector(".conversation-header")?.textContent ||
        document.querySelector(".ww_header")?.textContent ||
        "",
    );

    return {
      header,
      text,
      lines,
      bubbles,
      hasNoContact: /尚未选择联系人/.test(text),
    };
  });
}

function classifyConversation(snapshot, sentMessages = []) {
  const sentSet = new Set(sentMessages.map((item) => normalize(item)));
  const timestampPattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g;
  const ignoredPatterns = [
    /暂无更多消息/,
    /请输入消息/,
    /点击发送按钮发送/,
    /^\d+\s*\/\s*500$/,
    /^已读$/,
    /^新消息$/,
    /^消息$/,
    /^商品$/,
    /^档案$/,
    /^我的订单$/,
    /^现在$/,
    /^\d{4}-\d{2}-\d{2}/,
    /^tb\d+/i,
    /^1条新消息/,
  ];
  const autoOnlyPatterns = [
    /新品推荐/,
    /卡片消息/,
    /^¥\d/,
    /推荐/,
    /店铺上新/,
    /欢迎咨询/,
    /处理中/,
    /请稍候/,
    /平台已通知商家/,
    /请耐心等待/,
  ];
  const detailPatterns = [/MOQ/i, /起订/, /单价/, /材质/, /重量/, /净重/, /包装/, /尺寸/, /交期/, /现货/, /报价/, /样品/];

  const segmentedLines = snapshot.text
    .split(timestampPattern)
    .map((item) => normalize(item))
    .filter(Boolean);

  const rawCandidates = [...segmentedLines, ...snapshot.lines];
  const candidateLines = rawCandidates.filter((line, index, array) => {
    const normalized = normalize(line);
    if (!normalized) return false;
    if (sentSet.has(normalized)) return false;
    if (Array.from(sentSet).some((message) => normalized.includes(message))) return false;
    if (ignoredPatterns.some((pattern) => pattern.test(normalized))) return false;
    if (array.findIndex((item) => normalize(item) === normalized) !== index) return false;
    return true;
  });

  const hasDetailReply = candidateLines.some((line) => detailPatterns.some((pattern) => pattern.test(line)));
  const autoOnly =
    candidateLines.length > 0 &&
    candidateLines.every((line) => autoOnlyPatterns.some((pattern) => pattern.test(line)));

  return {
    candidateLines,
    hasHumanReply: hasDetailReply || (candidateLines.length > 0 && !autoOnly),
    autoOnly,
  };
}

function fillFromText(response, text) {
  const compact = normalize(text);

  const moqMatch = compact.match(/(?:MOQ|起订量|起订)\D{0,6}(\d+)/i);
  if (moqMatch) response.moq = parseNumber(moqMatch[1]);

  const unitMatch = compact.match(/(?:单价|出厂价|批发价|价格)\D{0,6}(\d+(?:\.\d+)?)/i);
  if (unitMatch) response.unit_price_cny = parseNumber(unitMatch[1]);

  const sampleMatch = compact.match(/(?:样品价|打样价)\D{0,6}(\d+(?:\.\d+)?)/i);
  if (sampleMatch) response.sample_price_cny = parseNumber(sampleMatch[1]);

  const netWeightMatch = compact.match(/(?:净重|单个净重)\D{0,6}(\d+(?:\.\d+)?)\s*(kg|公斤|g|克)/i);
  if (netWeightMatch) response.net_weight_kg = convertWeightToKg(netWeightMatch[1], netWeightMatch[2]);

  const packedWeightMatch = compact.match(/(?:毛重|包装重|装箱重)\D{0,6}(\d+(?:\.\d+)?)\s*(kg|公斤|g|克)/i);
  if (packedWeightMatch) response.packed_weight_kg = convertWeightToKg(packedWeightMatch[1], packedWeightMatch[2]);

  const dimensionMatch = compact.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)(?:\s*cm|\s*厘米)?/i);
  if (dimensionMatch) {
    response.packed_dimensions_cm = {
      length: parseNumber(dimensionMatch[1]),
      width: parseNumber(dimensionMatch[2]),
      height: parseNumber(dimensionMatch[3]),
    };
  }

  const sampleLeadMatch = compact.match(/(?:样品|打样)[^0-9]{0,8}(\d+)\s*(?:天|日)/i);
  if (sampleLeadMatch) response.sample_lead_time_days = parseNumber(sampleLeadMatch[1]);

  const bulkLeadMatch = compact.match(/(?:大货|交期|现货)[^0-9]{0,8}(\d+)\s*(?:天|日)/i);
  if (bulkLeadMatch) response.bulk_lead_time_days = parseNumber(bulkLeadMatch[1]);

  const materialMatch = compact.match(/(?:材质|面料)[:： ]?([^，。；\n]+)/i);
  if (materialMatch) {
    response.materials = materialMatch[1]
      .split(/[、,/，]/)
      .map((item) => normalize(item))
      .filter(Boolean);
  }

  const variantMatch = compact.match(/(?:颜色|款式|规格)[:： ]?([^。；\n]+)/i);
  if (variantMatch) {
    response.variants = variantMatch[1]
      .split(/[、,/，]/)
      .map((item) => normalize(item))
      .filter(Boolean);
  }

  response.contains_battery = /电池|锂电|充电/i.test(compact);
  response.contains_liquid = /液体|湿巾|喷雾/i.test(compact);
  response.contains_magnet = /磁/i.test(compact);
  response.food_contact = /食品级|食品接触/i.test(compact);
}

async function upsertChatCapture(record, capture) {
  record.research.chat_captures = Array.isArray(record.research.chat_captures)
    ? record.research.chat_captures
    : [];

  record.research.chat_captures.push(capture);
  record.research.last_chat_capture_path = capture.path;
  record.research.outreach = {
    ...(record.research.outreach || {}),
    status: capture.has_human_reply
      ? "replied"
      : record.research.outreach?.status || "contacted_waiting_reply",
    last_contacted_at: new Date().toISOString(),
    follow_up_sent_count:
      (record.research.outreach?.follow_up_sent_count || 0) + (capture.follow_up_sent ? 1 : 0),
    nudge_sent_count:
      (record.research.outreach?.nudge_sent_count || 0) + (capture.nudge_sent ? 1 : 0),
  };
  if (!capture.has_human_reply) {
    record.workflow.current_stage = "supplier_contacted_waiting_reply";
  }
  record.workflow.updated_at = new Date().toISOString();
}

async function ingestAutoDraft(record, autoDraftPath, responseData) {
  const archivedResponsePath = path.join(
    path.dirname(record.paths.product_json),
    `supplier-response.${timestamp()}.json`,
  );

  await writeJson(autoDraftPath, responseData);
  await writeJson(archivedResponsePath, responseData);

  record.research.latest_supplier_response_path = archivedResponsePath;
  record.research.supplier_responses = Array.isArray(record.research.supplier_responses)
    ? record.research.supplier_responses
    : [];
  record.research.supplier_responses.push({
    ingested_at: new Date().toISOString(),
    path: archivedResponsePath,
    data: responseData,
    source: "1688-auto-chat-capture",
  });
  record.workflow.current_stage = "human_review_pending";
  record.workflow.updated_at = new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = args.slug || DEFAULT_SLUG;
  const waitReplyMs = parseNumber(args["wait-reply-ms"]) || DEFAULT_WAIT_REPLY_MS;
  const followUpAfterMs = parseNumber(args["follow-up-after-ms"]) || DEFAULT_FOLLOW_UP_AFTER_MS;
  const observeOnly = Boolean(args["observe-only"]);
  const baseDir = process.cwd();
  const paths = getWorkflowPaths(baseDir);
  const productEntries = await listProductRecords(paths.productsDir);
  const productEntry = productEntries.find(({ record }) => record.slug === slug);

  if (!productEntry) {
    throw new Error(`Unknown product slug: ${slug}`);
  }
  const chatPlan = buildSupplierChatPlan(productEntry.record);

  const summaryPath = args.summary ? path.resolve(args.summary) : await findLatestInquirySummary(baseDir);
  if (!summaryPath) {
    throw new Error("No 1688 inquiry summary found. Run npm run 1688:inquiry first.");
  }

  const inquirySummary = await readJson(summaryPath);
  if (!inquirySummary?.selectedCandidate?.imHref) {
    throw new Error(`Invalid inquiry summary: ${summaryPath}`);
  }
  const followUpMessage = args["follow-up-message"] || chatPlan.followUpMessage || DEFAULT_FOLLOW_UP_MESSAGE;
  const nudgeMessage = args["nudge-message"] || chatPlan.nudgeMessage || DEFAULT_NUDGE_MESSAGE;

  const runId = `1688-watch-${timestamp()}`;
  const outputDir = path.join(paths.outputDir, "playwright", runId);
  const productDir = path.dirname(productEntry.record.paths.product_json);
  await ensureDir(outputDir);

  const sentMessages = [
    inquirySummary.message,
    chatPlan.firstMessage,
    chatPlan.followUpMessage,
    chatPlan.nudgeMessage,
    DEFAULT_FOLLOW_UP_MESSAGE,
    DEFAULT_NUDGE_MESSAGE,
    ...LEGACY_FOLLOW_UP_MESSAGES,
  ].filter(Boolean);
  const events = [];
  let followUpSent = false;
  let nudgeSent = false;
  let finalSnapshot = null;
  let finalClassification = null;

  const browser = await chromium.launch({
    channel: "msedge",
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });

  try {
    const page = await context.newPage();
    await page.goto(inquirySummary.selectedCandidate.imHref, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(3000);
    await clickChooseChatTool(page, events);

    const coreFrame = await getCoreFrame(page);
    if (!coreFrame) {
      throw new Error("IM core frame not found.");
    }

    await clickReconnectIfPresent(coreFrame, events);
    await trySelectConversation(coreFrame, inquirySummary.selectedCandidate.wangwangUid, events);

    const startedAt = Date.now();
    const effectiveWaitReplyMs = observeOnly ? 0 : waitReplyMs;

    while (Date.now() - startedAt < effectiveWaitReplyMs) {
      finalSnapshot = await collectConversationSnapshot(coreFrame);
      finalClassification = classifyConversation(finalSnapshot, sentMessages);

      if (!finalSnapshot.hasNoContact && finalClassification.hasHumanReply) {
        break;
      }

      if (
        !observeOnly &&
        !followUpSent &&
        !finalSnapshot.hasNoContact &&
        finalClassification.autoOnly &&
        Date.now() - startedAt >= followUpAfterMs
      ) {
        const sent = await typeAndSendMessage(page, coreFrame, followUpMessage, events, "sent follow-up message");
        if (sent) {
          followUpSent = true;
          sentMessages.push(followUpMessage);
        }
      }

      if (
        !observeOnly &&
        !nudgeSent &&
        !finalSnapshot.hasNoContact &&
        followUpSent &&
        finalClassification.autoOnly &&
        Date.now() - startedAt >= followUpAfterMs + 15000
      ) {
        const sent = await typeAndSendMessage(page, coreFrame, nudgeMessage, events, "sent nudge message");
        if (sent) {
          nudgeSent = true;
          sentMessages.push(nudgeMessage);
        }
      }

      await page.waitForTimeout(10000);
    }

    finalSnapshot = finalSnapshot || (await collectConversationSnapshot(coreFrame));
    finalClassification = finalClassification || classifyConversation(finalSnapshot, sentMessages);

    const capture = {
      captured_at: new Date().toISOString(),
      slug,
      summary_path: summaryPath,
      candidate: inquirySummary.selectedCandidate,
      transcript_text: finalSnapshot.text,
      transcript_lines: finalSnapshot.lines,
      message_candidates: finalClassification.candidateLines,
      auto_only: finalClassification.autoOnly,
      has_human_reply: finalClassification.hasHumanReply,
      follow_up_sent: followUpSent,
      nudge_sent: nudgeSent,
      events,
    };

    const outputCapturePath = path.join(outputDir, "chat-capture.json");
    const knowledgeCapturePath = path.join(productDir, `supplier-chat.${timestamp()}.json`);
    await writeJson(outputCapturePath, capture);
    await writeJson(knowledgeCapturePath, capture);

    const record = productEntry.record;
    record.research.outreach = {
      ...(record.research.outreach || {}),
      supplier_name:
        record.research.outreach?.supplier_name ||
        inquirySummary.selectedCandidate.wangwangUid ||
        inquirySummary.selectedCandidate.shopName ||
        "",
      supplier_im_url: record.research.outreach?.supplier_im_url || inquirySummary.selectedCandidate.imHref || "",
      supplier_shop_url:
        record.research.outreach?.supplier_shop_url || inquirySummary.selectedCandidate.shopHref || "",
    };
    await upsertChatCapture(record, {
      captured_at: capture.captured_at,
      path: knowledgeCapturePath,
      has_human_reply: capture.has_human_reply,
      auto_only: capture.auto_only,
      follow_up_sent: capture.follow_up_sent,
      nudge_sent: capture.nudge_sent,
    });

    let autoDraftPath = "";
    if (capture.has_human_reply) {
      const responseData = buildSupplierResponseTemplate(record);
      responseData.supplier_name =
        inquirySummary.selectedCandidate.wangwangUid || inquirySummary.selectedCandidate.shopName || "";
      responseData.supplier_type = "unknown";
      responseData.store_url = inquirySummary.selectedCandidate.shopHref || "";
      responseData.source_url = inquirySummary.selectedCandidate.imHref || "";
      responseData.seller_notes = capture.message_candidates;
      responseData.auto_generated_from_chat = true;
      responseData.raw_chat_capture_path = knowledgeCapturePath;

      fillFromText(responseData, capture.message_candidates.join(" "));

      autoDraftPath = path.join(productDir, "supplier-response.auto-draft.json");
      await ingestAutoDraft(record, autoDraftPath, responseData);
    }

    await writeJson(record.paths.product_json, record);
    await refreshWorkflowArtifacts(paths);

    await page.screenshot({
      path: path.join(outputDir, "watch-final.png"),
      fullPage: true,
    });

    console.log(
      JSON.stringify(
        {
          slug,
          summaryPath,
          outputCapturePath,
          knowledgeCapturePath,
          autoDraftPath,
          followUpSent,
          nudgeSent,
          hasHumanReply: capture.has_human_reply,
          autoOnly: capture.auto_only,
          messageCandidates: capture.message_candidates,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
