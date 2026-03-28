import fs from "node:fs/promises";
import { timestamp, ensureDir } from "./shared-utils.js";
import path from "node:path";
import { chromium } from "playwright";
import { extractHostname, gotoWithProxyFallback } from "./browser-network.js";

const DEFAULT_URL = "https://www.alphashop.cn/select-product/general-agent";
const LOGIN_URL = "https://www.alphashop.cn/login";
const DIRECT_SIGNIN_URL =
  "https://www.alphashop.cn/signIn?target=https%3A%2F%2Fwww.alphashop.cn&fullRedirect=true";

const DEFAULT_PLATFORM = "ozon";

const PLATFORM_DEFAULTS = {
  ozon: {
    marketplace: "Ozon Russia",
    priceMinRub: 1000,
    priceMaxRub: 4000,
    maxWeightKg: 1.2,
    maxLongEdgeCm: 45,
    maxFragilityLevel: "medium",
    logisticsWeight: 20,
    marginWeight: 25,
    competitionWeight: 15,
    complianceWeight: 15,
    returnWeight: 15,
    contentWeight: 10,
    exchangeRateRubPerCny: 12.5,
  },
};

const PLATFORM_UI_DEFAULTS = {
  ozon: {
    marketplaceOptions: ["Ozon", "OZON"],
    countryOptions: ["俄罗斯", "Russia"],
  },
};

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    platform: DEFAULT_PLATFORM,
    prompt: "",
    productGoal: "筛选适合 Ozon 俄罗斯站的轻小件、高复购潜力、低售后、可跨境履约的商品",
    outputDir: path.resolve("output"),
    profileDir: path.resolve(".profiles", "alphashop"),
    browserProfileDir: path.resolve(".profiles", "alphashop", "browser-user-data"),
    timeoutMs: 240000,
    loginTimeoutMs: 300000,
    keepOpen: false,
    priceMinRub: undefined,
    priceMaxRub: undefined,
    maxWeightKg: undefined,
    maxLongEdgeCm: undefined,
    category: "",
    targetUsers: "",
    headless: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--url" && next) {
      args.url = next;
      i += 1;
    } else if (current === "--platform" && next) {
      args.platform = next.toLowerCase();
      i += 1;
    } else if (current === "--prompt" && next) {
      args.prompt = next;
      i += 1;
    } else if (current === "--product-goal" && next) {
      args.productGoal = next;
      i += 1;
    } else if (current === "--category" && next) {
      args.category = next;
      i += 1;
    } else if (current === "--target-users" && next) {
      args.targetUsers = next;
      i += 1;
    } else if (current === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (current === "--profile-dir" && next) {
      args.profileDir = path.resolve(next);
      i += 1;
    } else if (current === "--browser-profile-dir" && next) {
      args.browserProfileDir = path.resolve(next);
      i += 1;
    } else if (current === "--timeout-ms" && next) {
      args.timeoutMs = Number(next);
      i += 1;
    } else if (current === "--login-timeout-ms" && next) {
      args.loginTimeoutMs = Number(next);
      i += 1;
    } else if (current === "--price-min-rub" && next) {
      args.priceMinRub = Number(next);
      i += 1;
    } else if (current === "--price-max-rub" && next) {
      args.priceMaxRub = Number(next);
      i += 1;
    } else if (current === "--max-weight-kg" && next) {
      args.maxWeightKg = Number(next);
      i += 1;
    } else if (current === "--max-long-edge-cm" && next) {
      args.maxLongEdgeCm = Number(next);
      i += 1;
    } else if (current === "--headless") {
      args.headless = true;
    } else if (current === "--keep-open") {
      args.keepOpen = true;
    }
  }

  return args;
}

function getResolvedTargetUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const isGeneralAgentPage =
      parsed.origin === "https://www.alphashop.cn" &&
      parsed.pathname === "/select-product/general-agent";

    if (!isGeneralAgentPage) {
      return rawUrl;
    }

    parsed.searchParams.delete("__auto_submit__");
    parsed.searchParams.delete("__chat_history_session__");
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function getRules(args) {
  const base = PLATFORM_DEFAULTS[args.platform] || PLATFORM_DEFAULTS[DEFAULT_PLATFORM];
  return {
    ...base,
    priceMinRub: args.priceMinRub ?? base.priceMinRub,
    priceMaxRub: args.priceMaxRub ?? base.priceMaxRub,
    maxWeightKg: args.maxWeightKg ?? base.maxWeightKg,
    maxLongEdgeCm: args.maxLongEdgeCm ?? base.maxLongEdgeCm,
    category: args.category,
    targetUsers: args.targetUsers,
    productGoal: args.productGoal,
  };
}

