/**
 * Ozon 财务数据模块 — 拉取订单/交易/利润
 */
import { proxyFetch, getProxyDispatcherAsync } from "./proxy.js";

const OZON_BASE = "https://api-seller.ozon.ru";

async function ozonFetch(endpoint, body, cfg) {
  const dispatcher = await getProxyDispatcherAsync();
  const r = await fetch(OZON_BASE + endpoint, {
    method: "POST",
    headers: { "Client-Id": String(cfg.clientId), "Api-Key": cfg.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!r.ok) return { ok: false, data: await r.json().catch(() => ({})) };
  return { ok: true, data: await r.json() };
}

/**
 * 拉取 FBS 订单（含财务数据）
 */
export async function fetchOrders(cfg, dateFrom, dateTo) {
  const allPostings = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const r = await ozonFetch("/v3/posting/fbs/list", {
      filter: { since: dateFrom, to: dateTo },
      limit: 50, offset,
      with: { analytics_data: true, financial_data: true },
    }, cfg);
    if (!r.ok) break;
    const postings = r.data.result?.postings || [];
    allPostings.push(...postings);
    if (postings.length < 50) break;
    offset += 50;
  }
  return allPostings;
}

/**
 * 拉取财务流水（佣金/物流/退款明细）
 */
export async function fetchTransactions(cfg, dateFrom, dateTo) {
  const allTxns = [];
  for (let page = 1; page <= 50; page++) {
    const r = await ozonFetch("/v3/finance/transaction/list", {
      filter: { date: { from: dateFrom, to: dateTo } },
      page, page_size: 50,
    }, cfg);
    if (!r.ok) break;
    const txns = r.data.result?.operations || [];
    allTxns.push(...txns);
    if (txns.length < 50) break;
  }
  return allTxns;
}

/**
 * 按 offer_id 汇总利润
 */
export function aggregateByProduct(orders, transactions) {
  const byProduct = {};

  // 从订单提取销售数据
  for (const order of orders) {
    for (const product of (order.products || [])) {
      const offerId = product.offer_id;
      if (!byProduct[offerId]) {
        byProduct[offerId] = {
          offer_id: offerId,
          name: product.name || "",
          units_sold: 0,
          revenue: 0,
          commission: 0,
          shipping: 0,
          refund: 0,
        };
      }
      byProduct[offerId].units_sold += product.quantity || 1;
      // financial_data 在订单级别
      const fin = order.financial_data;
      if (fin) {
        byProduct[offerId].revenue += (fin.products?.price || 0) * (product.quantity || 1);
      }
    }
  }

  // 从交易流水提取佣金/物流/退款
  for (const txn of transactions) {
    const offerId = txn.items?.[0]?.offer_id || "";
    if (!offerId || !byProduct[offerId]) continue;
    const amount = Math.abs(txn.amount || 0);
    const type = (txn.operation_type || "").toLowerCase();
    if (/commission|комисс/i.test(type)) byProduct[offerId].commission += amount;
    else if (/deliver|logist|ship|доставк/i.test(type)) byProduct[offerId].shipping += amount;
    else if (/return|refund|возврат/i.test(type)) byProduct[offerId].refund += amount;
  }

  // 计算利润
  for (const p of Object.values(byProduct)) {
    p.actual_profit = p.revenue - p.commission - p.shipping - p.refund;
    p.actual_margin_pct = p.revenue > 0 ? Math.round(p.actual_profit / p.revenue * 100) : 0;
  }

  return byProduct;
}
