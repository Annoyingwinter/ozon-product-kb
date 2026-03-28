import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current.startsWith("--") && next && !next.startsWith("--")) {
      args[current.slice(2)] = next;
      i += 1;
      continue;
    }

    if (current.startsWith("--")) {
      args[current.slice(2)] = true;
    }
  }

  return args;
}

export function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

export async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

export async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
}

export function normalizeDecision(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "go") return "Go";
  if (normalized === "watch") return "Watch";
  if (normalized === "no-go" || normalized === "nogo" || normalized === "no go") {
    return "No-Go";
  }
  return "";
}

export function slugifyProductName(name, index = 0) {
  const safeBase = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || `item-${index + 1}`;

  const hash = crypto.createHash("sha1").update(String(name || safeBase)).digest("hex").slice(0, 8);
  return `${safeBase}-${hash}`;
}

export function getWorkflowPaths(baseDir = process.cwd()) {
  const outputDir = path.join(baseDir, "output");
  const knowledgeBaseDir = path.join(baseDir, "knowledge-base");
  const productsDir = path.join(knowledgeBaseDir, "products");
  const queuesDir = path.join(baseDir, "queues");

  return {
    baseDir,
    outputDir,
    knowledgeBaseDir,
    productsDir,
    queuesDir,
    indexPath: path.join(knowledgeBaseDir, "index.json"),
    researchQueuePath: path.join(queuesDir, "supplier-research-queue.json"),
    blockedQueuePath: path.join(queuesDir, "supplier-compare-blocked-queue.json"),
    followUpQueuePath: path.join(queuesDir, "supplier-followup-queue.json"),
    reviewQueuePath: path.join(queuesDir, "human-review-queue.json"),
    listingQueuePath: path.join(queuesDir, "listing-draft-queue.json"),
    blockedArtifactsDir: path.join(outputDir, "product-kb-blocked"),
    liveStatusJsonPath: path.join(outputDir, "live-status.json"),
    liveStatusMdPath: path.join(outputDir, "live-status.md"),
  };
}

export async function findLatestAnalysisFile(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const analysisFiles = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".analysis.json")) continue;
    const fullPath = path.join(outputDir, entry.name);
    const stats = await fs.stat(fullPath);
    analysisFiles.push({ fullPath, mtimeMs: stats.mtimeMs });
  }

  analysisFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return analysisFiles[0]?.fullPath || "";
}

export async function loadAnalysis(inputPath, outputDir) {
  const resolvedInput = inputPath ? path.resolve(inputPath) : await findLatestAnalysisFile(outputDir);
  if (!resolvedInput) {
    throw new Error("No analysis file found. Run the selection pipeline first or pass --input.");
  }

  const parsed = await readJson(resolvedInput);
  if (!parsed || !Array.isArray(parsed.products)) {
    throw new Error(`Invalid analysis file: ${resolvedInput}`);
  }

  return {
    analysisPath: resolvedInput,
    analysis: parsed,
  };
}

