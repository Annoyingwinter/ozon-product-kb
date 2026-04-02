#!/usr/bin/env node
/**
 * 全链路管道编排器
 * 按顺序执行: 种子生成 → 多平台采集 → 评分 → AI推理 → 上架草稿
 *
 * 用法:
 *   node scripts/run-pipeline.js                    # 全流程
 *   node scripts/run-pipeline.js --skip-seeds       # 跳过种子生成,用已有种子
 *   node scripts/run-pipeline.js --input seeds.json # 指定种子文件
 *   node scripts/run-pipeline.js --dry-run          # 只打印流程不执行
 *   node scripts/run-pipeline.js --skip-scrape      # 跳过采集(用已有KB)
 *   node scripts/run-pipeline.js --only 1688        # 只采集1688
 *   node scripts/run-pipeline.js --only pdd         # 只采集拼多多
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { parseCliArgs, readJson, timestamp, OUTPUT_ROOT, KB_ROOT, ensureDir } from "./lib/shared.js";

function run(script, args = [], opts = {}) {
  const scriptPath = path.resolve("scripts", script);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  执行: node ${script} ${args.join(" ")}`);
  console.log("=".repeat(60));

  try {
    execFileSync("node", [scriptPath, ...args], {
      stdio: "inherit",
      cwd: path.resolve(""),
      timeout: opts.timeout || 600_000,
      env: process.env,
    });
    return true;
  } catch (err) {
    console.error(`  ✗ ${script} 失败: ${err.message?.slice(0, 200)}`);
    return false;
  }
}

async function findLatestFile(dir, prefix) {
  await ensureDir(dir);
  const files = await fs.readdir(dir);
  const matched = files
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .reverse();
  return matched[0] ? path.join(dir, matched[0]) : null;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    input: "",
    skipSeeds: false,
    skipScrape: false,
    skipInfer: false,
    only: "",        // "1688" | "pdd" | ""(both)
    limit: "5",
    category: "",
    count: "12",
    headless: true,
    dryRun: false,
  });

  const startTime = Date.now();
  console.log(`\n  Ozon Pilot Pipeline — ${new Date().toLocaleString()}`);
  console.log(`  模式: ${args.dryRun ? "DRY RUN" : "正式执行"}`);

  // ─── Stage 1: PDD 趋势选词（直接从拼多多热销提取关键词）───
  let seedsPath = args.input ? path.resolve(args.input) : null;

  if (!seedsPath) {
    console.log("\n[Stage 1] PDD 趋势选词...");
    if (args.dryRun) {
      console.log("  [dry-run] 跳过选词");
    } else {
      const usedPath = path.join(KB_ROOT, ".used-keywords.json");
      const used = new Set(await readJson(usedPath, []) || []);
      const limit = parseInt(args.limit) || 5;

      // 搜索词: 用宽泛品类词搜PDD
      const searchQueries = [
        "家居收纳", "厨房神器", "汽车用品", "宠物用品", "运动护具",
        "办公文具", "手机配件", "清洁工具", "母婴好物", "户外装备",
        "美妆工具", "派对装饰", "园艺工具", "生活小物", "箱包配件",
      ];
      // 随机选几个搜索词
      for (let i = searchQueries.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [searchQueries[i], searchQueries[j]] = [searchQueries[j], searchQueries[i]];
      }
      const queries = searchQueries.slice(0, Math.max(3, Math.ceil(limit / 2)));

      // 启动浏览器搜PDD
      const { launchBrowser: lb, gotoSafe: gs, closeBrowser: cb } = await import("./lib/browser.js");
      const pddProfile = path.resolve(".profiles", "pdd", "browser-user-data");
      const pddStorage = path.resolve(".profiles", "pdd", "storage-state.json");
      let pddKeywords = [];

      try {
        const { context, browser } = await lb(pddProfile, { headless: true, storageStatePath: pddStorage });
        const page = context.pages()[0] || await context.newPage();

        for (const q of queries) {
          try {
            await gs(page, `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(q)}`, { wait: 4000 });
            const titles = await page.evaluate(() => {
              const cards = document.querySelectorAll('[class*="goodsList"] a, [class*="goods-list"] a, [class*="search-result"] a, [class*="SearchResult"] a');
              return Array.from(cards).slice(0, 15).map(c => {
                const el = c.querySelector('[class*="title"], [class*="name"], p, span');
                return (el?.textContent || "").replace(/\s+/g, " ").trim();
              }).filter(t => t.length >= 4);
            });
            console.log(`  PDD "${q}" → ${titles.length} 个标题`);

            // 从标题提取产品关键词
            for (const title of titles) {
              const cleaned = title
                .replace(/【.*?】/g, "").replace(/\d+[件个只套包组条]?装?/g, "")
                .replace(/[a-zA-Z\d]+/g, " ").replace(/[^\u4e00-\u9fff\s]/g, " ").trim();
              const segs = cleaned.split(/\s+/).filter(s => s.length >= 2 && s.length <= 8);
              for (const seg of segs) {
                if (/^(新款|爆款|热卖|包邮|批发|厂家|直销|现货|特价|同款|热销|推荐|正品)/.test(seg)) continue;
                if (!used.has(seg) && !pddKeywords.some(k => k.keyword === seg)) {
                  pddKeywords.push({ keyword: seg, category: q });
                }
              }
            }
          } catch {}
          await new Promise(r => setTimeout(r, 1500));
        }
        await cb({ context, browser }).catch(() => {});
      } catch (pddErr) {
        console.log(`  PDD浏览器启动失败: ${pddErr.message?.slice(0, 40)}`);
      }

      // 去重 + 选取
      // 优先选长关键词（更精准）
      pddKeywords.sort((a, b) => b.keyword.length - a.keyword.length);
      const selected = pddKeywords.slice(0, limit).map(k => ({ keyword: k.keyword, category: k.category }));

      // 如果PDD没搜到足够的词，从词库补充
      if (selected.length < limit) {
        const poolPath = path.join(KB_ROOT, "keyword-pool.json");
        const pool = await readJson(poolPath, null);
        if (pool?.categories) {
          const available = [];
          for (const cat of Object.values(pool.categories)) {
            if (!cat.enabled) continue;
            for (const kw of (cat.keywords || [])) {
              if (!used.has(kw) && !selected.some(s => s.keyword === kw)) {
                available.push({ keyword: kw, category: cat.label });
              }
            }
          }
          for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
          }
          selected.push(...available.slice(0, limit - selected.length));
        }
      }

      if (!selected.length) {
        console.error("无法获取关键词（PDD搜索失败且词库为空）");
        process.exit(1);
      }

      // 写入种子文件
      await ensureDir(OUTPUT_ROOT);
      seedsPath = path.join(OUTPUT_ROOT, `seeds-${timestamp()}.json`);
      await fs.writeFile(seedsPath, JSON.stringify({ seeds: selected }, null, 2));

      // 标记已使用
      for (const s of selected) used.add(s.keyword);
      await fs.writeFile(usedPath, JSON.stringify([...used], null, 2));

      console.log(`  选取 ${selected.length} 个关键词 (PDD: ${pddKeywords.length > limit ? limit : Math.min(pddKeywords.length, selected.length)}, 词库补充: ${Math.max(0, selected.length - Math.min(pddKeywords.length, limit))}):`);
      selected.forEach(s => console.log(`    - ${s.keyword} (${s.category})`));
    }
  }

  if (!seedsPath) {
    console.error("未找到种子文件");
    process.exit(1);
  }
  console.log(`\n  使用种子: ${path.basename(seedsPath)}`);

  // ─── Stage 2: 多平台采集 ───
  if (!args.skipScrape) {
    const scrapeArgs = ["--input", seedsPath, "--limit", args.limit, "--headless"];

    // 只从1688采集（拼多多反爬严重，仅用于趋势分析，不作为选品来源）
    console.log("\n[Stage 2/5] 1688 数据采集...");
    if (!args.dryRun) run("2a-scrape-1688.js", scrapeArgs, { timeout: 1200_000 });
    else console.log("  [dry-run] 跳过1688采集");
  } else {
    console.log("\n[Stage 2/5] 跳过采集 (--skip-scrape)");
  }

  // ─── Stage 3: 评分筛选 ───
  console.log("\n[Stage 3/5] 评分筛选...");
  if (!args.dryRun) {
    run("3-evaluate.js", ["--kb"]);
  } else {
    console.log("  [dry-run] 跳过评分");
  }

  // ─── Stage 4: AI 属性推理 ───
  if (!args.skipInfer) {
    console.log("\n[Stage 4/5] AI 属性推理...");
    if (!args.dryRun) {
      run("4-infer-attributes.js", [], { timeout: 900_000 });
    } else {
      console.log("  [dry-run] 跳过推理");
    }
  }

  // ─── Stage 5: 上架草稿 ───
  console.log("\n[Stage 5/5] 生成上架草稿...");
  if (!args.dryRun) {
    run("5-draft-listing.js", ["--all"]);
  } else {
    console.log("  [dry-run] 跳过草稿生成");
  }

  // ─── Stage 6: 自动生成 Ozon import mapping ───
  if (!args.dryRun) {
    console.log("\n[Stage 6] 生成 Ozon 上架 mapping...");
    const OZON_CONFIG_PATH = path.join(KB_ROOT, "..", "config", "ozon-api.json");
    const ozonCfg = await readJson(OZON_CONFIG_PATH, {});
    const productsDir = path.join(KB_ROOT, "products");
    const allDirs = await fs.readdir(productsDir).catch(() => []);
    let mappingCount = 0;

    // 加载类目树缓存（用于智能匹配）
    const catFlatPath = path.join(KB_ROOT, "ozon-category-flat.json");
    let catFlat = await readJson(catFlatPath, null);
    if (!catFlat && ozonCfg.clientId && ozonCfg.apiKey) {
      // 动态获取并缓存
      try {
        let dispatcher;
        try {
          const { ProxyAgent } = await import("undici");
          const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
          if (proxyUrl) dispatcher = new ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 0 });
        } catch {}
        const r = await fetch("https://api-seller.ozon.ru/v1/description-category/tree", {
          method: "POST",
          headers: { "Client-Id": String(ozonCfg.clientId), "Api-Key": ozonCfg.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ language: "DEFAULT" }),
          ...(dispatcher ? { dispatcher } : {}),
        });
        const tree = await r.json();
        function flattenTree(nodes, parentPath, parentCatId) {
          const results = [];
          for (const n of (nodes || [])) {
            if (n.type_name) {
              results.push({ catId: parentCatId, typeId: n.type_id, name: n.type_name, path: parentPath + " > " + n.type_name });
            } else if (n.category_name) {
              const p = parentPath ? parentPath + " > " + n.category_name : n.category_name;
              results.push(...flattenTree(n.children, p, n.description_category_id));
            }
          }
          return results;
        }
        catFlat = flattenTree(tree.result || [], "", null);
        await fs.writeFile(catFlatPath, JSON.stringify(catFlat));
        console.log(`  类目树已缓存: ${catFlat.length} 个类型`);
      } catch {}
    }

    // 智能类目匹配: 从inferred.ozon_category_suggestion搜索类目树
    function matchCategory(suggestion) {
      if (!catFlat?.length || !suggestion) return null;
      // 支持 > 和 / 分隔符
      const parts = suggestion.split(/[>\/]/).map(s => s.trim()).filter(Boolean);

      // 策略1: 用最后一段（最具体的类型名）直接匹配 type_name
      const lastPart = parts[parts.length - 1]?.toLowerCase() || "";
      const directMatch = catFlat.find(c => c.name?.toLowerCase() === lastPart);
      if (directMatch) return directMatch;

      // 策略2: 用最后一段的词根模糊匹配 type_name
      // 如 "Крючки и вешалки" 匹配 "Крючок" (词根)
      const lastWords = lastPart.split(/\s+/).filter(w => w.length >= 3);
      let bestMatch = null, bestScore = 0;
      for (const cat of catFlat) {
        const nameLow = (cat.name || "").toLowerCase();
        const pathLow = (cat.path || "").toLowerCase();
        let score = 0;

        // type_name 完全包含最后一段的任何词
        for (const w of lastWords) {
          // 词根匹配（去掉俄语词尾变化，取前4-5个字符）
          const stem = w.slice(0, Math.min(w.length, 5));
          if (nameLow.includes(stem)) score += 10;
        }

        // 路径包含倒数第二段的关键词（品类层级）
        if (parts.length >= 2) {
          const parentPart = parts[parts.length - 2]?.toLowerCase() || "";
          const parentWords = parentPart.split(/\s+/).filter(w => w.length >= 3);
          for (const pw of parentWords) {
            const stem = pw.slice(0, Math.min(pw.length, 5));
            if (pathLow.includes(stem)) score += 5;
          }
        }

        // 路径包含第一段（大品类）
        if (parts.length >= 3) {
          const rootPart = parts[0]?.toLowerCase() || "";
          const rootWords = rootPart.split(/\s+/).filter(w => w.length >= 3);
          for (const rw of rootWords) {
            const stem = rw.slice(0, Math.min(rw.length, 5));
            if (pathLow.includes(stem)) score += 2;
          }
        }

        if (score > bestScore) { bestScore = score; bestMatch = cat; }
      }
      return bestScore >= 10 ? bestMatch : null; // 至少type_name要匹配到一个词
    }

    for (const slug of allDirs) {
      const dir = path.join(productsDir, slug);
      const listing = await readJson(path.join(dir, "listing.json"), null);
      const product = await readJson(path.join(dir, "product.json"), null);
      const inferred = await readJson(path.join(dir, "inferred.json"), null);
      const existing = await readJson(path.join(dir, "ozon-import-mapping.json"), null);
      if (!listing || !product?.candidates?.length) continue;
      if (existing?.status === "已上传" || existing?.ozon_product_id) continue;

      // 从采集数据提取价格
      const best = product.candidates[0];
      const priceNums = (best?.prices || [])
        .map(p => parseFloat(String(p).replace(/[¥￥,]/g, "")))
        .filter(n => n > 0 && n < 9999);
      const supplyCny = priceNums.length ? priceNums.sort((a, b) => a - b)[Math.floor(priceNums.length / 2)] : 0;
      if (!supplyCny) continue;

      const rawImages = (best?.images || listing.images || []).filter(u => /^https?:/i.test(u));
      // 过滤小图标，转换为原图URL
      const images = rawImages
        .filter(u => !/tps-\d+-\d+|32x32|48x48|64x64|72x72/i.test(u))
        .map(u => u.replace(/_\d+x\d+q?\d*\.(\w+)$/, ".$1"))
        .slice(0, 10);
      const weightKg = listing.weight || 0.3;
      const model = slug.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 20) + "-" + Date.now().toString(36).slice(-4);

      // 定价: 供货价加价覆盖运费关税佣金利润 (合同货币CNY)
      const MARKUP = 3.5; // 3.5倍加价 (CNY合同，Ozon自动转卢布展示)
      const priceCny = Math.round(supplyCny * MARKUP * 100) / 100;
      const finalPrice = Math.max(priceCny, 15); // 最低15元
      const finalOldPrice = Math.round(finalPrice * 1.3 * 100) / 100;

      // 智能类目匹配
      const matchedCat = matchCategory(inferred?.ozon_category_suggestion);

      const mapping = {
        slug,
        status: "可提交",
        offer_id: slug,
        title_override: listing.title_ru || listing.title_en || best.title || "Product",
        title_lang: "ru",
        price_override: finalPrice.toFixed(2),
        old_price_override: finalOldPrice.toFixed(2),
        supply_price_cny: supplyCny,
        currency_code: ozonCfg.currency || "CNY",
        initial_stock: 100,
        warehouse_id: ozonCfg.warehouseId || "",
        primary_image_override: images[0] || "",
        images_override: images,
        weight_override_g: Math.round(weightKg * 1000),
        depth_override_mm: 300,
        width_override_mm: 200,
        height_override_mm: 100,
        import_fields: {
          description_category_id: matchedCat?.catId || listing.ozon_category_id || 17027937,
          type_id: matchedCat?.typeId || listing.ozon_type_id || 970896147,
          attributes: [
            { id: 9048, complex_id: 0, values: [{ dictionary_value_id: 0, value: model }] },
            { id: 85, complex_id: 0, values: [{ dictionary_value_id: 126745801, value: "Нет бренда" }] },
          ],
        },
      };

      await fs.writeFile(path.join(dir, "ozon-import-mapping.json"), JSON.stringify(mapping, null, 2), "utf8");
      const catLabel = matchedCat ? matchedCat.name.slice(0, 25) : "默认";
      console.log(`  ✓ ${slug}: ¥${supplyCny}→¥${finalPrice} | ${catLabel}`);
      mappingCount++;
    }
    console.log(`[Stage 6] 完成: ${mappingCount} 个 mapping 生成`);
  }

  // ─── Stage 7: 自动提交到 Ozon ───
  if (!args.dryRun) {
    const OZON_CONFIG_PATH2 = path.join(KB_ROOT, "..", "config", "ozon-api.json");
    const ozonCfg2 = await readJson(OZON_CONFIG_PATH2, {});
    if (ozonCfg2.clientId && ozonCfg2.apiKey) {
      console.log("\n[Stage 7] 自动提交到 Ozon...");

      // 读取所有可提交的mapping
      const productsDir2 = path.join(KB_ROOT, "products");
      const allDirs2 = await fs.readdir(productsDir2).catch(() => []);
      const readyMappings = [];
      for (const slug of allDirs2) {
        const m = await readJson(path.join(productsDir2, slug, "ozon-import-mapping.json"), null);
        if (m?.status === "可提交") readyMappings.push({ ...m, _dir: slug });
      }

      if (readyMappings.length === 0) {
        console.log("  无可提交产品");
      } else {
        console.log(`  找到 ${readyMappings.length} 个可提交产品`);

        // 查询已存在的offer_id（已存在的不能改类目）
        let existingOfferIds = new Set();
        try {
          const listR = await fetch("https://api-seller.ozon.ru/v3/product/list", {
            method: "POST",
            headers: { "Client-Id": String(ozonCfg2.clientId), "Api-Key": ozonCfg2.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 1000 }),
            ...(dispatcher ? { dispatcher } : {}),
          });
          const listD = await listR.json();
          existingOfferIds = new Set((listD.result?.items || []).map(i => i.offer_id));
          console.log(`  已存在产品: ${existingOfferIds.size} 个`);
        } catch {}

        const DEFAULT_CAT = 17027937;
        const DEFAULT_TYPE = 970896147;

        // 构建import payload
        const items = readyMappings.map(m => {
          const images = [];
          if (m.primary_image_override) images.push(m.primary_image_override);
          if (m.images_override) for (const img of m.images_override) { if (img !== m.primary_image_override) images.push(img); }
          // 已存在的产品不能改类目，用原始默认类目
          const isExisting = existingOfferIds.has(m.offer_id || m.slug);
          const catId = isExisting ? DEFAULT_CAT : (m.import_fields?.description_category_id || DEFAULT_CAT);
          const typeId = isExisting ? DEFAULT_TYPE : (m.import_fields?.type_id || DEFAULT_TYPE);
          return {
            description_category_id: catId,
            type_id: typeId,
            name: m.title_override || m.slug || "Product",
            offer_id: m.offer_id || m.slug,
            barcode: "",
            price: String(m.price_override || "0"),
            old_price: String(m.old_price_override || "0"),
            currency_code: m.currency_code || ozonCfg2.currency || "CNY",
            vat: "0",
            height: m.height_override_mm || 100, depth: m.depth_override_mm || 100, width: m.width_override_mm || 100,
            dimension_unit: "mm", weight: m.weight_override_g || 500, weight_unit: "g",
            images: images.slice(1), primary_image: images[0] || "",
            attributes: (m.import_fields?.attributes || []).map(a => a.values ? a : { id: a.id, complex_id: 0, values: [{ dictionary_value_id: a.dictionary_value_id || 0, value: String(a.value || "") }] }),
          };
        });

        // 提交（批次20）
        let { ProxyAgent } = {};
        let dispatcher;
        try {
          ({ ProxyAgent } = await import("undici"));
          const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
          if (proxyUrl) dispatcher = new ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 0 });
        } catch {}

        let successCount = 0, failCount = 0;
        const results = [];
        for (let i = 0; i < items.length; i += 20) {
          const batch = items.slice(i, i + 20);
          try {
            const r = await fetch("https://api-seller.ozon.ru/v3/product/import", {
              method: "POST",
              headers: { "Client-Id": String(ozonCfg2.clientId), "Api-Key": ozonCfg2.apiKey, "Content-Type": "application/json" },
              body: JSON.stringify({ items: batch }),
              signal: AbortSignal.timeout(30000),
              ...(dispatcher ? { dispatcher } : {}),
            });
            const data = await r.json();
            if (r.ok && data.result) {
              const taskId = data.result.task_id;
              console.log(`  批次 ${Math.floor(i / 20) + 1} 提交成功, task_id: ${taskId}`);

              // 等待处理结果
              await new Promise(r => setTimeout(r, 5000));
              const sr = await fetch("https://api-seller.ozon.ru/v1/product/import/info", {
                method: "POST",
                headers: { "Client-Id": String(ozonCfg2.clientId), "Api-Key": ozonCfg2.apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ task_id: taskId }),
                ...(dispatcher ? { dispatcher } : {}),
              });
              const sd = await sr.json();
              for (const si of (sd.result?.items || [])) {
                const errs = (si.errors || []).filter(e => e.code);
                const ok = (si.status === "imported" || si.status === "skipped") && errs.length === 0;
                if (ok) successCount++; else failCount++;
                results.push({ offer_id: si.offer_id, status: si.status, product_id: si.product_id, errors: errs.map(e => e.code).join(", ") });
                // 更新mapping状态
                const mDir = readyMappings.find(m => m.offer_id === si.offer_id)?._dir;
                if (mDir) {
                  const mPath = path.join(productsDir2, mDir, "ozon-import-mapping.json");
                  const mData = await readJson(mPath, null);
                  if (mData) {
                    mData.status = ok ? "已上传" : mData.status;
                    if (si.product_id) mData.ozon_product_id = si.product_id;
                    if (taskId) mData.ozon_task_id = taskId;
                    if (errs.length) mData.ozon_import_errors = errs.map(e => e.code + ": " + (e.message || "")).join("; ");
                    mData.ozon_import_at = new Date().toISOString();
                    await fs.writeFile(mPath, JSON.stringify(mData, null, 2), "utf8");
                  }
                }
              }
            } else {
              const errMsg = data.message || "API错误";
              console.log(`  批次失败: ${errMsg}`);
              batch.forEach(b => { failCount++; results.push({ offer_id: b.offer_id, status: "error", errors: errMsg }); });
            }
          } catch (err) {
            console.log(`  批次异常: ${err.message?.slice(0, 60)}`);
            batch.forEach(b => { failCount++; results.push({ offer_id: b.offer_id, status: "error", errors: err.message?.slice(0, 60) }); });
          }
        }

        // 输出上架清单
        console.log(`\n  ─── 上架清单 ───`);
        console.log(`  成功: ${successCount} | 失败: ${failCount}`);
        for (const r of results) {
          const icon = r.status === "imported" && !r.errors ? "✓" : "✗";
          console.log(`  ${icon} ${r.offer_id} → ${r.status}${r.errors ? " (" + r.errors + ")" : ""}`);
        }
      }
    } else {
      console.log("\n[Stage 7] 跳过自动上架 (未配置 Ozon API)");
    }
  }

  // ─── 汇总 ───
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const productDirs = await fs.readdir(path.join(KB_ROOT, "products")).catch(() => []);
  let listings = 0;
  let uploaded = 0;
  for (const d of productDirs) {
    if (await readJson(path.join(KB_ROOT, "products", d, "listing.json"), null)) listings++;
    const m = await readJson(path.join(KB_ROOT, "products", d, "ozon-import-mapping.json"), null);
    if (m?.status === "已上传" || m?.ozon_product_id) uploaded++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Pipeline 完成`);
  console.log(`  耗时: ${elapsed}s`);
  console.log(`  知识库商品: ${productDirs.length}`);
  console.log(`  上架草稿: ${listings}`);
  console.log(`  已上架Ozon: ${uploaded}`);
  console.log("=".repeat(60));
}

main().catch(err => { console.error(err); process.exit(1); });
