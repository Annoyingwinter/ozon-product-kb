#!/usr/bin/env node
/**
 * PDD 趋势词发现器
 * 从拼多多热门搜索中提取趋势关键词，扩充词库
 *
 * 策略:
 *   1. 用现有品类名搜索 PDD → 提取热销标题
 *   2. 从标题中提取产品型关键词（去掉品牌、材质修饰词）
 *   3. 和现有词库去重
 *   4. 用 LLM 评估适不适合卖到 Ozon
 *   5. 合格的加入词库
 *
 * 用法:
 *   node scripts/discover-trends.js                   # 自动发现
 *   node scripts/discover-trends.js --queries "猫用品,厨房收纳"  # 指定搜索词
 *   node scripts/discover-trends.js --dry-run          # 只看不写
 */
import path from "node:path";
import fs from "node:fs/promises";
import { parseCliArgs, readJson, writeJson, KB_ROOT } from "./lib/shared.js";
import { launchBrowser, gotoSafe, closeBrowser } from "./lib/browser.js";
import { llmJson } from "./lib/llm.js";

const POOL_PATH = path.join(KB_ROOT, "keyword-pool.json");
const PDD_PROFILE = path.resolve(".profiles", "pdd", "browser-user-data");
const PDD_STORAGE = path.resolve(".profiles", "pdd", "storage-state.json");
const PDD_SEARCH = "https://mobile.yangkeduo.com/search_result.html?search_key=";

// 从品类名生成PDD搜索词
function categoryToQueries(pool) {
  const queries = [];
  for (const [id, cat] of Object.entries(pool.categories)) {
    if (!cat.enabled) continue;
    // 用品类中文名 + 前2个关键词做搜索
    queries.push(cat.label);
    if (cat.keywords?.length >= 2) {
      // 取一个短关键词
      const short = cat.keywords.find(k => k.length <= 6) || cat.keywords[0];
      queries.push(short);
    }
  }
  return [...new Set(queries)].slice(0, 30);
}

// 从PDD搜索提取标题
async function searchPddTitles(page, query) {
  const url = `${PDD_SEARCH}${encodeURIComponent(query)}`;
  await gotoSafe(page, url, { wait: 4000 });

  return page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const titles = [];
    const cards = document.querySelectorAll('[class*="goodsList"] a, [class*="goods-list"] a, [class*="search-result"] a, [class*="SearchResult"] a');
    for (const card of Array.from(cards).slice(0, 20)) {
      const titleEl = card.querySelector('[class*="title"], [class*="name"], p, span');
      const salesEl = card.querySelector('[class*="sales"], [class*="sold"]');
      const title = clean(titleEl?.textContent || "");
      const sales = clean(salesEl?.textContent || "");
      if (title.length >= 4) titles.push({ title, sales });
    }
    return titles;
  });
}

// 从标题中提取产品关键词（简单分词）
function extractKeywords(titles) {
  const keywords = new Map(); // keyword → count

  for (const { title, sales } of titles) {
    // 提取销量数字作为权重
    const salesNum = parseInt(String(sales).replace(/[^\d]/g, "")) || 0;
    const weight = salesNum > 10000 ? 3 : salesNum > 1000 ? 2 : 1;

    // 简单分词: 取4-8字的中文词组
    const cleaned = title
      .replace(/【.*?】/g, "")
      .replace(/\d+[件个只套包组条]?装?/g, "")
      .replace(/[a-zA-Z\d]+/g, " ")
      .replace(/[^\u4e00-\u9fff\s]/g, " ")
      .trim();

    // 提取连续中文片段
    const segments = cleaned.split(/\s+/).filter(s => s.length >= 2 && s.length <= 8);
    for (const seg of segments) {
      if (/^(新款|爆款|热卖|包邮|批发|厂家|直销|现货|特价|同款)/.test(seg)) continue;
      keywords.set(seg, (keywords.get(seg) || 0) + weight);
    }
  }

  // 按出现频次排序
  return [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kw, count]) => ({ keyword: kw, score: count }));
}

