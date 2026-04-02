#!/usr/bin/env node
/**
 * 全自动循环: 选品上架 → 监测浏览率 → 淘汰低效 → 再选品
 *
 * 用法:
 *   node scripts/auto-cycle.js                    # 跑一轮完整循环
 *   node scripts/auto-cycle.js --loop             # 持续循环（每轮间隔可配）
 *   node scripts/auto-cycle.js --prune-only       # 只跑淘汰（不选新品）
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseCliArgs, readJson, KB_ROOT } from "./lib/shared.js";
import { proxyFetch, getProxyDispatcherAsync } from "./lib/proxy.js";

const PRUNE_THRESHOLD = 1;   // 浏览占比低于1%的下架
const PRUNE_DAYS = 7;        // 看最近7天的数据
const PIPELINE_LIMIT = 50;   // 每轮选50个新品
const LOOP_INTERVAL_H = 2;   // 循环间隔（2小时）

function run(script, args = []) {
  console.log(`\n  ▶ ${script} ${args.join(" ")}`);
  try {
    execFileSync("node", [path.resolve("scripts", script), ...args], {
      stdio: "inherit", cwd: path.resolve(""), timeout: 900_000, env: process.env,
    });
    return true;
  } catch { return false; }
}

async function pruneByAnalytics() {
  console.log(`\n[淘汰] 检查最近 ${PRUNE_DAYS} 天浏览率 (阈值 <${PRUNE_THRESHOLD}%)...`);

  const cfgPath = path.join(KB_ROOT, "..", "config", "ozon-api.json");
  const cfg = await readJson(cfgPath, {});
  if (!cfg.clientId || !cfg.apiKey) {
    console.log("  跳过: 未配置 Ozon API");
    return;
  }

  await getProxyDispatcherAsync();
  const h = { "Client-Id": String(cfg.clientId), "Api-Key": cfg.apiKey, "Content-Type": "application/json" };
  const dateFrom = new Date(Date.now() - PRUNE_DAYS * 86400_000).toISOString().slice(0, 10);
  const dateTo = new Date().toISOString().slice(0, 10);

  try {
    const r = await proxyFetch("https://api-seller.ozon.ru/v1/analytics/data", {
      method: "POST", headers: h,
      body: JSON.stringify({
        date_from: dateFrom, date_to: dateTo,
        metrics: ["hits_view"], dimension: ["sku"],
        filters: [], limit: 1000, offset: 0,
        sort: [{ key: "hits_view", order: "ASC" }],
      }),
    });
    const d = await r.json();
    const data = d.result?.data || [];
    const totalViews = data.reduce((s, d) => s + (d.metrics?.[0] || 0), 0);

    const toPrune = data.filter(d => {
      const views = d.metrics?.[0] || 0;
      return totalViews > 0 && (views / totalViews * 100) < PRUNE_THRESHOLD;
    });

    console.log(`  总浏览: ${totalViews} | 产品数: ${data.length} | 低于${PRUNE_THRESHOLD}%: ${toPrune.length}`);

    if (!toPrune.length) {
      console.log("  无需淘汰");
      return;
    }

    // SKU → product_id 映射
    const skuSet = new Set(toPrune.map(d => String(d.dimensions?.[0]?.id)));
    const skuToProductId = {};
    const sr = await proxyFetch("https://api-seller.ozon.ru/v4/product/info/stocks", {
      method: "POST", headers: h,
      body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 1000 }),
    });
    const sd = await sr.json();
    for (const item of (sd.items || [])) {
      const sku = String(item.stocks?.[0]?.sku || "");
      if (skuSet.has(sku)) skuToProductId[sku] = item.product_id;
    }

    const productIds = toPrune.map(d => skuToProductId[String(d.dimensions?.[0]?.id)]).filter(Boolean);
    if (productIds.length) {
      const ar = await proxyFetch("https://api-seller.ozon.ru/v1/product/archive", {
        method: "POST", headers: h,
        body: JSON.stringify({ product_id: productIds }),
      });
      const ad = await ar.json();
      console.log(`  已归档 ${productIds.length} 个低效产品`);
    }

    // 列出淘汰的
    for (const d of toPrune) {
      const name = d.dimensions?.[0]?.name || "?";
      const views = d.metrics?.[0] || 0;
      const share = totalViews > 0 ? (views / totalViews * 100).toFixed(1) : "0";
      console.log(`  ✗ ${name.slice(0, 35)} | ${views}次 | ${share}%`);
    }
  } catch (e) {
    console.log(`  淘汰失败: ${e.message?.slice(0, 60)}`);
  }
}

async function runCycle() {
  const ts = new Date().toLocaleString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  自动循环 — ${ts}`);
  console.log("=".repeat(60));

  // Step 1: 淘汰低效产品
  await pruneByAnalytics();

  // Step 2: 词库不够时自动扩展
  try {
    const poolPath = path.join(KB_ROOT, "..", "knowledge-base", "keyword-pool.json");
    const usedPath = path.join(KB_ROOT, "..", "knowledge-base", ".used-keywords.json");
    const pool = await readJson(poolPath, null);
    const used = new Set(await readJson(usedPath, []) || []);
    let remaining = 0;
    if (pool?.categories) {
      for (const cat of Object.values(pool.categories)) {
        remaining += (cat.keywords || []).filter(kw => !used.has(kw)).length;
      }
    }
    console.log(`\n[词库] 剩余: ${remaining} 个未使用关键词`);
    if (remaining < PIPELINE_LIMIT * 2) {
      console.log(`[词库] 不足，AI自动扩展中...`);
      run("expand-keyword-pool.js", ["--count", "30"]);
    }
  } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 60)); }

  // Step 3: 选品 + 采集 + 推理 + 上架
  console.log("\n[选品上架] 启动 Pipeline...");
  run("run-pipeline.js", ["--limit", String(PIPELINE_LIMIT), "--headless"]);

  console.log(`\n  循环完成 — ${new Date().toLocaleString()}`);
}

async function main() {
  // 加载 .env
  try {
    const { readFileSync } = await import("node:fs");
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}

  const args = parseCliArgs(process.argv.slice(2), {
    loop: false,
    pruneOnly: false,
  });

  if (args.pruneOnly) {
    await pruneByAnalytics();
    return;
  }

  await runCycle();

  if (args.loop) {
    console.log(`\n  下一轮: ${LOOP_INTERVAL_H} 小时后`);
    setInterval(runCycle, LOOP_INTERVAL_H * 3600_000);
    // 保持进程运行
    await new Promise(() => {});
  }
}

main().catch(err => { console.error(err); process.exit(1); });