function buildPrompt(args, rules) {
  if (args.prompt) return args.prompt;

  const categoryLine = rules.category ? `重点类目：${rules.category}` : "重点类目：家居、车品、收纳、宠物、小工具、季节型轻小件";
  const targetUsersLine = rules.targetUsers
    ? `目标人群：${rules.targetUsers}`
    : "目标人群：俄罗斯本地家庭用户、车主、宠物主人、礼品消费人群";

  return [
    `你是${rules.marketplace}的跨境选品运营，请严格按 Ozon 的经营逻辑进行筛选。`,
    `任务目标：${rules.productGoal}。`,
    categoryLine,
    targetUsersLine,
    `硬性约束：售价区间 ${rules.priceMinRub}-${rules.priceMaxRub} RUB，单件重量 <= ${rules.maxWeightKg} kg，最长边 <= ${rules.maxLongEdgeCm} cm，低售后，低破损，低认证风险。`,
    "运营判断优先级：价格带适配 > 履约与物流友好 > 毛利空间 > 竞争度 > 退货风险 > 内容传播性。",
    "请优先选择：轻小件、标准化、非强品牌依赖、图片容易表达、俄语卖点容易本地化、适合平台推荐分发的商品。",
    "请谨慎或剔除：易碎大件、复杂电子类、强认证/清关风险、尺码复杂、高退货、高售后产品。",
    "输出 8-12 个候选商品，并给出 Go/No-Go 判断。",
    "必须只输出 JSON，不要 Markdown，不要解释，不要多余文字。",
    'JSON 结构如下：{"selection_brief":{"platform":"Ozon","price_band_rub":"1000-4000","core_strategy":["..."],"warnings":["..."]},"products":[{"name":"","category":"","target_price_rub":0,"supply_price_cny":0,"est_weight_kg":0,"package_long_edge_cm":0,"fragility":"low|medium|high","certification_risk":"low|medium|high","return_risk":"low|medium|high","competition_level":"low|medium|high","content_potential":"low|medium|high","seasonality":"stable|seasonal","why_it_can_sell":"","risk_notes":["..."],"go_or_no_go":"Go|Watch|No-Go"}],"recommended_actions":["..."]}',
  ].join("\n");
}





async function submitPrompt(page, prompt) {
  if (!prompt) return false;

  const composer = page.locator('div[class*="textInput--"]').last();
  const sendButton = page.locator('button[class*="sendButton--"]').first();

  if ((await composer.count()) === 0 || (await sendButton.count()) === 0) {
    return false;
  }

  await composer.waitFor({ state: "visible", timeout: 15000 });
  await composer.click();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});

  await composer
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) return;

      if (element.isContentEditable) {
        element.textContent = "";
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "" }));
        return;
      }

      if ("value" in element) {
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })
    .catch(() => {});

  await page.keyboard.insertText(prompt);

  await page.waitForFunction(
    () => {
      const button = document.querySelector('button[class*="sendButton--"]');
      return Boolean(button && !button.disabled && button.getAttribute("aria-disabled") !== "true");
    },
    undefined,
    { timeout: 15000 },
  );

  await sendButton.click();
  return true;
}

async function collectResultCandidates(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const selectors = [
      "pre",
      "code",
      '[class*="message"]',
      '[class*="answer"]',
      '[class*="result"]',
      '[class*="content"]',
      '[class*="bubble"]',
      '[class*="markdown"]',
      '[class*="card"]',
    ];

    const seen = new Set();
    const texts = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!isVisible(element)) continue;
        const text = normalize(element.innerText || element.textContent || "");
        if (!text || text.length < 20 || seen.has(text)) continue;
        seen.add(text);
        texts.push(text);
      }
    }

    const bodyText = normalize(document.body?.innerText || "");
    if (bodyText && !seen.has(bodyText)) {
      texts.push(bodyText);
    }

    return texts;
  });
}

function normalizeVisibleText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

async function waitForReplay(page, timeoutMs, prompt = "") {
  const start = Date.now();
  let previousText = "";
  let stableRounds = 0;
  const normalizedPrompt = normalizeVisibleText(prompt);
  let lastSnapshot = {
    text: "",
    loadingVisible: false,
    stableRounds: 0,
    elapsedMs: 0,
    promptStillDominates: false,
  };
  let nextHeartbeatAt = start + 15000;

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2500);

    const pageState = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const visibleLoadingSelectors = [
        '[class*="loading"]',
        '[class*="Loading"]',
        '[class*="spinner"]',
        '[class*="Spinner"]',
        '[class*="spin"]',
        '[class*="Spin"]',
        ".ant-spin",
        '[aria-busy="true"]',
      ];

      const loadingVisible = visibleLoadingSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some(isVisible),
      );

      return {
        text: document.body?.innerText || "",
        loadingVisible,
      };
    });
    const normalized = normalizeVisibleText(pageState.text);
    const elapsedMs = Date.now() - start;
    const promptStillDominates =
      normalizedPrompt &&
      normalized.includes(normalizedPrompt) &&
      normalized.length <= normalizedPrompt.length + 120;

    if (normalized && normalized === previousText) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      previousText = normalized;
    }

    lastSnapshot = {
      text: normalized,
      loadingVisible: pageState.loadingVisible,
      stableRounds,
      elapsedMs,
      promptStillDominates: Boolean(promptStillDominates),
    };

    if (Date.now() >= nextHeartbeatAt) {
      console.log(
        `[selection-wait] elapsed=${Math.round(elapsedMs / 1000)}s loading=${pageState.loadingVisible} stable=${stableRounds} promptOnly=${Boolean(promptStillDominates)} textLen=${normalized.length}`,
      );
      nextHeartbeatAt = Date.now() + 15000;
    }

    if (
      normalized &&
      stableRounds >= 3 &&
      !pageState.loadingVisible &&
      !promptStillDominates
    ) {
      return {
        text: normalized,
        timedOut: false,
        snapshot: lastSnapshot,
      };
    }
  }

  return {
    text: previousText,
    timedOut: true,
    snapshot: lastSnapshot,
  };
}

