#!/usr/bin/env node
/**
 * 财务同步脚本 — 从 Ozon 拉真实利润数据
 * 用法: node scripts/sync-financials.js [--days 30]
 */
import { readFileSync } from "node:fs";
import { parseCliArgs, readJson } from "./lib/shared.js";
import { fetchOrders, fetchTransactions, aggregateByProduct } from "./lib/ozon-finance.js";
import { getDb, upsertFinancials, getPurchaseCosts } from "./lib/db.js";

// 加载 .env
try { for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), { days: "30", userId: "1" });
  const days = parseInt(args.days) || 30;
  const userId = parseInt(args.userId) || 1;

  const cfg = await readJson("config/ozon-api.json", null);
  if (!cfg?.clientId || !cfg?.apiKey) {
    console.error("未配置 Ozon API");
    process.exit(1);
  }

  const dateFrom = new Date(Date.now() - days * 86400_000).toISOString();
  const dateTo = new Date().toISOString();

  console.log(`[财务同步] 拉取最近 ${days} 天数据...`);

  // 1) 拉订单
  console.log("  拉取订单...");
  const orders = await fetchOrders(cfg, dateFrom, dateTo);
  console.log(`  订单: ${orders.length} 个`);

  // 2) 拉交易流水
  console.log("  拉取财务流水...");
  const transactions = await fetchTransactions(cfg, dateFrom, dateTo);
  console.log(`  流水: ${transactions.length} 笔`);

  // 3) 按产品汇总
  const byProduct = aggregateByProduct(orders, transactions);
  const products = Object.values(byProduct);
  console.log(`  产品: ${products.length} 个有销售数据`);

  if (!products.length) {
    console.log("\n  暂无销售数据");
    return;
  }

  // 4) 从采购记录补充成本
  const purchaseCosts = getPurchaseCosts(userId);
  const costMap = {};
  for (const pc of purchaseCosts) costMap[pc.offer_id] = pc;

  for (const p of products) {
    const cost = costMap[p.offer_id];
    if (cost && p.units_sold > 0) {
      const unitCost = cost.total_cost_cny / cost.total_qty;
      const totalCostRub = unitCost * p.units_sold * 12.5; // CNY → RUB
      p.actual_profit = p.revenue - p.commission - p.shipping - p.refund - totalCostRub;
      p.actual_margin_pct = p.revenue > 0 ? Math.round(p.actual_profit / p.revenue * 100) : 0;
      p.purchase_cost_rub = totalCostRub;
    }
    p.period_from = dateFrom.slice(0, 10);
    p.period_to = dateTo.slice(0, 10);
  }

  // 5) 写入数据库
  upsertFinancials(userId, products);
  console.log(`  已写入 ${products.length} 条财务数据`);

  // 6) 输出报表
  products.sort((a, b) => b.actual_profit - a.actual_profit);
  console.log("\n  ─── 利润报表 ───");
  console.log("  商品                         | 销量 | 销售额  | 利润   | 利润率");
  console.log("  " + "-".repeat(70));
  for (const p of products) {
    const name = (p.name || p.offer_id).slice(0, 25).padEnd(27);
    console.log(`  ${name} | ${String(p.units_sold).padStart(3)}  | ${String(Math.round(p.revenue)).padStart(6)}₽ | ${String(Math.round(p.actual_profit)).padStart(5)}₽ | ${p.actual_margin_pct}%`);
  }

  const totalRev = products.reduce((s, p) => s + p.revenue, 0);
  const totalProfit = products.reduce((s, p) => s + p.actual_profit, 0);
  const avgMargin = totalRev > 0 ? Math.round(totalProfit / totalRev * 100) : 0;
  console.log(`\n  总销售额: ${Math.round(totalRev)}₽ | 总利润: ${Math.round(totalProfit)}₽ | 平均利润率: ${avgMargin}%`);
}

main().catch(err => { console.error(err); process.exit(1); });