// 用LLM评估关键词是否适合Ozon
async function evaluateWithLlm(rawKeywords, existingKeywords) {
  const newKws = rawKeywords
    .filter(k => !existingKeywords.has(k.keyword))
    .slice(0, 50);

  if (!newKws.length) return [];

  const prompt = `你是跨境电商选品专家（中国→俄罗斯Ozon）。
以下是从拼多多热销商品中提取的关键词，请评估哪些适合在Ozon上销售。

筛选标准：
- 重量 < 2kg，体积不大
- 低退货率（非服装鞋帽尺码类最好）
- 不需要认证/资质
- 在俄罗斯有需求
- 能在1688上找到货源

关键词列表：
${newKws.map(k => k.keyword + " (热度:" + k.score + ")").join("\n")}

输出JSON：只返回适合的关键词，并标注建议品类。
[
  { "keyword": "xxx", "category": "品类ID", "category_label": "品类名", "reason": "为什么适合" },
  ...
]

品类ID参考: auto, pet, kitchen, home_storage, desk, travel, cleaning, gadgets, baby, fitness, stationery, clothing, accessories, electronics_light, beauty_skincare_tools, holiday_party_decor, gardening_planting, aromatherapy_bath, board_games_puzzles`;

  try {
    return await llmJson(prompt, { system: "只输出JSON数组，不要其他文字" });
  } catch {
    return [];
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    queries: "",
    dryRun: false,
    limit: "30",
  });

  const pool = await readJson(POOL_PATH);
  const existingKeywords = new Set();
  for (const cat of Object.values(pool.categories)) {
    for (const kw of (cat.keywords || [])) existingKeywords.add(kw);
  }

  // 确定搜索词
  let queries;
  if (args.queries) {
    queries = args.queries.split(",").map(s => s.trim()).filter(Boolean);
  } else {
    queries = categoryToQueries(pool);
  }

  console.log(`\n[趋势发现] 从 PDD 搜索 ${queries.length} 个关键词...`);

  // 启动浏览器
  const { context, browser } = await launchBrowser(PDD_PROFILE, {
    headless: true,
    storageStatePath: PDD_STORAGE,
  });
  const page = context.pages()[0] || await context.newPage();

  // 搜索并收集标题
  const allTitles = [];
  const limit = parseInt(args.limit) || 30;
  for (const q of queries.slice(0, limit)) {
    try {
      const titles = await searchPddTitles(page, q);
      allTitles.push(...titles);
      console.log(`  "${q}" → ${titles.length} 个结果`);
    } catch (err) {
      console.log(`  "${q}" → 失败: ${err.message?.slice(0, 40)}`);
    }
    await new Promise(r => setTimeout(r, 1500)); // 控制频率
  }

  await closeBrowser({ context, browser }).catch(() => {});

  console.log(`\n[趋势发现] 共收集 ${allTitles.length} 个标题`);

  // 提取关键词
  const rawKeywords = extractKeywords(allTitles);
  const newKeywords = rawKeywords.filter(k => !existingKeywords.has(k.keyword));
  console.log(`[趋势发现] 提取 ${rawKeywords.length} 个词，${newKeywords.length} 个新词`);

  if (!newKeywords.length) {
    console.log("[趋势发现] 无新词发现");
    return;
  }

  // 用LLM评估
  console.log(`[趋势发现] AI评估中...`);
  const approved = await evaluateWithLlm(newKeywords, existingKeywords);
  console.log(`[趋势发现] AI筛选出 ${approved.length} 个适合 Ozon 的关键词`);

  if (!approved.length) {
    console.log("[趋势发现] 无合格关键词");
    return;
  }

  // 显示结果
  console.log("\n  ─── 发现的趋势词 ───");
  for (const kw of approved) {
    console.log(`  ✓ ${kw.keyword} → ${kw.category_label || kw.category} (${kw.reason?.slice(0, 30)})`);
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] 未写入词库`);
    return;
  }

  // 写入词库
  let added = 0;
  for (const kw of approved) {
    const catId = kw.category || "gadgets";
    if (!pool.categories[catId]) {
      pool.categories[catId] = {
        label: kw.category_label || catId,
        enabled: true,
        target_users: "",
        keywords: [],
      };
    }
    const cat = pool.categories[catId];
    if (!cat.keywords.includes(kw.keyword)) {
      cat.keywords.push(kw.keyword);
      added++;
    }
  }

  if (added) {
    pool._meta.last_expanded_at = new Date().toISOString();
    await fs.writeFile(POOL_PATH, JSON.stringify(pool, null, 2));
    console.log(`\n[趋势发现] ✓ 词库已更新: +${added} 个新词 (总计 ${Object.values(pool.categories).reduce((s, c) => s + (c.keywords?.length || 0), 0)})`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