function normalizeJsonCandidate(text) {
  return text
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function findBalancedJson(text) {
  const normalized = normalizeJsonCandidate(text);
  const startIndexes = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "{") startIndexes.push(i);
  }

  for (const start of startIndexes) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < normalized.length; i += 1) {
      const char = normalized[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = normalized.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // keep scanning
          }
        }
      }
    }
  }

  return null;
}

function parseLevel(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("high") || normalized.includes("高")) return "high";
  if (normalized.includes("medium") || normalized.includes("mid") || normalized.includes("中")) return "medium";
  if (normalized.includes("low") || normalized.includes("低")) return "low";
  if (normalized.includes("stable") || normalized.includes("稳")) return "stable";
  if (normalized.includes("season")) return "seasonal";
  return "";
}

function parseDecision(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "go") return "Go";
  if (normalized === "watch") return "Watch";
  if (normalized === "no-go" || normalized === "nogo" || normalized === "no go") {
    return "No-Go";
  }
  return "";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scorePrice(product, rules) {
  const price = Number(product.target_price_rub || 0);
  if (!price) return 45;
  if (price >= rules.priceMinRub && price <= rules.priceMaxRub) return 100;

  const distance =
    price < rules.priceMinRub
      ? (rules.priceMinRub - price) / Math.max(rules.priceMinRub, 1)
      : (price - rules.priceMaxRub) / Math.max(rules.priceMaxRub, 1);

  return clamp(Math.round(100 - distance * 140), 15, 95);
}

function scoreMargin(product, rules) {
  const targetPrice = Number(product.target_price_rub || 0);
  const supplyPriceCny = Number(product.supply_price_cny || 0);
  if (!targetPrice || !supplyPriceCny) return 55;

  const convertedSupplyRub = supplyPriceCny * rules.exchangeRateRubPerCny;
  const roughMarginRate = (targetPrice - convertedSupplyRub) / targetPrice;

  if (roughMarginRate >= 0.65) return 95;
  if (roughMarginRate >= 0.5) return 85;
  if (roughMarginRate >= 0.35) return 70;
  if (roughMarginRate >= 0.2) return 50;
  return 20;
}

function scoreLogistics(product, rules) {
  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  const fragility = parseLevel(product.fragility);
  let score = 100;

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
  return 55;
}

function scoreCompetition(product) {
  const level = parseLevel(product.competition_level);
  if (level === "low") return 92;
  if (level === "medium") return 60;
  if (level === "high") return 22;
  return 55;
}

function scoreContent(product) {
  const level = parseLevel(product.content_potential);
  if (level === "high") return 90;
  if (level === "medium") return 65;
  if (level === "low") return 40;
  return 55;
}

function deriveDecision(totalScore, product) {
  const fragile = parseLevel(product.fragility) === "high";
  const cert = parseLevel(product.certification_risk) === "high";
  const returns = parseLevel(product.return_risk) === "high";

  if (cert || (fragile && returns) || totalScore < 45) return "No-Go";
  if (totalScore >= 72) return "Go";
  return "Watch";
}

function mergeDecision(sourceDecision, localDecision) {
  const normalizedSource = parseDecision(sourceDecision);
  const normalizedLocal = parseDecision(localDecision);

  if (normalizedSource === "No-Go" || normalizedLocal === "No-Go") return "No-Go";
  if (normalizedSource === "Watch" || normalizedLocal === "Watch") return "Watch";
  return normalizedSource || normalizedLocal;
}

