#!/usr/bin/env node
/**
 * AI词库扩展器 — 用LLM自动生成新关键词和品类
 *
 * 用法:
 *   node scripts/expand-keyword-pool.js                    # 扩展所有品类
 *   node scripts/expand-keyword-pool.js --category 服装     # 只扩展服装
 *   node scripts/expand-keyword-pool.js --new-category 美妆  # 新建美妆品类
 *   node scripts/expand-keyword-pool.js --count 20          # 每品类生成20个词
 */
import fs from "node:fs/promises";
import path from "node:path";
import { llmJson } from "./lib/llm.js";

const POOL_PATH = path.resolve("knowledge-base", "keyword-pool.json");

async function loadPool() {
  return JSON.parse(await fs.readFile(POOL_PATH, "utf8"));
}

async function savePool(pool) {
  pool._meta.last_expanded_at = new Date().toISOString();
  let total = 0;
  for (const cat of Object.values(pool.categories)) total += (cat.keywords || []).length;
  pool._meta.total_categories = Object.keys(pool.categories).length;
  await fs.writeFile(POOL_PATH, JSON.stringify(pool, null, 2), "utf8");
  return total;
}

function buildExpandPrompt(existingKeywords, categoryLabel, targetUsers, count) {
  return `你是一个跨境电商选品专家，专注中国供应链→俄罗斯Ozon平台。

现有品类「${categoryLabel}」的关键词（已有${existingKeywords.length}个）：
${existingKeywords.slice(0, 15).join("、")}${existingKeywords.length > 15 ? "..." : ""}

请再生成 ${count} 个新的1688/义乌购搜索关键词，要求：
1. 不要和已有关键词重复
2. 适合在Ozon俄罗斯站销售（轻小件、低退货、易物流）
3. 关键词要精准（能直接在1688搜到商品）
4. 格式：2-6个中文词组合，如"硅胶折叠碗 户外"
5. 目标用户：${targetUsers}

只输出JSON数组，不要其他文字：
["关键词1", "关键词2", ...]`;
}

function buildNewCategoryPrompt(categoryName, count) {
  return `你是一个跨境电商选品专家，专注中国供应链→俄罗斯Ozon平台。

请为新品类「${categoryName}」生成完整的选品关键词库。

要求：
1. 生成 ${count} 个1688/义乌购搜索关键词
2. 适合在Ozon俄罗斯站销售
3. 轻小件优先，单价10-200元CNY
4. 关键词精准，能直接搜到商品
5. 涵盖该品类的主要子品类

输出JSON格式：
{
  "label": "${categoryName}",
  "target_users": "目标用户描述",
  "keywords": ["关键词1", "关键词2", ...]
}`;
}

function buildDiscoverPrompt() {
  return `你是一个跨境电商选品专家。请推荐5个适合从中国采购卖到俄罗斯Ozon平台的新品类。

要求：
1. 不要选以下已有品类：汽车用品、宠物用品、厨房用品、家居收纳、办公桌面、旅行户外、清洁工具、生活小工具、母婴用品、运动健身、文具手工、服装鞋帽、配饰箱包、轻电子
2. 选有市场需求、轻小件、低退货率的品类
3. 每个品类给15个搜索关键词

输出JSON格式：
[
  {
    "key": "category_key_english",
    "label": "品类中文名",
    "target_users": "目标用户",
    "keywords": ["关键词1", "关键词2", ...]
  }
]`;
}

async function expandCategory(pool, catKey, count) {
  const cat = pool.categories[catKey];
  if (!cat) throw new Error(`品类不存在: ${catKey}`);

  const MAX = 30;
  const currentTexts = cat.keywords.map(kw => typeof kw === "string" ? kw : kw.text);
  console.log(`[expand] 扩展品类「${cat.label}」(${currentTexts.length}/${MAX}个)...`);

  const result = await llmJson(
    buildExpandPrompt(currentTexts, cat.label, cat.target_users, count),
    { system: "你是跨境电商选品专家。只输出JSON数组。", maxTokens: 2048 }
  );

  const newKeywords = (Array.isArray(result) ? result : (result.keywords || []))
    .filter(kw => typeof kw === "string" && kw.length >= 2 && !currentTexts.includes(kw));

  // 如果加上新词超过上限，淘汰低分词腾位置
  const slotsAvailable = MAX - cat.keywords.length;
  let added = 0;
  if (slotsAvailable >= newKeywords.length) {
    // 有位置直接加
    for (const kw of newKeywords) {
      cat.keywords.push({ text: kw, score: 50, hits: 0, misses: 0, last_used: null });
      added++;
    }
  } else {
    // 先加满空位
    for (const kw of newKeywords.slice(0, Math.max(0, slotsAvailable))) {
      cat.keywords.push({ text: kw, score: 50, hits: 0, misses: 0, last_used: null });
      added++;
    }
    // 剩下的替换低分词
    const remaining = newKeywords.slice(Math.max(0, slotsAvailable));
    for (const kw of remaining) {
      // 找分数最低的
      let minIdx = -1, minScore = Infinity;
      for (let i = 0; i < cat.keywords.length; i++) {
        const s = typeof cat.keywords[i] === "object" ? (cat.keywords[i].score || 50) : 50;
        if (s < minScore) { minScore = s; minIdx = i; }
      }
      if (minIdx >= 0 && minScore < 50) { // 只替换低于初始分的
        const old = typeof cat.keywords[minIdx] === "object" ? cat.keywords[minIdx].text : cat.keywords[minIdx];
        cat.keywords[minIdx] = { text: kw, score: 50, hits: 0, misses: 0, last_used: null };
        console.log(`[expand]   替换低分词「${old}」(${minScore}分) → 「${kw}」`);
        added++;
      }
    }
  }

  console.log(`[expand] 「${cat.label}」+${added}个 (总计${cat.keywords.length}/${MAX})`);
  return added;
}

