#!/usr/bin/env node
/**
 * 单元测试: 评分器 + 类目匹配
 * 用法: node tests/test-evaluate.js
 */
import fs from "node:fs/promises";
import path from "node:path";

let pass = 0, fail = 0;
function assert(name, condition) {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ─── Test 1: Business rules config loads ───
console.log("\n=== Config ===");
try {
  const biz = JSON.parse(await fs.readFile("config/business-rules.json", "utf8"));
  assert("has pricing.markup", typeof biz.pricing?.markup === "number" && biz.pricing.markup > 0);
  assert("has scoring weights", biz.scoring?.weights?.logistics > 0);
  assert("has ozon_defaults.category_id", typeof biz.ozon_defaults?.category_id === "number");
  assert("has ozon_defaults.no_brand_id", typeof biz.ozon_defaults?.no_brand_id === "number");
  assert("markup and rub_estimate are different", biz.pricing.markup !== biz.scoring.markup_for_rub_estimate);
} catch (e) {
  fail++;
  console.error("  ✗ config load failed:", e.message);
}

// ─── Test 2: Category matching ───
console.log("\n=== Category Matching ===");
try {
  const flat = JSON.parse(await fs.readFile("knowledge-base/ozon-category-flat.json", "utf8"));
  assert("category flat loaded", flat.length > 7000);

  function matchCategory(suggestion) {
    if (!flat?.length || !suggestion) return null;
    const parts = suggestion.split(/[>\/]/).map(s => s.trim()).filter(Boolean);
    const typeName = parts[parts.length - 1] || "";
    const parentName = parts.length >= 2 ? parts[parts.length - 2] : "";
    const exact = flat.find(c => (c.name || "").toLowerCase() === typeName.toLowerCase());
    if (exact) return exact;
    const tnLow = typeName.toLowerCase();
    const cm = flat.filter(c => { const n = (c.name || "").toLowerCase(); return n.includes(tnLow) || tnLow.includes(n); });
    if (cm.length === 1) return cm[0];
    if (cm.length > 1 && parentName) {
      const r = cm.find(c => (c.path || "").toLowerCase().includes(parentName.toLowerCase()));
      if (r) return r;
      return cm[0];
    }
    return null;
  }

  // 精确匹配
  const knee = matchCategory("Спорт > Защита > Защита колена");
  assert("knee guard exact match", knee?.name === "Защита колена");
  assert("knee guard correct catId", knee?.catId === 17028711);

  const tie = matchCategory("Одежда > Аксессуары > Галстук");
  assert("tie exact match", tie?.name === "Галстук");

  const stapler = matchCategory("Канцелярские товары > Степлер");
  assert("stapler exact match", stapler?.name === "Степлер");

  // 包含匹配
  const headband = matchCategory("Аксессуары / Повязка на голову");
  assert("headband contains match", headband?.name === "Повязка на голову");

  // 无效输入
  assert("null input returns null", matchCategory(null) === null);
  assert("empty string returns null", matchCategory("") === null);
  assert("garbage returns null", matchCategory("xyzzy12345") === null);

} catch (e) {
  fail++;
  console.error("  ✗ category test failed:", e.message);
}

// ─── Test 3: Price calculation ───
console.log("\n=== Pricing ===");
{
  const biz = JSON.parse(await fs.readFile("config/business-rules.json", "utf8"));
  const markup = biz.pricing.markup;
  const minPrice = biz.pricing.min_price_cny;

  // Normal markup
  const price1 = Math.round(10 * markup * 100) / 100;
  assert("10 CNY * 3.5 markup = 35", price1 === 35);

  // Min price floor
  const price2 = Math.max(Math.round(1 * markup * 100) / 100, minPrice);
  assert("1 CNY hits min price 15", price2 === minPrice);

  // Old price > price
  const oldPrice = Math.round(price1 * 1.3 * 100) / 100;
  assert("old_price > price", oldPrice > price1);
}

// ─── Test 4: safePath validation ───
console.log("\n=== Security ===");
{
  function safePath(seg) {
    if (!seg || /[\/\\]|\.\./.test(seg)) return null;
    return seg;
  }
  assert("normal slug OK", safePath("护膝-运动-37722033") === "护膝-运动-37722033");
  assert("path traversal blocked", safePath("../../config") === null);
  assert("slash blocked", safePath("foo/bar") === null);
  assert("backslash blocked", safePath("foo\\bar") === null);
  assert("null blocked", safePath(null) === null);
  assert("empty blocked", safePath("") === null);
}

// ─── Summary ───
console.log(`\n${"=".repeat(40)}`);
console.log(`  Pass: ${pass} | Fail: ${fail}`);
if (fail) { console.error("  TESTS FAILED"); process.exit(1); }
else console.log("  ALL TESTS PASSED");