function analyzeProducts(parsed, rules) {
  const products = Array.isArray(parsed?.products) ? parsed.products : [];

  return products.map((product) => {
    const scoreBreakdown = {
      price_fit: scorePrice(product, rules),
      margin_potential: scoreMargin(product, rules),
      logistics_friendliness: scoreLogistics(product, rules),
      competition: scoreCompetition(product),
      compliance_risk: scoreRisk(product, "certification_risk"),
      return_risk: scoreRisk(product, "return_risk"),
      content_potential: scoreContent(product),
    };

    const totalScore = Math.round(
      (scoreBreakdown.logistics_friendliness * rules.logisticsWeight +
        scoreBreakdown.margin_potential * rules.marginWeight +
        scoreBreakdown.competition * rules.competitionWeight +
        scoreBreakdown.compliance_risk * rules.complianceWeight +
        scoreBreakdown.return_risk * rules.returnWeight +
        scoreBreakdown.content_potential * rules.contentWeight) /
        (rules.logisticsWeight +
          rules.marginWeight +
          rules.competitionWeight +
          rules.complianceWeight +
          rules.returnWeight +
          rules.contentWeight),
    );

    const localDecision = deriveDecision(totalScore, product);
    const sourceDecision = parseDecision(product.go_or_no_go);
    const decision = mergeDecision(sourceDecision, localDecision);
    const issues = [];

    if (scoreBreakdown.logistics_friendliness < 60) issues.push("物流履约风险偏高");
    if (scoreBreakdown.margin_potential < 60) issues.push("利润空间偏弱");
    if (scoreBreakdown.competition < 45) issues.push("竞争过于拥挤");
    if (scoreBreakdown.compliance_risk < 45) issues.push("认证/清关风险高");
    if (scoreBreakdown.return_risk < 45) issues.push("退货和售后压力大");

    if (sourceDecision && sourceDecision !== localDecision) {
      issues.push(`AlphaShop: ${sourceDecision}`);
    }

    return {
      ...product,
      score_breakdown: scoreBreakdown,
      total_score: totalScore,
      source_decision: sourceDecision || "Unknown",
      local_decision: localDecision,
      final_decision: decision,
      issue_summary: issues,
    };
  });
}

