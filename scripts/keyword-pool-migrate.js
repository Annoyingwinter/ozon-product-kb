#!/usr/bin/env node
/**
 * 一次性迁移：把旧词库格式（纯字符串数组）升级为带评分的v3格式
 */
import fs from "node:fs/promises";

const POOL_PATH = "knowledge-base/keyword-pool.json";
const pool = JSON.parse(await fs.readFile(POOL_PATH, "utf8"));

const MAX_PER_CATEGORY = 30;

for (const [key, cat] of Object.entries(pool.categories)) {
  const oldKeywords = cat.keywords || [];
  // 转为对象格式，截断到上限
  cat.keywords = oldKeywords.slice(0, MAX_PER_CATEGORY).map(kw => {
    if (typeof kw === "string") {
      return { text: kw, score: 50, hits: 0, misses: 0, last_used: null };
    }
    return kw; // 已经是对象格式
  });
}

pool._meta.version = 3;
pool._meta.description = "智能词库 v3 — 带评分、淘汰和上限控制";
pool._meta.max_per_category = MAX_PER_CATEGORY;

await fs.writeFile(POOL_PATH, JSON.stringify(pool, null, 2), "utf8");

let total = 0;
for (const cat of Object.values(pool.categories)) total += cat.keywords.length;
console.log(`迁移完成: ${Object.keys(pool.categories).length} 个品类, ${total} 个关键词 (上限${MAX_PER_CATEGORY}/品类)`);