export async function listProductRecords(productsDir) {
  try {
    const entries = await fs.readdir(productsDir, { withFileTypes: true });
    const records = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = path.join(productsDir, entry.name, "product.json");
      const record = await readJson(recordPath);
      if (record) records.push({ recordPath, record });
    }

    return records;
  } catch {
    return [];
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortByLatestTimestamp(left, right) {
  return parseTimestamp(right.at) - parseTimestamp(left.at);
}

function formatTimestamp(value) {
  return value || "";
}

function pickLatestActivity(candidates) {
  return safeArray(candidates)
    .filter((item) => item && item.at)
    .sort(sortByLatestTimestamp)[0] || {
      at: "",
      label: "",
      detail: "",
    };
}

function summarizeRecentActivity(record) {
  const stage = record?.workflow?.current_stage || "";
  const outreach = record?.research?.outreach || {};
  const review = record?.review || {};
  const chatCaptures = safeArray(record?.research?.chat_captures);
  const supplierResponses = safeArray(record?.research?.supplier_responses);
  const latestCapture = chatCaptures.at(-1) || null;
  const latestResponse = supplierResponses.at(-1) || null;

  const candidates = [
    stage === "supplier_research_pending"
      ? {
          at: record?.workflow?.updated_at || record?.workflow?.created_at || "",
          label: "待首轮询盘",
          detail: "产品已经进入供应商调研队列。",
        }
      : null,
    stage === "supplier_contacted_waiting_reply"
      ? {
          at: latestCapture?.captured_at || outreach.last_contacted_at || record?.workflow?.updated_at || "",
          label: latestCapture?.has_human_reply ? "商家已回复" : "等待回复",
          detail: latestCapture?.has_human_reply
            ? "监视器已捕获商家回复，AI 可以继续追问或整理参数。"
            : "首轮消息已发出，等待商家回复。",
        }
      : null,
    stage === "human_review_pending"
      ? {
          at: review.reviewed_at || latestResponse?.ingested_at || record?.workflow?.updated_at || "",
          label: "待人工审核",
          detail: "已拿到供应商回复，进入人工审核队列。",
        }
      : null,
    stage === "approved_for_listing"
      ? {
          at: record?.workflow?.updated_at || review.reviewed_at || "",
          label: "待上架草稿",
          detail: "商品已批准，等待生成或同步上架草稿。",
        }
      : null,
    stage === "rejected"
      ? {
          at: record?.workflow?.updated_at || review.reviewed_at || "",
          label: "已拒绝",
          detail: "该商品已被排除，不再推进。",
        }
      : null,
    latestCapture?.captured_at
      ? {
          at: latestCapture.captured_at,
          label: latestCapture.has_human_reply ? "捕获到回复" : "轮巡会话",
          detail: latestCapture.has_human_reply
            ? "聊天快照里出现了商家回复。"
            : "聊天快照已刷新，正在跟踪会话。",
        }
      : null,
    latestResponse?.ingested_at
      ? {
          at: latestResponse.ingested_at,
          label: "回复已入库",
          detail: "结构化供应商回复已写入知识库。",
        }
      : null,
    outreach.first_message_sent_at
      ? {
          at: outreach.first_message_sent_at,
          label: "首轮已发送",
          detail: `首轮已发出，当前追问次数 ${outreach.follow_up_sent_count || 0}。`,
        }
      : null,
    outreach.last_contacted_at
      ? {
          at: outreach.last_contacted_at,
          label: "最近联系",
          detail: "商品最近一次与商家有对话动作。",
        }
      : null,
    record?.workflow?.updated_at
      ? {
          at: record.workflow.updated_at,
          label: "工作流更新",
          detail: `当前阶段：${stage || "unknown"}`,
        }
      : null,
  ];

  return pickLatestActivity(candidates);
}

function buildSelectionCounts(analysis) {
  const counts = {
    total: 0,
    Go: 0,
    Watch: 0,
    "No-Go": 0,
    Other: 0,
  };

  for (const product of analysis?.products || []) {
    const decision = normalizeDecision(product.final_decision || product.go_or_no_go);
    counts.total += 1;
    if (decision === "Go") counts.Go += 1;
    else if (decision === "Watch") counts.Watch += 1;
    else if (decision === "No-Go") counts["No-Go"] += 1;
    else counts.Other += 1;
  }

  return counts;
}

function buildLiveStatusMarkdown(status) {
  const lines = [
    "# Live Status",
    "",
    `Generated at: ${formatTimestamp(status.generatedAt)}`,
    "",
    "## Selection",
    `- Analysis file: ${status.selection.analysisPath || "none"}`,
    `- Total analyzed: ${status.selection.total}`,
    `- Go: ${status.selection.Go}`,
    `- Watch: ${status.selection.Watch}`,
    `- No-Go: ${status.selection["No-Go"]}`,
    `- Other: ${status.selection.Other}`,
    "",
    "## Workflow",
    `- Total products: ${status.workflow.total}`,
    `- Supplier research pending: ${status.workflow.supplier_research_pending}`,
    `- Supplier contacted waiting reply: ${status.workflow.supplier_contacted_waiting_reply}`,
    `- Human review pending: ${status.workflow.human_review_pending}`,
    `- Approved for listing: ${status.workflow.approved_for_listing}`,
    `- Rejected: ${status.workflow.rejected}`,
    "",
    "## Outreach",
    `- Contacted suppliers: ${status.outreach.contacted}`,
    `- Waiting reply: ${status.outreach.waiting_reply}`,
    `- Replied: ${status.outreach.replied}`,
    `- With chat captures: ${status.outreach.with_chat_capture}`,
    `- First messages sent: ${status.outreach.first_messages_sent}`,
    `- Follow-up messages sent: ${status.outreach.follow_ups_sent}`,
    `- Nudges sent: ${status.outreach.nudges_sent}`,
    "",
    "## Current Queues",
    `- Research queue: ${status.queues.research.count}`,
    `- Follow-up queue: ${status.queues.followUp.count}`,
    `- Human review queue: ${status.queues.review.count}`,
    `- Listing draft queue: ${status.queues.listing.count}`,
    "",
    "### Waiting Reply",
    ...(status.queues.followUp.sample.length
      ? status.queues.followUp.sample.map(
          (item) =>
            `- ${item.slug} | ${item.name} | ${item.supplierName || "unknown"} | last contact ${item.lastContactedAt || "unknown"} | captures ${item.chatCaptureCount} | replies ${item.humanReplyCount}`,
        )
      : ["- none"]),
    "",
    "### Research Pending",
    ...(status.queues.research.sample.length
      ? status.queues.research.sample.map(
          (item) => `- ${item.slug} | ${item.name} | ${item.profile} | ${item.stage}`,
        )
      : ["- none"]),
    "",
    "### Human Review",
    ...(status.queues.review.sample.length
      ? status.queues.review.sample.map(
          (item) => `- ${item.slug} | ${item.name} | latest response ${item.latestSupplierResponsePath || "none"}`,
        )
      : ["- none"]),
    "",
    "### Listing Draft",
    ...(status.queues.listing.sample.length
      ? status.queues.listing.sample.map(
          (item) => `- ${item.slug} | ${item.name} | ${item.listingStatus || "not_ready"}`,
        )
      : ["- none"]),
    "",
    "## Recent Activity",
    ...(status.recentActivity.length
      ? status.recentActivity.map(
          (item, index) =>
            `${index + 1}. ${item.at} | ${item.slug} | ${item.name} | ${item.label} | ${item.detail}`,
        )
      : ["- none"]),
    "",
    "## Files",
    `- Knowledge base index: ${status.files.indexPath}`,
    `- Research queue: ${status.files.researchQueuePath}`,
    `- Follow-up queue: ${status.files.followUpQueuePath}`,
    `- Human review queue: ${status.files.reviewQueuePath}`,
    `- Listing queue: ${status.files.listingQueuePath}`,
    `- Live status JSON: ${status.files.liveStatusJsonPath}`,
    "",
  ];

  return lines.join("\n");
}

async function buildLiveStatus(paths, records, queues) {
  let analysisPath = "";
  let analysis = null;
  try {
    analysisPath = await findLatestAnalysisFile(paths.outputDir);
    if (analysisPath) {
      analysis = await readJson(analysisPath, null);
    }
  } catch {
    analysisPath = "";
    analysis = null;
  }

  const selection = buildSelectionCounts(analysis);
  const researchQueue = queues?.researchQueue || [];
  const followUpQueue = queues?.followUpQueue || [];
  const reviewQueue = queues?.reviewQueue || [];
  const listingQueue = queues?.listingQueue || [];

  const outreachRecords = records.filter((record) => record?.workflow?.current_stage === "supplier_contacted_waiting_reply");
  const withHumanReply = outreachRecords.filter((record) =>
    safeArray(record?.research?.chat_captures).some((capture) => Boolean(capture?.has_human_reply)),
  );

  const liveStatus = {
    generatedAt: new Date().toISOString(),
    files: {
      analysisPath,
      indexPath: paths.indexPath,
      researchQueuePath: paths.researchQueuePath,
      followUpQueuePath: paths.followUpQueuePath,
      reviewQueuePath: paths.reviewQueuePath,
      listingQueuePath: paths.listingQueuePath,
      liveStatusJsonPath: paths.liveStatusJsonPath,
      liveStatusMdPath: paths.liveStatusMdPath,
    },
    selection: {
      analysisPath,
      ...selection,
    },
    workflow: {
      total: records.length,
      supplier_research_pending: researchQueue.length,
      supplier_contacted_waiting_reply: followUpQueue.length,
      human_review_pending: reviewQueue.length,
      approved_for_listing: listingQueue.length,
      rejected: records.filter((record) => record?.workflow?.current_stage === "rejected").length,
    },
    outreach: {
      contacted: outreachRecords.length,
      waiting_reply: outreachRecords.length - withHumanReply.length,
      replied: withHumanReply.length,
      with_chat_capture: outreachRecords.filter((record) => safeArray(record?.research?.chat_captures).length > 0).length,
      first_messages_sent: outreachRecords.filter((record) => Boolean(record?.research?.outreach?.first_message_sent_at)).length,
      follow_ups_sent: outreachRecords.reduce(
        (sum, record) => sum + Number(record?.research?.outreach?.follow_up_sent_count || 0),
        0,
      ),
      nudges_sent: outreachRecords.reduce(
        (sum, record) => sum + Number(record?.research?.outreach?.nudge_sent_count || 0),
        0,
      ),
    },
    queues: {
      research: {
        count: researchQueue.length,
        sample: researchQueue.slice(0, 5).map((item) => ({
          slug: item.slug,
          name: item.name || "",
          profile: item.profile || "",
          stage: item.stage || "",
        })),
      },
      followUp: {
        count: followUpQueue.length,
        sample: followUpQueue.slice(0, 5).map((item) => {
          const record = records.find((entry) => entry.slug === item.slug);
          const chatCaptures = safeArray(record?.research?.chat_captures);
          const latestCapture = chatCaptures.at(-1) || null;
          return {
            slug: item.slug,
            name: item.name || "",
            supplierName: item.supplierName || "",
            lastContactedAt: item.lastContactedAt || item.firstMessageSentAt || "",
            chatCaptureCount: chatCaptures.length,
            humanReplyCount: chatCaptures.filter((capture) => Boolean(capture?.has_human_reply)).length,
            latestCapturePath: item.lastChatCapturePath || "",
            hasHumanReply: Boolean(latestCapture?.has_human_reply),
          };
        }),
      },
      review: {
        count: reviewQueue.length,
        sample: reviewQueue.slice(0, 5).map((item) => ({
          slug: item.slug,
          name: item.name || "",
          latestSupplierResponsePath: item.latestSupplierResponsePath || "",
        })),
      },
      listing: {
        count: listingQueue.length,
        sample: listingQueue.slice(0, 5).map((item) => ({
          slug: item.slug,
          name: item.name || "",
          listingStatus: item.listingStatus || "",
        })),
      },
    },
    recentActivity: records
      .map((record) => {
        const activity = summarizeRecentActivity(record);
        return {
          slug: record.slug,
          name: record?.product?.name || record.slug || "",
          stage: record?.workflow?.current_stage || "",
          at: activity.at || record?.workflow?.updated_at || "",
          label: activity.label || "",
          detail: activity.detail || "",
        };
      })
      .filter((item) => item.at)
      .sort((left, right) => parseTimestamp(right.at) - parseTimestamp(left.at))
      .slice(0, 10),
  };

  return {
    json: liveStatus,
    markdown: buildLiveStatusMarkdown(liveStatus),
  };
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toKeywordBase(value) {
  return compactWhitespace(value)
    .replace(/[()（）【】\[\]]/g, " ")
    .replace(/[\/+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, words) {
  return words.some((word) => text.includes(word));
}

const PLATFORM_DETAILS = {
  Yiwugo: {
    positioning: "Use Yiwugo for spot-stock small commodities, home storage, household organizers, and fast-moving white-label goods.",
    supplier_signals: [
      "Prioritize stalls or stores that show stable spot inventory and multiple color or size variants.",
      "Capture contact person, phone, WeChat, market block, and booth number when available.",
      "Prefer suppliers that can provide neutral packaging and carton specs without repeated follow-up.",
    ],
    contact_channels: ["site-chat", "phone", "wechat"],
  },
  "1688": {
    positioning: "Use 1688 for spot stock, factory-direct stores, and mature domestic white-label supply chains.",
    supplier_signals: [
      "Prioritize source factories or deep trade-integrated stores.",
      "Collect MOQ, unit price, packed dimensions, and carton quantity in the first round.",
    ],
    contact_channels: ["site-chat", "wangwang", "wechat"],
  },
  Alibaba: {
    positioning: "Use Alibaba to verify export experience, English materials, and compliance or certification readiness.",
    supplier_signals: [
      "Prioritize suppliers with export records, certification files, and OEM or ODM support.",
      "Use it as the escalation channel for regulated, export-facing, or customization-heavy products.",
    ],
    contact_channels: ["rfq", "message-center", "whatsapp", "wechat"],
  },
};

function getPlatformMetadata(platforms = []) {
  return platforms.map((platform) => ({
    platform,
    positioning: PLATFORM_DETAILS[platform]?.positioning || "",
    supplier_signals: PLATFORM_DETAILS[platform]?.supplier_signals || [],
    contact_channels: PLATFORM_DETAILS[platform]?.contact_channels || [],
  }));
}

export function detectProductProfile(product) {
  const text = compactWhitespace(
    `${product.name || ""} ${product.category || ""} ${product.why_it_can_sell || ""} ${(product.risk_notes || []).join(" ")}`,
  ).toLowerCase();

  const riskTags = [];
  if (containsAny(text, ["battery", "usb", "充电", "电池", "led", "电动"])) riskTags.push("battery");
  if (containsAny(text, ["液体", "湿巾", "liquid"])) riskTags.push("liquid");
  if (containsAny(text, ["磁", "磁吸", "magnet"])) riskTags.push("magnet");
  if (containsAny(text, ["食品", "food", "保鲜", "餐", "厨房"])) riskTags.push("food-contact");
  if (containsAny(text, ["服装", "衣", "尺码", "面料"])) riskTags.push("size-variant");
  if (containsAny(text, ["宠物"])) riskTags.push("pet");
  if (containsAny(text, ["车", "汽车"])) riskTags.push("vehicle");

  let profile = "general-merchandise";

  if (containsAny(text, ["衣", "服", "面料", "尺码", "服饰"])) {
    profile = "apparel";
  } else if (containsAny(text, ["食品", "保鲜", "餐", "厨房", "食碗", "漏斗", "蜂蜡"])) {
    profile = "food-contact-home";
  } else if (containsAny(text, ["电池", "usb", "led", "充电", "电动", "暖手宝", "吸尘器"])) {
    profile = "electronics-light";
  } else if (containsAny(text, ["磁", "磁吸"])) {
    profile = "magnetic-accessories";
  } else if (containsAny(text, ["宠物"])) {
    profile = "pet-accessories";
  } else if (containsAny(text, ["车", "汽车", "座椅"])) {
    profile = "automotive-accessories";
  } else if (containsAny(text, ["收纳", "分隔", "盒", "袋", "理线"])) {
    profile = "storage-home";
  } else if (containsAny(text, ["刷", "漏斗", "小工具"])) {
    profile = "household-tools";
  }

  return {
    profile,
    risk_tags: [...new Set(riskTags)],
  };
}

function getProfileConfig(profile) {
  const sharedUniversal = [
    "请确认是工厂、档口还是贸易商。",
    "请给出当前现货/排产状态、MOQ、样品价、大货价。",
    "请给出净重、毛重、包装尺寸、装箱数。",
    "请确认是否支持中性包装、贴标、定制包装。",
    "请说明常见售后/瑕疵问题和返修率。",
  ];

  const configs = {
    apparel: {
      category_label: "服饰",
      primary_platforms: ["1688", "Alibaba"],
      keywords: ["服装", "面料", "尺码", "现货", "工厂"],
      round1: [
        "请发尺码表、面料成分、克重和版型说明。",
        "请确认是否存在缩水、起球、掉色、色差问题。",
        "请确认是否支持欧码/俄码包装与吊牌洗标定制。",
      ],
      round2: [
        "请发近距离面料细节图和上身图。",
        "请说明每个颜色/尺码的库存深度。",
        "请说明退货高发原因和处理方式。",
      ],
      ranking_focus: ["尺码稳定性", "面料一致性", "补货能力", "退货控制"],
    },
    "food-contact-home": {
      category_label: "食品接触家居",
      primary_platforms: ["1688", "Alibaba"],
      keywords: ["食品级", "硅胶", "厨房", "出口", "检测"],
      round1: [
        "请确认材质是否食品接触级，是否有对应检测报告。",
        "请说明耐温范围、是否有异味、是否易染色。",
        "请确认是否已有出口俄罗斯或欧盟经验。",
      ],
      round2: [
        "请发检测报告、材质证明或食品接触相关文件。",
        "请说明长期使用后的开裂、变形、异味投诉情况。",
      ],
      ranking_focus: ["食品级证明", "出口经验", "异味控制", "材料稳定性"],
    },
    "electronics-light": {
      category_label: "轻电子",
      primary_platforms: ["1688", "Alibaba"],
      keywords: ["低压", "USB", "认证", "UN38.3", "工厂"],
      round1: [
        "请确认电池类型、容量、电压、充电协议。",
        "请确认是否提供 UN38.3、MSDS、CE/EAC 等资料。",
        "请说明返修率、坏件率和售后处理方式。",
      ],
      round2: [
        "请发完整规格书和安规/测试文件。",
        "请确认是否可去电池出货，或是否存在无电池版本。",
      ],
      ranking_focus: ["合规文件完整度", "售后稳定性", "低故障率", "交付一致性"],
    },
    "magnetic-accessories": {
      category_label: "磁吸配件",
      primary_platforms: ["1688", "Alibaba"],
      keywords: ["磁吸", "支架", "车载", "出口", "无强磁"],
      round1: [
        "请确认磁材类型、磁力强度、是否属于强磁。",
        "请说明是否有清关或海运限制经验。",
        "请确认夹具、胶件、金属件的耐久性。",
      ],
      round2: [
        "请发磁性参数、结构图和包装参数。",
        "请说明不同车型或场景的兼容性边界。",
      ],
      ranking_focus: ["清关友好度", "结构耐久性", "磁性风险", "兼容性"],
    },
    "pet-accessories": {
      category_label: "宠物用品",
      primary_platforms: ["1688", "Alibaba"],
      keywords: ["宠物", "安全材质", "现货", "出口"],
      round1: [
        "请确认材质安全性，是否可接触宠物口鼻或皮肤。",
        "请说明边缘是否圆润、是否存在易脱落小件。",
        "请说明常见差评点和破损点。",
      ],
      round2: [
        "请发材质证明、耐咬/耐摔说明和细节图。",
        "请确认是否支持宠物品类定制包装。",
      ],
      ranking_focus: ["材质安全", "破损率", "结构细节", "可视化展示效果"],
    },
    "automotive-accessories": {
      category_label: "车品",
      primary_platforms: ["1688", "Alibaba"],
      keywords: ["车载", "适配", "耐温", "现货"],
      round1: [
        "请确认适配车型/通用性边界。",
        "请说明高温、低温、颠簸环境下的稳定性。",
        "请确认是否含液体、胶水、磁吸或敏感部件。",
      ],
      round2: [
        "请发安装方式说明、细节图和包装信息。",
        "请说明差评高发原因，例如异味、松动、掉落。",
      ],
      ranking_focus: ["适配广度", "耐温耐用", "安装稳定性", "差评控制"],
    },
    "storage-home": {
      category_label: "收纳家居",
      primary_platforms: ["Yiwugo", "1688"],
      keywords: ["收纳", "家居", "现货", "工厂"],
      round1: [
        "请确认材质、厚度、承重或耐用性指标。",
        "请说明折叠后尺寸、展开尺寸和尺寸误差范围。",
        "请说明常见破损或变形问题。",
      ],
      round2: [
        "请发装箱方式、收纳演示图和细节图。",
        "请说明是否支持颜色、尺寸、套装组合。",
      ],
      ranking_focus: ["尺寸稳定性", "承重耐用", "现货深度", "包装体积"],
    },
    "household-tools": {
      category_label: "家用小工具",
      primary_platforms: ["Yiwugo", "1688"],
      keywords: ["小工具", "厨房", "现货", "工厂"],
      round1: [
        "请确认材质、结构强度和寿命。",
        "请说明是否有锋利边缘、易断点或脆弱连接处。",
        "请给出装箱参数和颜色/款式选择。",
      ],
      round2: [
        "请发产品细节图和使用场景图。",
        "请说明是否能做套装或多件组合售卖。",
      ],
      ranking_focus: ["结构可靠性", "标准化程度", "图文展示效果", "履约友好度"],
    },
    "general-merchandise": {
      category_label: "通用轻小件",
      primary_platforms: ["Yiwugo", "1688"],
      keywords: ["现货", "工厂", "出口"],
      round1: [
        "请确认材质、规格、重量和包装。",
        "请确认是否有现货和大货交期。",
        "请说明是否支持贴牌和定制包装。",
      ],
      round2: [
        "请发细节图、装箱参数和历史售后问题。",
      ],
      ranking_focus: ["价格竞争力", "现货能力", "包装体积", "售后稳定性"],
    },
  };

  return configs[profile] || configs["general-merchandise"];
}

function getUniversalRiskQuestions(riskTags) {
  const questions = [];
  if (riskTags.includes("battery")) {
    questions.push("请确认是否含电池、是否能提供 UN38.3/MSDS/电池规格。");
  }
  if (riskTags.includes("liquid")) {
    questions.push("请确认是否属于液体/湿巾/化学品，是否存在跨境禁运限制。");
  }
  if (riskTags.includes("magnet")) {
    questions.push("请确认磁性强度和是否可能触发强磁运输限制。");
  }
  if (riskTags.includes("food-contact")) {
    questions.push("请确认是否属于食品接触材料，能否提供检测或合规文件。");
  }
  if (riskTags.includes("size-variant")) {
    questions.push("请确认是否存在复杂尺码或多变体管理问题。");
  }
  return questions;
}


export function buildSupplierSearchPlan(productRecord) {
  const product = productRecord.product;
  const profileInfo = detectProductProfile(product);
  const config = getProfileConfig(profileInfo.profile);
  const keywordBase = toKeywordBase(product.name || product.category || "product");
  const platformMetadata = getPlatformMetadata(config.primary_platforms);
  const keywordVariants = [...new Set([
    keywordBase,
    `${keywordBase} 工厂`,
    `${keywordBase} 现货`,
    ...config.keywords.map((item) => `${keywordBase} ${item}`),
  ])].filter(Boolean);

  return {
    slug: productRecord.slug,
    product_name: product.name,
    profile: profileInfo.profile,
    category_label: config.category_label,
    risk_tags: profileInfo.risk_tags,
    channel_strategy: {
      primary: config.primary_platforms[0] || "1688",
      secondary: config.primary_platforms[1] || "",
      discovery_order: config.primary_platforms,
      follow_up: "wechat-or-enterprise-chat",
      preferred_contact_channels: [...new Set(
        platformMetadata.flatMap((item) => item.contact_channels).concat(["wechat", "enterprise-wechat"]),
      )],
      rationale: [
        "Yiwugo is for Yiwu market-style spot stock, small commodities, and home storage suppliers.",
        "1688 用于找现货、源头厂、白牌供应链。",
        "Alibaba 用于核对出口经验、英文资料、认证文件。",
        "微信或站外沟通用于深聊样品、包装、证书和打样。",
      ],
      platform_notes: platformMetadata,
    },
    supplier_discovery: {
      first_pass_target: 8,
      shortlist_target: 3,
      keywords_cn: keywordVariants,
      preferred_store_signals: [
        "源头工厂或深度工贸一体",
        "支持贴牌/中性包装",
        "对出口、认证或跨境参数回复完整",
        "近 90 天有稳定成交和回复速度",
      ],
      reject_signals: [
        "参数不全，只给低价不报重量尺寸",
        "无法说明材质或认证",
        "售后问题避而不答",
        "明显低价但交期、包装和瑕疵率模糊",
      ],
      required_contact_fields: [
        "contact_person",
        "site_chat_url_or_store_url",
        "phone",
        "wechat",
        "market_location_or_factory_city",
      ],
    },
    ranking_rubric: [
      { factor: "product_match", weight: 30, rule: "标题、图片、参数与目标 SKU 的匹配度" },
      { factor: "factory_capability", weight: 20, rule: "是否源头厂、是否可持续供货、是否支持 OEM/包装" },
      { factor: "compliance_readiness", weight: 20, rule: "是否能提供合规/材质/认证信息" },
      { factor: "fulfillment_stability", weight: 15, rule: "交期、装箱参数、缺陷率、售后稳定性" },
      { factor: "communication_quality", weight: 15, rule: "回复速度、信息完整性、是否愿意配合提供细节" },
    ],
    execution_rule: {
      first_round_contact_count: 3,
      escalation_rule: "只对排序前三的店发首轮消息，回复差再补问下一家。",
      publish_blockers: profileInfo.risk_tags,
    },
  };
}

export function buildSupplierInquiryPlan(productRecord) {

  const product = productRecord.product;
  const profileInfo = detectProductProfile(product);
  const config = getProfileConfig(profileInfo.profile);

  const universalQuestions = [
    "你们是工厂还是贸易商？请发工厂或档口基本信息。",
    "这个款现在是否有现货？MOQ、样品价、大货价分别是多少？",
    "请发产品净重、毛重、包装尺寸、装箱数。",
    "请发材质、颜色、规格、可选变体信息。",
    "是否支持中性包装、贴标、LOGO 或小改款？",
    "近 3 个月这个款常见售后或差评原因是什么？",
  ];

  return {
    profile: profileInfo.profile,
    risk_tags: profileInfo.risk_tags,
    round_1: [
      ...universalQuestions,
      ...config.round1,
      ...getUniversalRiskQuestions(profileInfo.risk_tags),
    ],
    round_2: [
      ...sharedRound2Questions(product),
      ...config.round2,
    ],
    ranking_focus: config.ranking_focus,
  };
}

function sharedRound2Questions(product) {
  const questions = [
    "请发细节图、包装图、箱规图。",
    "请说明打样周期和大货交期。",
  ];

  if (Number(product.target_price_rub || 0) > 0) {
    questions.push(`如果要做跨境零售价 ${product.target_price_rub} RUB 左右，你们建议的出厂配置是什么？`);
  }

  return questions;
}

export function buildSupplierInquiry(productRecord) {
  const searchPlan = buildSupplierSearchPlan(productRecord);
  const inquiryPlan = buildSupplierInquiryPlan(productRecord);
  const product = productRecord.product;

  const lines = [
    `# Supplier research: ${product.name}`,
    "",
    "## Product snapshot",
    "",
    `- Category: ${product.category || "unknown"}`,
    `- Target price (RUB): ${product.target_price_rub || "unknown"}`,
    `- Supply price (CNY): ${product.supply_price_cny || "unknown"}`,
    `- Weight (kg): ${product.est_weight_kg || "unknown"}`,
    `- Long edge (cm): ${product.package_long_edge_cm || "unknown"}`,
    `- Product profile: ${searchPlan.profile}`,
    `- Risk tags: ${searchPlan.risk_tags.join(", ") || "none"}`,
    "",
    "## Supplier selection process",
    "",
    `- Primary platform: ${searchPlan.channel_strategy.primary}`,
    `- Secondary platform: ${searchPlan.channel_strategy.secondary || "none"}`,
    `- Discovery order: ${(searchPlan.channel_strategy.discovery_order || []).join(" -> ") || "none"}`,
    `- Preferred contact channels: ${(searchPlan.channel_strategy.preferred_contact_channels || []).join(", ") || "none"}`,
    `- First pass target: ${searchPlan.supplier_discovery.first_pass_target} stores`,
    `- First round outreach: top ${searchPlan.execution_rule.first_round_contact_count} stores`,
    "",
    "### Platform notes",
    "",
    ...((searchPlan.channel_strategy.platform_notes || []).flatMap((item) => [
      `- ${item.platform}: ${item.positioning}`,
      ...item.supplier_signals.map((signal) => `- ${item.platform} signal: ${signal}`),
    ])),
    "",
    "### Search keywords",
    "",
    ...searchPlan.supplier_discovery.keywords_cn.map((item) => `- ${item}`),
    "",
    "### Ranking focus",
    "",
    ...searchPlan.ranking_rubric.map((item) => `- ${item.factor}: ${item.weight} (${item.rule})`),
    "",
    "## Round 1 questions",
    "",
    ...inquiryPlan.round_1.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Round 2 questions",
    "",
    ...inquiryPlan.round_2.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Save response",
    "",
    "Save the structured response into supplier-response.json for this product.",
    "",
  ];

  return lines.join("\n");
}

export function buildSupplierShortlistTemplate(productRecord) {
  const searchPlan = buildSupplierSearchPlan(productRecord);
  return {
    slug: productRecord.slug,
    product_name: productRecord.product.name,
    profile: searchPlan.profile,
    stores: [
      {
        platform: searchPlan.channel_strategy.primary,
        store_name: "",
        store_url: "",
        item_url: "",
        contact_person: "",
        phone: "",
        wechat: "",
        enterprise_wechat: "",
        market_block: "",
        booth_no: "",
        quoted_unit_price_cny: 0,
        moq: 0,
        reply_speed_score: 0,
        product_match_score: 0,
        factory_capability_score: 0,
        compliance_readiness_score: 0,
        fulfillment_stability_score: 0,
        communication_quality_score: 0,
        overall_score: 0,
        strengths: [],
        risks: [],
        first_round_status: "pending",
      }
    ],
  };
}

export function buildSupplierResponseTemplate(productRecord) {
  const searchPlan = buildSupplierSearchPlan(productRecord);

  return {
    slug: productRecord.slug,
    product_name: productRecord.product.name,
    product_profile: searchPlan.profile,
    supplier_platform: searchPlan.channel_strategy.primary,
    supplier_name: "",
    supplier_type: "",
    contact_person: "",
    store_url: "",
    source_url: "",
    phone: "",
    wechat: "",
    enterprise_wechat: "",
    market_location: "",
    export_experience: "",
    moq: 0,
    unit_price_cny: 0,
    sample_price_cny: 0,
    materials: [],
    variants: [],
    net_weight_kg: 0,
    packed_weight_kg: 0,
    packed_dimensions_cm: {
      length: 0,
      width: 0,
      height: 0,
    },
    packing_quantity_per_carton: 0,
    contains_battery: false,
    contains_liquid: false,
    contains_magnet: false,
    contains_blade: false,
    food_contact: false,
    certifications: [],
    custom_logo_supported: false,
    sample_lead_time_days: 0,
    bulk_lead_time_days: 0,
    defect_notes: [],
    seller_notes: [],
    shop_assessment: {
      reply_speed_score: 0,
      product_match_score: 0,
      factory_capability_score: 0,
      compliance_readiness_score: 0,
      fulfillment_stability_score: 0,
      communication_quality_score: 0,
      overall_score: 0,
    },
  };
}

export function shouldRequireSupplierResponse(productRecord) {
  const product = productRecord?.product || {};
  const profileInfo = detectProductProfile(product);
  const lowComplexityProfiles = new Set(["general-merchandise", "storage-home", "household-tools"]);

  if (profileInfo.risk_tags.length > 0) {
    return true;
  }

  if (lowComplexityProfiles.has(profileInfo.profile)) {
    return false;
  }

  const lowRiskSignals = [
    String(product.fragility || "").toLowerCase() === "low",
    String(product.certification_risk || "").toLowerCase() !== "high",
    String(product.return_risk || "").toLowerCase() !== "high",
    Number(product.est_weight_kg || 0) <= 1.2,
    Number(product.package_long_edge_cm || 0) <= 45,
  ];

  return !lowRiskSignals.every(Boolean);
}

export function buildAutonomousProductSummary(productRecord) {
  const product = productRecord?.product || {};
  const searchPlan = buildSupplierSearchPlan(productRecord);
  const lines = [
    `# Autonomous product summary: ${product.name || productRecord.slug}`,
    "",
    "## Judgment",
    "",
    `- Supplier response required: ${shouldRequireSupplierResponse(productRecord) ? "yes" : "no"}`,
    `- Product profile: ${searchPlan.profile}`,
    `- Risk tags: ${searchPlan.risk_tags.join(", ") || "none"}`,
    "",
    "## Product snapshot",
    "",
    `- Category: ${product.category || "unknown"}`,
    `- Target price (RUB): ${product.target_price_rub || "unknown"}`,
    `- Supply price (CNY): ${product.supply_price_cny || "unknown"}`,
    `- Weight (kg): ${product.est_weight_kg || "unknown"}`,
    `- Long edge (cm): ${product.package_long_edge_cm || "unknown"}`,
    `- Why it can sell: ${product.why_it_can_sell || "n/a"}`,
    `- Content potential: ${product.content_potential || "unknown"}`,
    "",
    "## Suggested listing copy",
    "",
    `- Title idea: ${product.name || "Unknown product"}`,
    `- Bullet 1: Focus on the buyer pain point and practical use case.`,
    `- Bullet 2: Mention low-risk logistics and simple handling.`,
    `- Bullet 3: Use the product snapshot above as the source of truth.`,
    "",
    "## Notes",
    "",
    "- This summary was generated without waiting for a supplier reply because the item was judged to be low-complexity.",
    "- Re-run supplier research if later checks reveal model-specific, compliance, or variant risks.",
    "",
  ];

  return lines.join("\n");
}

export function buildListingBrief(productRecord) {
  const responses = Array.isArray(productRecord.research?.supplier_responses)
    ? productRecord.research.supplier_responses
    : [];
  const humanResponseEntry = responses.slice().reverse().find((entry) => !entry?.data?.auto_generated_from_chat);
  const response = humanResponseEntry?.data || {};
  const hasHumanResponse = Boolean(humanResponseEntry);
  const product = productRecord.product;
  const searchPlan = buildSupplierSearchPlan(productRecord);
  const lines = [
    `# Listing brief: ${product.name}`,
    "",
    "## Commercial baseline",
    "",
    `- Category: ${product.category || "unknown"}`,
    `- Product profile: ${searchPlan.profile}`,
    `- Target price (RUB): ${product.target_price_rub || "unknown"}`,
    `- Factory unit price (CNY): ${response.unit_price_cny || product.supply_price_cny || "unknown"}`,
    `- Net/Packed weight (kg): ${response.net_weight_kg || "unknown"} / ${response.packed_weight_kg || "unknown"}`,
    `- Packed dimensions: ${response.packed_dimensions_cm ? `${response.packed_dimensions_cm.length || 0}x${response.packed_dimensions_cm.width || 0}x${response.packed_dimensions_cm.height || 0} cm` : "unknown"}`,
    "",
    "## Selling angle",
    "",
    `- Why it can sell: ${product.why_it_can_sell || "n/a"}`,
    `- Content potential: ${product.content_potential || "unknown"}`,
    "",
    "## Risk checks",
    "",
    `- Risk tags: ${searchPlan.risk_tags.join(", ") || "none"}`,
    `- Certifications: ${Array.isArray(response.certifications) ? response.certifications.join(", ") || "none provided" : "none provided"}`,
    `- Battery: ${response.contains_battery ? "yes" : "no"}`,
    `- Liquid: ${response.contains_liquid ? "yes" : "no"}`,
    `- Magnet: ${response.contains_magnet ? "yes" : "no"}`,
    `- Food contact: ${response.food_contact ? "yes" : "no"}`,
    `- Notes: ${Array.isArray(response.seller_notes) ? response.seller_notes.join(" | ") || "none" : "none"}`,
    "",
    "## Source basis",
    "",
    `- Human supplier response: ${hasHumanResponse ? "yes" : "no"}`,
    `- Autonomous approval: ${productRecord.research?.autonomous_approval ? "yes" : "no"}`,
    `- Autonomous summary path: ${productRecord.research?.autonomous_summary_path || "none"}`,
    "",
    "## Supplier selection basis",
    "",
    ...searchPlan.ranking_rubric.map((item) => `- ${item.factor}: ${item.rule}`),
    "",
    "## Required next actions",
    "",
    "- Draft title and bullet points",
    "- Prepare first image prompt pack",
    "- Confirm compliance before publish",
    "- Save as merchant backend draft first",
    "",
  ];

  return lines.join("\n");
}

export async function refreshWorkflowArtifacts(paths) {
  const productEntries = await listProductRecords(paths.productsDir);
  const records = productEntries.map(({ record }) => record);
  const safeName = (record) => record?.product?.name || record?.slug || "";
  const safeStage = (record) => record?.workflow?.current_stage || "";
  const safeReviewStatus = (record) => record?.review?.status || "";
  const safeProfile = (record) => record?.research?.product_profile || "";
  const safeOutreachStatus = (record) => record?.research?.outreach?.status || "";
  const safePaths = (record) => record?.paths || {};
  const safeResearch = (record) => record?.research || {};
  const safeListing = (record) => record?.listing || {};

  const researchQueue = records
    .filter((record) => safeStage(record) === "supplier_research_pending")
    .map((record) => ({
      slug: record.slug,
      name: safeName(record),
      profile: safeProfile(record),
      stage: safeStage(record),
      inquiryPath: safeResearch(record).supplier_inquiry_path,
      responseTemplatePath: safeResearch(record).supplier_response_template_path,
      searchPlanPath: safeResearch(record).supplier_search_plan_path || "",
      shortlistTemplatePath: safeResearch(record).supplier_shortlist_template_path || "",
      knowledgePath: safePaths(record).product_json,
    }));

  const followUpQueue = records
    .filter((record) => safeStage(record) === "supplier_contacted_waiting_reply")
    .flatMap((record) => {
      const research = safeResearch(record);
      const outreach = research.outreach || {};
      const contacts = Array.isArray(outreach.competitor_contacts) ? outreach.competitor_contacts : [];
      const dedupe = new Set();
      const entries = [];
      const pushEntry = (contact, { isPrimary = false, fallbackIndex = 0 } = {}) => {
        const supplierImUrl = String(contact?.supplier_im_url || "").trim();
        const supplierName = String(contact?.supplier_name || "").trim();
        const rawKey = String(contact?.supplier_key || "").trim();
        const normalizedKey =
          rawKey ||
          `${record.slug}::${(supplierName || supplierImUrl || `supplier-${fallbackIndex + 1}`)
            .replace(/[^\w.-]+/g, "_")
            .slice(0, 80)}`;
        const dedupeKey = `${normalizedKey}::${supplierImUrl}`;
        if (dedupe.has(dedupeKey)) return;
        if (!supplierImUrl && !isPrimary) return;
        dedupe.add(dedupeKey);
        entries.push({
          slug: record.slug,
          name: safeName(record),
          stage: safeStage(record),
          supplierKey: normalizedKey,
          supplierName,
          supplierImUrl,
          supplierShopUrl: String(contact?.supplier_shop_url || "").trim(),
          supplierProductTitle: String(contact?.supplier_product_title || "").trim(),
          supplierProductUrl: String(contact?.supplier_product_url || "").trim(),
          searchSummaryPath: String(contact?.search_summary_path || "").trim(),
          candidateIndex: Number(contact?.candidate_index || 0),
          firstMessageSentAt:
            String(contact?.first_message_sent_at || "").trim() ||
            String(outreach.first_message_sent_at || "").trim(),
          lastContactedAt:
            String(contact?.last_contacted_at || "").trim() ||
            String(outreach.last_contacted_at || "").trim(),
          followUpSentCount:
            Number(contact?.follow_up_sent_count || 0) || Number(outreach.follow_up_sent_count || 0),
          nudgeSentCount:
            Number(contact?.nudge_sent_count || 0) || Number(outreach.nudge_sent_count || 0),
          lastChatCapturePath:
            String(contact?.last_chat_capture_path || "").trim() ||
            String(research.last_chat_capture_path || "").trim(),
          knowledgePath: safePaths(record).product_json,
        });
      };

      pushEntry(
        {
          supplier_key: `${record.slug}::primary`,
          supplier_name: outreach.supplier_name || "",
          supplier_im_url: outreach.supplier_im_url || "",
          supplier_shop_url: outreach.supplier_shop_url || "",
          supplier_product_title: outreach.supplier_product_title || "",
          supplier_product_url: outreach.supplier_product_url || "",
          search_summary_path: outreach.search_summary_path || "",
          first_message_sent_at: outreach.first_message_sent_at || "",
          last_contacted_at: outreach.last_contacted_at || "",
          follow_up_sent_count: outreach.follow_up_sent_count || 0,
          nudge_sent_count: outreach.nudge_sent_count || 0,
          last_chat_capture_path: research.last_chat_capture_path || "",
        },
        { isPrimary: true, fallbackIndex: 0 },
      );

      for (let index = 0; index < contacts.length; index += 1) {
        pushEntry(contacts[index], { isPrimary: false, fallbackIndex: index + 1 });
      }

      return entries;
    });

  const reviewQueue = records
    .filter((record) => safeStage(record) === "human_review_pending")
    .map((record) => ({
      slug: record.slug,
      name: safeName(record),
      stage: safeStage(record),
      latestSupplierResponsePath: safeResearch(record).latest_supplier_response_path || "",
      knowledgePath: safePaths(record).product_json,
    }));

  const listingQueue = records
    .filter((record) => safeStage(record) === "approved_for_listing")
    .map((record) => ({
      slug: record.slug,
      name: safeName(record),
      stage: safeStage(record),
      listingStatus: safeListing(record).status || "",
      titleJsonPath: safeListing(record).title_json_path || "",
      bulletsJsonPath: safeListing(record).bullets_json_path || "",
      attributesJsonPath: safeListing(record).attributes_json_path || "",
      mainImageCopyJsonPath: safeListing(record).main_image_copy_json_path || "",
      assetsMdPath: safeListing(record).assets_md_path || "",
      listingBriefPath: safeListing(record).listing_brief_path || "",
      draftJsonPath: safeListing(record).draft_json_path || "",
      draftMdPath: safeListing(record).draft_md_path || "",
      packageId: safeListing(record).package_id || "",
      selectedTitle: safeListing(record).selected_title || "",
      knowledgePath: safePaths(record).product_json,
    }));

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      total: records.length,
      supplier_research_pending: researchQueue.length,
      supplier_contacted_waiting_reply: followUpQueue.length,
      human_review_pending: reviewQueue.length,
      approved_for_listing: listingQueue.length,
      rejected: records.filter((record) => safeStage(record) === "rejected").length,
    },
      products: records.map((record) => ({
        slug: record.slug,
        name: safeName(record),
        profile: safeProfile(record),
        stage: safeStage(record),
        reviewStatus: safeReviewStatus(record),
        outreachStatus: safeOutreachStatus(record),
        listingStatus: safeListing(record).status || "",
        titleJsonPath: safeListing(record).title_json_path || "",
        bulletsJsonPath: safeListing(record).bullets_json_path || "",
        attributesJsonPath: safeListing(record).attributes_json_path || "",
        mainImageCopyJsonPath: safeListing(record).main_image_copy_json_path || "",
        sourceDecision: record?.product?.source_decision || record?.product?.final_decision || "",
        finalDecision: record?.product?.final_decision || "",
      })),
  };

  await writeJson(paths.indexPath, summary);
  await writeJson(paths.researchQueuePath, researchQueue);
  await writeJson(paths.followUpQueuePath, followUpQueue);
  await writeJson(paths.reviewQueuePath, reviewQueue);
  await writeJson(paths.listingQueuePath, listingQueue);

  const liveStatus = await buildLiveStatus(paths, records, {
    researchQueue,
    followUpQueue,
    reviewQueue,
    listingQueue,
  });
  await writeJson(paths.liveStatusJsonPath, liveStatus.json);
  await writeText(paths.liveStatusMdPath, liveStatus.markdown);
}