function buildMarkdownReport(args, rules, parsed, analyzedProducts) {
  const goProducts = analyzedProducts.filter((item) => item.final_decision === "Go");
  const watchProducts = analyzedProducts.filter((item) => item.final_decision === "Watch");
  const noGoProducts = analyzedProducts.filter((item) => item.final_decision === "No-Go");

  const lines = [
    "# Ozon 选品自动化报告",
    "",
    "## 任务参数",
    "",
    `- 平台: ${rules.marketplace}`,
    `- 选品目标: ${args.productGoal}`,
    `- 售价带: ${rules.priceMinRub}-${rules.priceMaxRub} RUB`,
    `- 最大重量: ${rules.maxWeightKg} kg`,
    `- 最大长边: ${rules.maxLongEdgeCm} cm`,
    `- 类目偏好: ${rules.category || "未指定"}`,
    `- 目标人群: ${rules.targetUsers || "未指定"}`,
    "",
    "## 运营判断",
    "",
    `- Go 数量: ${goProducts.length}`,
    `- Watch 数量: ${watchProducts.length}`,
    `- No-Go 数量: ${noGoProducts.length}`,
    "",
  ];

  if (parsed?.selection_brief) {
    const brief = parsed.selection_brief;
    lines.push("## AlphaShop 返回摘要", "");
    if (Array.isArray(brief.core_strategy) && brief.core_strategy.length > 0) {
      for (const item of brief.core_strategy) lines.push(`- ${item}`);
    }
    if (Array.isArray(brief.warnings) && brief.warnings.length > 0) {
      lines.push("", "### 风险提醒", "");
      for (const item of brief.warnings) lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push("## 候选商品", "");

  for (const product of analyzedProducts.sort((a, b) => b.total_score - a.total_score)) {
    lines.push(`### ${product.name || "未命名商品"}`);
    lines.push("");
    lines.push(`- 判定: ${product.final_decision}`);
    lines.push(`- 总分: ${product.total_score}`);
    lines.push(`- 类目: ${product.category || "未提供"}`);
    lines.push(`- 目标售价: ${product.target_price_rub || "未提供"} RUB`);
    lines.push(`- 供货价: ${product.supply_price_cny || "未提供"} CNY`);
    lines.push(`- 重量: ${product.est_weight_kg || "未提供"} kg`);
    lines.push(`- 长边: ${product.package_long_edge_cm || "未提供"} cm`);
    lines.push(`- 易碎度: ${product.fragility || "未提供"}`);
    lines.push(`- 认证风险: ${product.certification_risk || "未提供"}`);
    lines.push(`- 退货风险: ${product.return_risk || "未提供"}`);
    lines.push(`- 竞争度: ${product.competition_level || "未提供"}`);
    lines.push(`- 内容潜力: ${product.content_potential || "未提供"}`);
    lines.push(`- 卖点逻辑: ${product.why_it_can_sell || "未提供"}`);
    if (product.issue_summary.length > 0) {
      lines.push(`- 主要问题: ${product.issue_summary.join("；")}`);
    }
    if (Array.isArray(product.risk_notes) && product.risk_notes.length > 0) {
      lines.push(`- 风险备注: ${product.risk_notes.join("；")}`);
    }
    lines.push(
      `- 打分拆解: 价格 ${product.score_breakdown.price_fit} / 利润 ${product.score_breakdown.margin_potential} / 物流 ${product.score_breakdown.logistics_friendliness} / 竞争 ${product.score_breakdown.competition} / 合规 ${product.score_breakdown.compliance_risk} / 退货 ${product.score_breakdown.return_risk} / 内容 ${product.score_breakdown.content_potential}`,
    );
    lines.push("");
  }

  if (Array.isArray(parsed?.recommended_actions) && parsed.recommended_actions.length > 0) {
    lines.push("## 建议动作", "");
    for (const item of parsed.recommended_actions) lines.push(`- ${item}`);
    lines.push("");
  }

  lines.push("## 下一步执行", "");
  lines.push("- 优先把 `Go` 商品做 10-20 个候选上架清单，再做首图、价格和标题 AB 测试。");
  lines.push("- 对 `Watch` 商品重点复核物流体积、认证要求和退款风险。");
  lines.push("- 对 `No-Go` 商品默认不进入首批测试，除非供应链或定价有明显改善。");
  lines.push("");

  return lines.join("\n");
}

function extractStructuredResult(texts) {
  for (const text of texts) {
    if (!text) continue;
    const parsed = findBalancedJson(text);
    if (parsed && Array.isArray(parsed.products) && isValidSelectionResult(parsed)) {
      return parsed;
    }
  }

  return null;
}

function hasAuthFailure(replayText, responses, consoleMessages, settledText = "", candidateTexts = []) {
  const textBundle = [replayText, settledText, ...candidateTexts].filter(Boolean).join("\n");
  if (/FAIL_SYS_SESSION_EXPIRED|User not login in|立即登录|登录后使用|请先登录/i.test(textBundle)) {
    return true;
  }

  if (
    responses.some(
      (response) =>
        response.status === 401 ||
        /FAIL_SYS_SESSION_EXPIRED|User not login in/i.test(response.bodyPreview || ""),
    )
  ) {
    return true;
  }

  return consoleMessages.some((message) =>
    /HTTP 401|User not login in|session expired/i.test(message.text || ""),
  );
}

function isValidSelectionResult(parsed) {
  if (!parsed || !Array.isArray(parsed.products) || parsed.products.length === 0) {
    return false;
  }

  return parsed.products.some((product) => {
    const name = String(product?.name || "").trim();
    const why = String(product?.why_it_can_sell || "").trim();
    const price = Number(product?.target_price_rub || 0);
    const supply = Number(product?.supply_price_cny || 0);
    const enumLikeFields = [
      product?.fragility,
      product?.certification_risk,
      product?.return_risk,
      product?.competition_level,
      product?.content_potential,
      product?.go_or_no_go,
    ]
      .map((value) => String(value || "").trim())
      .join(" ");

    const looksLikeTemplate =
      name === "" &&
      why === "" &&
      price === 0 &&
      supply === 0 &&
      /low\|medium\|high|Go\|Watch\|No-Go/.test(enumLikeFields);

    return !looksLikeTemplate;
  });
}

async function saveArtifacts(baseDir, basename, artifacts) {
  const manifestPath = path.join(baseDir, `${basename}.json`);
  await fs.writeFile(manifestPath, JSON.stringify(artifacts.manifest, null, 2), "utf8");

  if (artifacts.text) {
    await fs.writeFile(path.join(baseDir, `${basename}.txt`), artifacts.text, "utf8");
  }

  if (artifacts.replayText) {
    await fs.writeFile(
      path.join(baseDir, `${basename}.replay.txt`),
      artifacts.replayText,
      "utf8",
    );
  }

  if (artifacts.screenshot) {
    await fs.writeFile(path.join(baseDir, `${basename}.png`), artifacts.screenshot);
  }

  if (artifacts.parsedResult) {
    await fs.writeFile(
      path.join(baseDir, `${basename}.analysis.json`),
      JSON.stringify(artifacts.parsedResult, null, 2),
      "utf8",
    );
  }

  if (Array.isArray(artifacts.candidateTexts) && artifacts.candidateTexts.length > 0) {
    await fs.writeFile(
      path.join(baseDir, `${basename}.candidates.json`),
      JSON.stringify(artifacts.candidateTexts, null, 2),
      "utf8",
    );
  }

  if (artifacts.report) {
    await fs.writeFile(path.join(baseDir, `${basename}.report.md`), artifacts.report, "utf8");
  }

  return manifestPath;
}

async function resolveStorageStatePath(profileDir) {
  await ensureDir(profileDir);
  return path.join(profileDir, "storage-state.json");
}

async function hasSavedStorageState(storageStatePath) {
  try {
    const raw = await fs.readFile(storageStatePath, "utf8");
    const parsed = JSON.parse(raw);
    return (
      Array.isArray(parsed?.cookies) && parsed.cookies.length > 0
    ) || (
      Array.isArray(parsed?.origins) && parsed.origins.length > 0
    );
  } catch {
    return false;
  }
}

async function persistStorageStateSnapshot(context, ...pathsToWrite) {
  const targets = pathsToWrite.filter(Boolean);
  if (!context || targets.length === 0) {
    return;
  }

  for (const target of targets) {
    await context.storageState({ path: target }).catch(() => {});
  }
}

function getLaunchOptions(headless) {
  return {
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=ThirdPartyStoragePartitioning,TrackingProtection3pcd,FedCm",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };
}

async function launchBrowserContext(profileDir, browserProfileDir, headless) {
  const storageStatePath = await resolveStorageStatePath(profileDir);
  const hasState = await hasSavedStorageState(storageStatePath);
  await ensureDir(browserProfileDir);

  const launchOptions = {
    ...getLaunchOptions(headless),
    viewport: { width: 1440, height: 1200 },
    ignoreHTTPSErrors: true,
  };

  const browserChannels = ["msedge", "chrome"];
  for (const channel of browserChannels) {
    try {
      const context = await chromium.launchPersistentContext(browserProfileDir, {
        ...launchOptions,
        channel,
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          configurable: true,
          get: () => undefined,
        });

        window.chrome = window.chrome || { runtime: {} };
      });
      return { context, storageStatePath, browserProfileDir, hasState };
    } catch (error) {
      console.warn(`${channel} channel unavailable, trying next option: ${error}`);
    }
  }

  const context = await chromium.launchPersistentContext(browserProfileDir, {
    ...launchOptions,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });

    window.chrome = window.chrome || { runtime: {} };
  });

  return { context, storageStatePath, browserProfileDir, hasState };
}

