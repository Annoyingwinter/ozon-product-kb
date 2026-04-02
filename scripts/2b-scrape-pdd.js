#!/usr/bin/env node
/**
 * Stage 2b: 拼多多数据采集
 * 拼多多详情页不需要登录，比1688更友好
 *
 * 策略: 移动端H5页面 → 搜索API → 详情页DOM抓取
 * 用法: node scripts/2b-scrape-pdd.js --input output/seeds-xxx.json [--limit 5]
 */
import path from "node:path";
import {
  parseCliArgs, readJson, writeJson, normalize, slug, timestamp,
  KB_ROOT, ensureDir, parseNumber,
} from "./lib/shared.js";
import { launchBrowser, gotoSafe, detectPageType, closeBrowser } from "./lib/browser.js";

const PDD_PROFILE = path.resolve(".profiles", "pdd", "browser-user-data");
const PDD_SEARCH_URL = "https://mobile.yangkeduo.com/search_result.html?search_key=";
const PDD_DETAIL_URL = "https://mobile.yangkeduo.com/goods2.html?goods_id=";

// ─── 搜索页采集 ───
async function searchPdd(page, keyword) {
  const url = `${PDD_SEARCH_URL}${encodeURIComponent(keyword)}`;
  await gotoSafe(page, url, { wait: 4000 });

  // 拼多多搜索结果在DOM中
  return page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    // 尝试从 window.__NEXT_DATA__ 或 DOM 中获取
    const items = [];

    // 方法1: DOM 抓取
    const cards = document.querySelectorAll('[class*="goodsList"] a, [class*="goods-list"] a, [class*="search-result"] a');
    for (const card of Array.from(cards).slice(0, 20)) {
      const href = card.href || "";
      const goodsIdMatch = href.match(/goods_id=(\d+)/);
      if (!goodsIdMatch) continue;

      const img = card.querySelector("img");
      const priceEl = card.querySelector('[class*="price"]');
      const titleEl = card.querySelector('[class*="title"], [class*="name"], p, span');
      const salesEl = card.querySelector('[class*="sales"], [class*="sold"]');

      items.push({
        goods_id: goodsIdMatch[1],
        title: clean(titleEl?.textContent || img?.alt || ""),
        price: clean(priceEl?.textContent || ""),
        sales: clean(salesEl?.textContent || ""),
        image: img?.src || "",
        url: `https://mobile.yangkeduo.com/goods2.html?goods_id=${goodsIdMatch[1]}`,
      });
    }
    return items;
  });
}