async function createCategory(pool, categoryName, count) {
  console.log(`[expand] 创建新品类「${categoryName}」(${count}个关键词)...`);

  const result = await llmJson(
    buildNewCategoryPrompt(categoryName, count),
    { system: "你是跨境电商选品专家。只输出JSON。", maxTokens: 2048 }
  );

  const key = categoryName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").toLowerCase();
  pool.categories[key] = {
    label: result.label || categoryName,
    enabled: true,
    target_users: result.target_users || "",
    keywords: Array.isArray(result.keywords) ? result.keywords : [],
  };

  console.log(`[expand] 新品类「${categoryName}」创建成功: ${pool.categories[key].keywords.length}个关键词`);
  return pool.categories[key].keywords.length;
}

async function discoverCategories(pool) {
  console.log("[expand] AI发现新品类...");

  const result = await llmJson(
    buildDiscoverPrompt(),
    { system: "你是跨境电商选品专家。只输出JSON数组。", maxTokens: 4096 }
  );

  const newCats = Array.isArray(result) ? result : [];
  let totalAdded = 0;

  for (const cat of newCats) {
    if (!cat.key || !cat.keywords?.length) continue;
    if (pool.categories[cat.key]) {
      console.log(`[expand] 跳过已存在品类: ${cat.label || cat.key}`);
      continue;
    }
    pool.categories[cat.key] = {
      label: cat.label || cat.key,
      enabled: true,
      target_users: cat.target_users || "",
      keywords: cat.keywords,
    };
    totalAdded += cat.keywords.length;
    console.log(`[expand] 新品类「${cat.label}」: ${cat.keywords.length}个关键词`);
  }

  return totalAdded;
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if (arg === "--category" && next) { args.category = next; i++; }
    else if (arg === "--new-category" && next) { args.newCategory = next; i++; }
    else if (arg === "--count" && next) { args.count = parseInt(next); i++; }
    else if (arg === "--discover") { args.discover = true; }
    else if (arg === "--all") { args.all = true; }
  }

  const count = args.count || 15;
  const pool = await loadPool();

  if (args.discover) {
    // AI自动发现新品类
    const added = await discoverCategories(pool);
    const total = await savePool(pool);
    console.log(`\n[完成] 新增 ${added} 个关键词，词库总计 ${total} 个`);
    return;
  }

  if (args.newCategory) {
    // 创建新品类
    await createCategory(pool, args.newCategory, count);
    const total = await savePool(pool);
    console.log(`\n[完成] 词库总计 ${total} 个关键词`);
    return;
  }

  if (args.category) {
    // 扩展指定品类
    const catKey = Object.keys(pool.categories).find(k =>
      pool.categories[k].label.includes(args.category) || k.includes(args.category)
    );
    if (!catKey) {
      console.error(`找不到品类: ${args.category}`);
      console.log("可用品类:", Object.values(pool.categories).map(c => c.label).join(", "));
      process.exit(1);
    }
    await expandCategory(pool, catKey, count);
    const total = await savePool(pool);
    console.log(`\n[完成] 词库总计 ${total} 个关键词`);
    return;
  }

  if (args.all) {
    // 扩展所有品类
    let totalAdded = 0;
    for (const catKey of Object.keys(pool.categories)) {
      if (!pool.categories[catKey].enabled) continue;
      totalAdded += await expandCategory(pool, catKey, count);
    }
    const total = await savePool(pool);
    console.log(`\n[完成] 新增 ${totalAdded} 个关键词，词库总计 ${total} 个`);
    return;
  }

  // 默认：显示当前词库状态
  let total = 0;
  console.log("\n=== 关键词词库 ===\n");
  for (const [key, cat] of Object.entries(pool.categories)) {
    const icon = cat.enabled ? "✅" : "⬜";
    total += cat.keywords.length;
    console.log(`${icon} ${cat.label.padEnd(8)} ${String(cat.keywords.length).padStart(3)}个  → ${cat.target_users}`);
  }
  console.log(`\n总计: ${total} 个关键词, ${Object.keys(pool.categories).length} 个品类`);
  console.log("\n用法:");
  console.log("  node scripts/expand-keyword-pool.js --all              # AI扩展所有品类");
  console.log("  node scripts/expand-keyword-pool.js --category 服装     # 扩展服装品类");
  console.log("  node scripts/expand-keyword-pool.js --new-category 美妆 # 新建美妆品类");
  console.log("  node scripts/expand-keyword-pool.js --discover          # AI发现新品类");
}

main().catch(err => { console.error(err.message); process.exit(1); });