async function bootstrapStorageState(context, storageStatePath, hasState) {
  if (!hasState) {
    return;
  }

  try {
    const raw = await fs.readFile(storageStatePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.cookies) && parsed.cookies.length > 0) {
      await context.addCookies(parsed.cookies);
    }
  } catch (error) {
    console.warn(`Unable to bootstrap storage state from ${storageStatePath}: ${error}`);
  }
}

async function createPageForRun(context, storageStatePath, hasState) {
  await bootstrapStorageState(context, storageStatePath, hasState);

  const existingPages = context.pages().filter((page) => !page.isClosed());

  if (existingPages.length > 0) {
    const [page, ...extraPages] = existingPages;
    for (const extraPage of extraPages) {
      await extraPage.close().catch(() => {});
    }
    await page.bringToFront().catch(() => {});
    return page;
  }

  try {
    const page = await context.newPage();
    await page.bringToFront();
    return page;
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const retryPages = context.pages().filter((page) => !page.isClosed());
    if (retryPages.length > 0) {
      const [page, ...extraPages] = retryPages;
      for (const extraPage of extraPages) {
        await extraPage.close().catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      return page;
    }
    throw error;
  }
}

async function launchLegacyBrowserContext(profileDir, headless) {
  const storageStatePath = await resolveStorageStatePath(profileDir);
  const hasState = await hasSavedStorageState(storageStatePath);

  const browserChannels = ["msedge", "chrome"];
  for (const channel of browserChannels) {
    try {
      const browser = await chromium.launch({
        ...getLaunchOptions(headless),
        channel,
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1200 },
        ignoreHTTPSErrors: true,
        storageState: hasState ? storageStatePath : undefined,
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          configurable: true,
          get: () => undefined,
        });

        window.chrome = window.chrome || { runtime: {} };
      });
      return { browser, context, storageStatePath, browserProfileDir: "", hasState };
    } catch (error) {
      console.warn(`${channel} channel unavailable, trying next option: ${error}`);
    }
  }

  const browser = await chromium.launch(getLaunchOptions(headless));
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
      ignoreHTTPSErrors: true,
      storageState: hasState ? storageStatePath : undefined,
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        configurable: true,
        get: () => undefined,
      });

      window.chrome = window.chrome || { runtime: {} };
    });
    return { browser, context, storageStatePath, browserProfileDir: "", hasState };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

function isProfileInUseError(error) {
  const message = String(error || "");
  return /user data dir(?:ectory)? is already in use|已在现有浏览器会话中打开|另一个浏览器会话|existing browser session/i.test(
    message,
  );
}

function createProfileLockedError(browserProfileDir) {
  const error = new Error(
    `AlphaShop 专用浏览器配置目录正在被占用。先关闭占用 ${browserProfileDir} 的浏览器窗口，再重试。不要在普通 Chrome/Edge 窗口里单独登录。`,
  );
  error.code = "PROFILE_LOCKED";
  return error;
}

async function isBrowserProfileLocked(browserProfileDir) {
  const lockNames = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];
  for (const name of lockNames) {
    try {
      await fs.access(path.join(browserProfileDir, name));
      return true;
    } catch {
      // Ignore missing lock markers.
    }
  }
  return false;
}

async function navigateToTarget(page, targetUrl, timeoutMs) {
  try {
    await gotoWithProxyFallback(page, targetUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs,
      hosts: [extractHostname(targetUrl), "alphashop.cn", "www.alphashop.cn"],
    });
  } catch (error) {
    const message = String(error);
    if (!message.includes("ERR_ABORTED")) {
      throw error;
    }
  }

  await page.waitForTimeout(4000);

  if (page.url() === "about:blank") {
    await gotoWithProxyFallback(page, LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeoutMs,
      hosts: ["alphashop.cn", "www.alphashop.cn"],
    });
    await page.waitForTimeout(3000);
  }

  if (page.url() === "about:blank") {
    await page.evaluate((url) => {
      window.location.href = url;
    }, LOGIN_URL);
    await page.waitForTimeout(3000);
  }

  await page.bringToFront();
}