// ─── 详情页抓取(无需登录) ───
async function scrapeDetail(page, goodsId) {
  const url = `${PDD_DETAIL_URL}${goodsId}`;
  await gotoSafe(page, url, { wait: 5000 });

  // 等待主要内容加载
  await page.waitForSelector('[class*="goods-info"], [class*="detail"], h1', { timeout: 10_000 }).catch(() => {});

  return page.evaluate(() => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();

    // 标题
    const title = clean(
      document.querySelector('[class*="goods-name"], [class*="title"] span, h1')?.textContent ||
      document.title
    );

    // 价格
    const priceEl = document.querySelector('[class*="price"], [class*="Price"]');
    const priceText = clean(priceEl?.textContent || "");

    // 图片
    const images = Array.from(new Set(
      Array.from(document.querySelectorAll('img[src*="t00img"], img[src*="img.pddpic"]'))
        .map(img => (img.src || "").replace(/\?.*$/, ""))
        .filter(url => url && !/icon|logo|avatar/i.test(url))
    )).slice(0, 15);

    // 属性/规格
    const specEls = document.querySelectorAll('[class*="spec"] [class*="item"], [class*="sku"] [class*="item"], [class*="attr"] li');
    const attributes = Array.from(specEls).map(el => {
      const text = clean(el.textContent);
      const match = text.match(/^(.+?)[：:]\s*(.+)$/);
      return match ? { key: match[1], value: match[2] } : null;
    }).filter(Boolean);

    // SKU 变体
    const skuGroups = document.querySelectorAll('[class*="sku-group"], [class*="spec-group"]');
    const variants = Array.from(skuGroups).map(group => {
      const label = clean(group.querySelector('[class*="label"], [class*="name"]')?.textContent || "");
      const values = Array.from(group.querySelectorAll('[class*="item"], [class*="value"], button, span'))
        .map(el => clean(el.textContent))
        .filter(v => v && v.length < 30);
      return { label, values: [...new Set(values)] };
    }).filter(g => g.label && g.values.length);

    // 销量
    const salesEl = document.querySelector('[class*="sales"], [class*="sold"]');
    const sales = clean(salesEl?.textContent || "");

    // 店铺名
    const shopEl = document.querySelector('[class*="shop-name"], [class*="mall-name"], [class*="store"]');
    const shopName = clean(shopEl?.textContent || "");

    return {
      title, price: priceText, images, attributes, variants, sales, shop_name: shopName,
      url: location.href,
    };
  });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    input: "", limit: "5", headless: false, topN: "3",
  });
  if (!args.input) throw new Error("需要 --input <seeds.json>");

  const seeds = await readJson(path.resolve(args.input));
  const products = (seeds?.products || seeds?.seeds || seeds || [])
    .filter(p => (p.go_or_no_go || "Go") !== "No-Go");
  const limit = parseInt(args.limit) || 5;
  const topN = parseInt(args.topN) || 3;

  console.log(`[Stage 2b] 拼多多采集: ${Math.min(products.length, limit)} 个商品`);

  // 拼多多用移动端UA
  const { context, browser } = await launchBrowser(PDD_PROFILE, {
    headless: !!args.headless,
  });

  const results = [];
  for (const product of products.slice(0, limit)) {
    const keyword = product.keyword || product.name;
    console.log(`\n  搜索: "${keyword}"`);
    const page = await context.newPage();

    try {
      const candidates = await searchPdd(page, keyword);
      console.log(`    找到 ${candidates.length} 个候选`);

      const details = [];
      for (const candidate of candidates.slice(0, topN)) {
        console.log(`    抓取: goods_id=${candidate.goods_id}`);
        const detail = await scrapeDetail(page, candidate.goods_id);
        if (detail) {
          details.push({ ...detail, search_title: candidate.title, search_price: candidate.price });
        }
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
      }

      // 保存 — 追加到已有的 product.json 或新建
      const productSlug = slug(keyword);
      const productDir = path.join(KB_ROOT, "products", productSlug);
      const existing = await readJson(path.join(productDir, "product.json"), null);

      const pddData = {
        source_platform: "pdd",
        keyword,
        scraped_at: new Date().toISOString(),
        candidates: details.map((d, i) => ({
          rank: i + 1,
          title: d.title,
          source_url: d.url,
          price: d.price,
          sales: d.sales,
          attributes: Object.fromEntries(d.attributes.map(a => [a.key, a.value])),
          variants: d.variants,
          images: d.images,
          main_image: d.images[0] || "",
          shop_name: d.shop_name,
        })),
      };

      if (existing) {
        existing.pdd = pddData;
        await writeJson(path.join(productDir, "product.json"), existing);
      } else {
        await writeJson(path.join(productDir, "product.json"), {
          spu_id: productSlug,
          seed: product,
          keyword,
          pdd: pddData,
        });
      }

      results.push({ keyword, slug: productSlug, pddCandidates: details.length });
      console.log(`    ✓ 保存: ${productDir}`);
    } catch (err) {
      console.error(`    ✗ 失败: ${err.message}`);
      results.push({ keyword, error: err.message });
    } finally {
      await page.close().catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
  }

  await closeBrowser({ context, browser });
  const outputPath = path.join("output", `scrape-pdd-${timestamp()}.json`);
  await writeJson(outputPath, { source: "pdd", results });
  console.log(`\n[Stage 2b] 完成: ${results.filter(r => !r.error).length}/${results.length} 成功`);
}

main().catch(err => { console.error(err); process.exit(1); });