async function redirectIfLoginUrlWasRenderedAsPlainText(page, timeoutMs) {
  const renderedUrl = await page.evaluate(() => {
    const text = document.body?.innerText?.trim() || "";
    return /^https:\/\/login\.taobao\.com\/member\/login\.jhtml\?/i.test(text)
      ? text
      : "";
  });

  if (!renderedUrl) {
    return false;
  }

  await gotoWithProxyFallback(page, renderedUrl, {
    waitUntil: "domcontentloaded",
    timeoutMs,
    hosts: [extractHostname(renderedUrl), "alphashop.cn", "www.alphashop.cn"],
  }).catch(() => {});
  await page.waitForTimeout(3000);
  return true;
}

async function ensureSignedIn(
  page,
  targetUrl,
  timeoutMs,
  loginTimeoutMs,
  hasState,
  forceLoginFlow = false,
) {
  if (!forceLoginFlow && !/\/login|\/signIn/i.test(page.url())) {
    return;
  }

  if (hasState) {
    await gotoWithProxyFallback(page, targetUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs,
      hosts: [extractHostname(targetUrl), "alphashop.cn", "www.alphashop.cn"],
    }).catch(() => {});
    await page.waitForTimeout(3000);
    if (!/\/login/.test(page.url())) {
      return;
    }
  }

  await gotoWithProxyFallback(page, DIRECT_SIGNIN_URL, {
    waitUntil: "domcontentloaded",
    timeoutMs,
    hosts: ["alphashop.cn", "www.alphashop.cn"],
  }).catch(async () => {
    await gotoWithProxyFallback(page, LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeoutMs,
      hosts: ["alphashop.cn", "www.alphashop.cn"],
    });
  });
  await redirectIfLoginUrlWasRenderedAsPlainText(page, timeoutMs);

  console.log(
    "AlphaShop requires login. Complete sign-in in the browser window. The script will continue automatically.",
  );

  const loginDeadline = Date.now() + loginTimeoutMs;
  while (/\/login|\/signIn/i.test(page.url()) && Date.now() < loginDeadline) {
    await redirectIfLoginUrlWasRenderedAsPlainText(page, timeoutMs);
    await page.waitForTimeout(1500);
  }

  if (/\/login|\/signIn/i.test(page.url())) {
    throw new Error("Login was not completed before timeout.");
  }
}

async function runSelectionAttempt(page, prompt, timeoutMs) {
  const promptSubmitted = await submitPrompt(page, prompt);
  console.log(promptSubmitted ? "Prompt submission triggered." : "Prompt submission did not trigger.");
  const replayState = await waitForReplay(page, timeoutMs, prompt);
  const candidateTexts = await collectResultCandidates(page).catch(() => []);
  return {
    promptSubmitted,
    settledText: replayState.text,
    candidateTexts,
    replayTimedOut: replayState.timedOut,
    replaySnapshot: replayState.snapshot,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.url = getResolvedTargetUrl(args.url);
  const rules = getRules(args);
  const builtPrompt = buildPrompt(args, rules);
  const startedAt = new Date().toISOString();

  await ensureDir(args.outputDir);
  await ensureDir(args.profileDir);

  const seenResponses = [];
  const consoleMessages = [];
  let replayText = "";
  let candidateTexts = [];
  let replayTimedOut = false;
  let replaySnapshot = null;

  let runtime;
  try {
    if (await isBrowserProfileLocked(args.browserProfileDir)) {
      throw createProfileLockedError(args.browserProfileDir);
    }
    runtime = await launchBrowserContext(
      args.profileDir,
      args.browserProfileDir,
      args.headless,
    );
  } catch (error) {
    if (error?.code === "PROFILE_LOCKED" || isProfileInUseError(error)) {
      throw createProfileLockedError(args.browserProfileDir);
    }
    console.warn(
      `Persistent profile startup failed, falling back to storage-state mode: ${error}`,
    );
    runtime = await launchLegacyBrowserContext(args.profileDir, args.headless);
  }

  const {
    browser,
    context,
    storageStatePath,
    browserProfileDir,
    hasState,
  } = runtime;
  const page = await createPageForRun(context, storageStatePath, hasState);

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (!/alphashop\.cn|1688-global\/ai-agent/.test(url)) return;

    const record = {
      url,
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
      capturedAt: new Date().toISOString(),
    };

    try {
      if (
        /opp\/history\/replay/.test(url) ||
        /json|text|event-stream/.test(record.contentType)
      ) {
        const body = await response.text();
        record.bodyPreview = body.slice(0, 16000);
        if (/opp\/history\/replay/.test(url) && body.trim()) {
          replayText = body;
        }
      }
    } catch (error) {
      record.readError = String(error);
    }

    seenResponses.push(record);
  });

  console.log(`Opening: ${args.url}`);
  console.log(`Platform mode: ${args.platform}`);

  await navigateToTarget(page, args.url, args.timeoutMs);

  if (/\/login|\/signIn/i.test(page.url())) {
    if (args.headless) {
      throw new Error(
        "The page redirected to the login flow while running headless. Run without --headless and complete login once.",
      );
    }

    await ensureSignedIn(
      page,
      args.url,
      args.timeoutMs,
      args.loginTimeoutMs,
      hasState,
    );
    await persistStorageStateSnapshot(context, storageStatePath);
  }

  let settledText = "";
  await runSelectionAttempt(page, builtPrompt, args.timeoutMs).then((result) => {
    settledText = result.settledText;
    candidateTexts = result.candidateTexts || [];
    replayTimedOut = Boolean(result.replayTimedOut);
    replaySnapshot = result.replaySnapshot || null;
  });

  if (hasAuthFailure(replayText, seenResponses, consoleMessages, settledText, candidateTexts)) {
    if (args.headless) {
      throw new Error(
        "AlphaShop responded with an unauthenticated session while running headless.",
      );
    }

    console.log("AlphaShop session is not authenticated yet. Opening the sign-in flow and retrying once.");
    replayText = "";

    await ensureSignedIn(
      page,
      args.url,
      args.timeoutMs,
      args.loginTimeoutMs,
      false,
      true,
    );
    await persistStorageStateSnapshot(context, storageStatePath);

    await gotoWithProxyFallback(page, args.url, {
      waitUntil: "domcontentloaded",
      timeoutMs: args.timeoutMs,
      hosts: [extractHostname(args.url), "alphashop.cn", "www.alphashop.cn"],
    });
    await page.waitForTimeout(3000);

    await runSelectionAttempt(page, builtPrompt, args.timeoutMs).then((result) => {
      settledText = result.settledText;
      candidateTexts = result.candidateTexts || [];
      replayTimedOut = Boolean(result.replayTimedOut);
      replaySnapshot = result.replaySnapshot || null;
    });
  }

  const structured = extractStructuredResult([...candidateTexts, replayText, settledText]);
  const analyzedProducts = structured ? analyzeProducts(structured, rules) : [];
  const enrichedResult = structured
    ? {
        ...structured,
        ozon_operating_rules: {
          marketplace: rules.marketplace,
          price_band_rub: `${rules.priceMinRub}-${rules.priceMaxRub}`,
          max_weight_kg: rules.maxWeightKg,
          max_long_edge_cm: rules.maxLongEdgeCm,
        },
        products: analyzedProducts,
      }
    : null;

  const report = structured
    ? buildMarkdownReport(args, rules, structured, analyzedProducts)
    : [
        "# Ozon 选品自动化报告",
        "",
        "未能从页面文本或回放内容中提取到结构化 JSON 结果。",
        "",
        "建议：",
        "- 先确认页面是否真的返回了选品结果。",
        "- 如果 AlphaShop 返回的是自然语言而非 JSON，可在页面里重新发送脚本生成的 prompt。",
        "- 如有需要，我可以继续把提取器改成兼容自然语言表格/列表格式。",
        "",
      ].join("\n");

  const basename = `alphashop-${args.platform}-${timestamp()}`;
  const screenshot = await page.screenshot({ fullPage: true, type: "png" });
  const outputStorageStatePath = path.join(args.outputDir, `${basename}.storage-state.json`);
  await persistStorageStateSnapshot(context, storageStatePath, outputStorageStatePath);

  const manifest = {
    startedAt,
    finalUrl: page.url(),
    title: await page.title(),
    platform: args.platform,
    prompt: builtPrompt,
    outputDir: args.outputDir,
    profileDir: args.profileDir,
    browserProfileDir,
    storageStatePath: outputStorageStatePath,
    responseCount: seenResponses.length,
    extractedStructuredResult: Boolean(structured),
    candidateTextCount: candidateTexts.length,
    replayTimedOut,
    replaySnapshot,
    consoleMessages,
    responses: seenResponses,
  };

  const manifestPath = await saveArtifacts(args.outputDir, basename, {
    manifest,
    text: settledText,
    replayText,
    candidateTexts,
    screenshot,
    parsedResult: enrichedResult,
    report,
  });

  console.log(`Saved manifest: ${manifestPath}`);
  if (browserProfileDir) {
    console.log(`Persistent browser profile: ${browserProfileDir}`);
  }
  console.log(`Saved storage state: ${outputStorageStatePath}`);
  console.log(`Captured responses: ${seenResponses.length}`);
  console.log(`Candidate text blocks: ${candidateTexts.length}`);
  console.log(
    structured
      ? `Structured products extracted: ${analyzedProducts.length}`
      : "Structured products extracted: 0",
  );

  if (!structured && replayTimedOut) {
    throw new Error(
      `AlphaShop selection timed out without a structured result. Manifest saved at ${manifestPath}`,
    );
  }

  if (args.keepOpen && !args.headless) {
    console.log("Keeping browser open. Close the browser window when you are done inspecting it.");
    while (!page.isClosed()) {
      await page.waitForTimeout(1000);
    }
    return;
  }

  await context.close();
  await browser?.close().catch(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
