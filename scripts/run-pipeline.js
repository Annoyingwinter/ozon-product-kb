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
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const BIZ = require("../config/business-rules.json");

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
    userDir: "",     // per-user data directory (e.g. data/5/)
    skipSeeds: false,
    skipScrape: false,
    skipInfer: false,
    only: "",
    limit: "5",
    category: "",
    count: "12",
    headless: true,
    dryRun: false,
  });

  // 如果指定了 --user-dir，覆盖全局路径
  let USER_KB_ROOT = KB_ROOT;
  let USER_OUTPUT_ROOT = OUTPUT_ROOT;
  if (args.userDir) {
    const userBase = path.resolve(args.userDir);
    USER_KB_ROOT = path.join(userBase, "knowledge-base");
    USER_OUTPUT_ROOT = path.join(userBase, "output");
    await ensureDir(path.join(USER_KB_ROOT, "products"));
    await ensureDir(USER_OUTPUT_ROOT);
    console.log(`  用户目录: ${userBase}`);
  }

  const startTime = Date.now();
  console.log(`\n  Ozon Pilot Pipeline — ${new Date().toLocaleString()}`);
  console.log(`  模式: ${args.dryRun ? "DRY RUN" : "正式执行"}`);

  // ─── Stage 1: 智能选词（Ozon数据驱动 + 词库 + AI扩展）───
  let seedsPath = args.input ? path.resolve(args.input) : null;

  if (!seedsPath) {
    console.log("\n[Stage 1] 智能选词...");
    if (args.dryRun) {
      console.log("  [dry-run] 跳过选词");
    } else {
      const poolPath = path.join(USER_KB_ROOT, "keyword-pool.json");
      const usedPath = path.join(USER_KB_ROOT, ".used-keywords.json");
      const pool = await readJson(poolPath, null);
      const used = new Set(await readJson(usedPath, []) || []);
      const limit = parseInt(args.limit) || 5;

      // === 来源1: Ozon 卖家分析数据（最有价值：看哪些品类有浏览量）===
      let ozonTrendWords = [];
      try {
        const ozonCfgPath = path.join(USER_KB_ROOT, "..", "config", "ozon-api.json");
        const ozonCfg = await readJson(ozonCfgPath, null);
        if (ozonCfg?.clientId && ozonCfg?.apiKey) {
          let dispatcher;
          try {
            const { ProxyAgent } = await import("undici");
            const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
            if (proxyUrl) dispatcher = new ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 0 });
          } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 80)); }
          const dateFrom = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
          const dateTo = new Date().toISOString().slice(0, 10);
          const r = await fetch("https://api-seller.ozon.ru/v1/analytics/data", {
            method: "POST",
            headers: { "Client-Id": String(ozonCfg.clientId), "Api-Key": ozonCfg.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              date_from: dateFrom, date_to: dateTo,
              metrics: ["hits_view", "ordered_units"],
              dimension: ["category2"], filters: [], limit: 50, offset: 0,
              sort: [{ key: "hits_view", order: "DESC" }],
            }),
            ...(dispatcher ? { dispatcher } : {}),
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json();
          // 获取有浏览量的品类名
          const cats = (d.result?.data || [])
            .filter(d => (d.metrics?.[0] || 0) > 0)
            .map(d => d.dimensions?.[0]?.name || "")
            .filter(Boolean);
          if (cats.length) console.log(`  Ozon热门品类: ${cats.slice(0, 5).join(", ")}`);
          ozonTrendWords = cats;
        }
      } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 80)); }

      // === 来源2: 词库（品类均衡采样）===
      const byCategory = {};
      if (pool?.categories) {
        for (const [catId, cat] of Object.entries(pool.categories)) {
          if (!cat.enabled) continue;
          const unused = (cat.keywords || []).filter(kw => !used.has(kw));
          if (unused.length) byCategory[catId] = { label: cat.label, keywords: unused };
        }
      }

      // === 来源3: AI 根据 Ozon 趋势生成新词（词库快耗尽时触发）===
      const totalRemaining = Object.values(byCategory).reduce((s, c) => s + c.keywords.length, 0);
      if (totalRemaining < limit * 3 && ozonTrendWords.length > 0) {
        console.log(`  词库剩余 ${totalRemaining} 个，触发 AI 扩词...`);
        try {
          const { llmJson } = await import("./lib/llm.js");
          const hotCats = ozonTrendWords.slice(0, 5).join("、");
          const existing = Object.values(byCategory).flatMap(c => c.keywords).slice(0, 20).join("、");
          const aiWords = await Promise.race([
            llmJson(`你是跨境电商选品专家（中国→俄罗斯Ozon）。

Ozon上最近热门品类: ${hotCats}
已有关键词（不要重复）: ${existing}

请生成 ${limit * 3} 个新的1688搜索关键词，要求：
1. 适合在Ozon俄罗斯站销售（轻小件、低退货、易物流）
2. 不要重复已有词
3. 格式: 2-6个中文词组合
4. 参考Ozon热门品类方向

只输出JSON数组: ["关键词1", "关键词2", ...]`, { system: "只输出JSON数组" }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("AI超时")), 60000)),
          ]);
          if (Array.isArray(aiWords)) {
            for (const kw of aiWords) {
              if (!used.has(kw) && typeof kw === "string" && kw.length >= 2) {
                // 加到词库的 gadgets 品类
                if (!byCategory.ai_generated) byCategory.ai_generated = { label: "AI生成", keywords: [] };
                byCategory.ai_generated.keywords.push(kw);
              }
            }
            console.log(`  AI 生成 ${aiWords.length} 个新词`);
            // 同步写回词库
            if (pool?.categories && aiWords.length) {
              if (!pool.categories.ai_generated) pool.categories.ai_generated = { label: "AI生成", enabled: true, keywords: [] };
              for (const kw of aiWords) {
                if (!pool.categories.ai_generated.keywords.includes(kw)) pool.categories.ai_generated.keywords.push(kw);
              }
              pool._meta.last_expanded_at = new Date().toISOString();
              await fs.writeFile(poolPath, JSON.stringify(pool, null, 2));
            }
          }
        } catch (e) {
          console.log(`  AI 扩词失败: ${e.message?.slice(0, 40)}`);
        }
      }

      // === 选词：品类均衡轮流取 ===
      const catIds = Object.keys(byCategory);
      if (!catIds.length) { console.error("词库已耗尽"); process.exit(1); }

      const selected = [];
      let round = 0;
      while (selected.length < limit) {
        const catId = catIds[round % catIds.length];
        const cat = byCategory[catId];
        if (cat.keywords.length) {
          const idx = Math.floor(Math.random() * cat.keywords.length);
          const kw = cat.keywords.splice(idx, 1)[0];
          selected.push({ keyword: kw, category: cat.label });
        }
        round++;
        if (round > limit * 3) break;
      }

      if (!selected.length) { console.error("无法获取关键词"); process.exit(1); }

      await ensureDir(USER_OUTPUT_ROOT);
      seedsPath = path.join(USER_OUTPUT_ROOT, `seeds-${timestamp()}.json`);
      await fs.writeFile(seedsPath, JSON.stringify({ seeds: selected }, null, 2));

      for (const s of selected) used.add(s.keyword);
      await fs.writeFile(usedPath, JSON.stringify([...used], null, 2));

      const remaining = Object.values(byCategory).reduce((s, c) => s + c.keywords.length, 0);
      console.log(`  选取 ${selected.length} 个关键词 (剩余 ${remaining}):`);
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
    const OZON_CONFIG_PATH = path.join(USER_KB_ROOT, "..", "config", "ozon-api.json");
    const ozonCfg = await readJson(OZON_CONFIG_PATH, {});
    const productsDir = path.join(USER_KB_ROOT, "products");
    const allDirs = await fs.readdir(productsDir).catch(() => []);
    let mappingCount = 0;

    // 加载类目树缓存（用于智能匹配）
    const catFlatPath = path.join(USER_KB_ROOT, "ozon-category-flat.json");
    let catFlat = await readJson(catFlatPath, null);
    if (!catFlat && ozonCfg.clientId && ozonCfg.apiKey) {
      // 动态获取并缓存
      try {
        let dispatcher;
        try {
          const { ProxyAgent } = await import("undici");
          const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
          if (proxyUrl) dispatcher = new ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 0 });
        } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 80)); }
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
      } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 80)); }
    }

    // 智能类目匹配: 从inferred的类目信息搜索类目树
    function matchCategory(suggestion) {
      if (!catFlat?.length || !suggestion) return null;

      // 提取最后一段作为 type_name（"Спорт > Защита > Защита колена" → "Защита колена"）
      const parts = suggestion.split(/[>\/]/).map(s => s.trim()).filter(Boolean);
      const typeName = parts[parts.length - 1] || "";
      const parentName = parts.length >= 2 ? parts[parts.length - 2] : "";

      // 策略1: 精确匹配 type_name
      const exact = catFlat.find(c => (c.name || "").toLowerCase() === typeName.toLowerCase());
      if (exact) return exact;

      // 策略2: type_name 包含匹配（处理复数/格变化）
      const tnLow = typeName.toLowerCase();
      const containsMatches = catFlat.filter(c => {
        const n = (c.name || "").toLowerCase();
        return n.includes(tnLow) || tnLow.includes(n);
      });
      // 如果有多个包含匹配，用 parent 路径过滤
      if (containsMatches.length === 1) return containsMatches[0];
      if (containsMatches.length > 1 && parentName) {
        const pLow = parentName.toLowerCase();
        const refined = containsMatches.find(c => (c.path || "").toLowerCase().includes(pLow));
        if (refined) return refined;
        return containsMatches[0]; // 取第一个
      }

      // 策略3: 词根匹配（取前5字符）+ 路径权重
      const lastWords = tnLow.split(/\s+/).filter(w => w.length >= 3);
      let bestMatch = null, bestScore = 0;
      for (const cat of catFlat) {
        const nameLow = (cat.name || "").toLowerCase();
        const pathLow = (cat.path || "").toLowerCase();
        let score = 0;
        for (const w of lastWords) {
          const stem = w.slice(0, 5);
          if (nameLow.includes(stem)) score += 10;
        }
        if (parentName && pathLow.includes(parentName.toLowerCase().slice(0, 6))) score += 5;
        if (score > bestScore) { bestScore = score; bestMatch = cat; }
      }
      return bestScore >= 10 ? bestMatch : null;
    }

    for (const slug of allDirs) {
      const dir = path.join(productsDir, slug);
      const listing = await readJson(path.join(dir, "listing.json"), null);
      const product = await readJson(path.join(dir, "product.json"), null);
      const inferred = await readJson(path.join(dir, "inferred.json"), null);
      const existing = await readJson(path.join(dir, "ozon-import-mapping.json"), null);
      if (!listing || !product?.candidates?.length) continue;
      if (product._skip) continue; // 评分 No-Go 的跳过
      if (existing?.status === "已上传" || existing?.ozon_product_id) continue;

      // 从采集数据提取价格
      const best = product.candidates[0];
      const priceNums = (best?.prices || [])
        .map(p => parseFloat(String(p).replace(/[¥￥,]/g, "")))
        .filter(n => n > 0 && n < 9999);
      const supplyCny = priceNums.length ? priceNums.sort((a, b) => a - b)[Math.floor(priceNums.length / 2)] : 0;
      if (!supplyCny) continue;

      const rawImages = (best?.images || listing.images || []).filter(u => /^https?:/i.test(u));
      const images = rawImages
        .filter(u => !/tps-\d+-\d+|32x32|48x48|64x64|72x72/i.test(u))
        .map(u => {
          // 1688 webp→jpg: .jpg_.webp → .jpg
          u = u.replace(/\.(jpg|jpeg|png)_\.webp$/i, ".$1");
          // 缩略图→原图: _284x284q90.jpg → .jpg
          u = u.replace(/_\d+x\d+q?\d*\.(jpg|jpeg|png)$/i, ".$1");
          // 防止双后缀: .jpg.jpg → .jpg
          u = u.replace(/\.(jpg|jpeg|png)\.\1$/i, ".$1");
          return u;
        })
        .filter(u => /\.(jpg|jpeg|png)$/i.test(u))
        .slice(0, 10);
      // 图片预检: 验证能访问且是图片格式
      const validImages = [];
      for (const img of images) {
        try {
          const r = await fetch(img, { method: "HEAD", signal: AbortSignal.timeout(5000) });
          if (r.ok && /image\/(jpeg|png)/i.test(r.headers.get("content-type") || "")) {
            validImages.push(img);
          }
        } catch {}
        if (validImages.length >= 8) break; // 最多8张有效图片够了
      }
      if (!validImages.length) {
        console.log(`  跳过 ${slug}: 无有效图片`);
        continue;
      }

      const weightKg = listing.weight || 0.3;
      const model = slug.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 20) + "-" + Date.now().toString(36).slice(-4);

      // 定价: 供货价加价覆盖运费关税佣金利润 (合同货币CNY)
      const MARKUP = BIZ.pricing?.markup || 3.5;
      const priceCny = Math.round(supplyCny * MARKUP * 100) / 100;
      const finalPrice = Math.max(priceCny, BIZ.pricing?.min_price_cny || 15);
      const finalOldPrice = Math.round(finalPrice * 1.3 * 100) / 100;

      // 智能类目匹配
      // 类目匹配：先搜候选，再用LLM选最准的
      let matchedCat = matchCategory(inferred?.ozon_category_suggestion);
      // 如果搜到了但不太确定（非精确匹配），用LLM二次确认
      if (matchedCat && catFlat?.length) {
        const suggestion = inferred?.ozon_category_suggestion || "";
        const parts = suggestion.split(/[>\/]/).map(s => s.trim()).filter(Boolean);
        const typeName = parts[parts.length - 1] || "";
        const isExact = (matchedCat.name || "").toLowerCase() === typeName.toLowerCase();
        if (!isExact) {
          // 搜出 top 5 候选让 LLM 选
          const tnLow = typeName.toLowerCase();
          const candidates = catFlat
            .map(c => {
              const n = (c.name || "").toLowerCase();
              let score = 0;
              for (const w of tnLow.split(/\s+/).filter(w => w.length >= 3)) {
                if (n.includes(w.slice(0, 4))) score += 5;
              }
              if ((c.path || "").toLowerCase().includes((parts[0] || "").toLowerCase().slice(0, 5))) score += 2;
              return { ...c, score };
            })
            .filter(c => c.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);

          if (candidates.length >= 2) {
            try {
              const { llmChat } = await import("./lib/llm.js");
              const productName = best?.title || product.keyword || slug;
              const catList = candidates.map((c, i) => `${i + 1}. ${c.name} (${c.path})`).join("\n");
              const answer = await Promise.race([
                llmChat(`商品: "${productName}"\n\n以下是Ozon平台的候选品类，选一个最匹配的（只回复数字）:\n${catList}`),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
              ]);
              const num = parseInt(answer?.match(/\d+/)?.[0]) - 1;
              if (num >= 0 && num < candidates.length) matchedCat = candidates[num];
            } catch (e) { if (e?.message) console.warn("    类目LLM:", e.message.slice(0, 40)); }
          }
        }
      }

      // 标题/描述质量检查
      const titleRu = listing.title_ru || listing.title_en || "";
      const descRu = inferred?.description_ru || "";
      // 跳过: 无俄语标题、含中文、太短、乱码
      if (!titleRu || titleRu.length < 10) { console.log(`  跳过 ${slug}: 标题太短`); continue; }
      if (/[\u4e00-\u9fff]/.test(titleRu)) { console.log(`  跳过 ${slug}: 标题含中文`); continue; }
      if (/undefined|null|NaN|error/i.test(titleRu)) { console.log(`  跳过 ${slug}: 标题异常`); continue; }

      const mapping = {
        slug,
        status: "可提交",
        offer_id: slug,
        title_override: titleRu,
        description_override: descRu || "",
        title_lang: "ru",
        price_override: finalPrice.toFixed(2),
        old_price_override: finalOldPrice.toFixed(2),
        supply_price_cny: supplyCny,
        currency_code: ozonCfg.currency || "CNY",
        initial_stock: BIZ.ozon_defaults?.initial_stock || 100,
        warehouse_id: ozonCfg.warehouseId || "",
        primary_image_override: validImages[0] || "",
        images_override: validImages,
        weight_override_g: Math.round(weightKg * 1000),
        depth_override_mm: 300,
        width_override_mm: 200,
        height_override_mm: 100,
        import_fields: {
          // 统一用默认类目（避免错误类目导致必填属性缺失）
          description_category_id: BIZ.ozon_defaults?.category_id || 17027937,
          type_id: BIZ.ozon_defaults?.type_id || 970896147,
          attributes: [
            { id: 9048, complex_id: 0, values: [{ dictionary_value_id: 0, value: model }] },
            { id: 85, complex_id: 0, values: [{ dictionary_value_id: BIZ.ozon_defaults?.no_brand_id || 126745801, value: "Нет бренда" }] },
          ],
        },
      };

      await fs.writeFile(path.join(dir, "ozon-import-mapping.json"), JSON.stringify(mapping, null, 2), "utf8");
      const catLabel = "默认";
      console.log(`  ✓ ${slug}: ¥${supplyCny}→¥${finalPrice} | ${catLabel}`);
      mappingCount++;
    }
    console.log(`[Stage 6] 完成: ${mappingCount} 个 mapping 生成`);
  }

  // ─── Stage 7: 自动提交到 Ozon ───
  if (!args.dryRun) {
    const OZON_CONFIG_PATH2 = path.join(USER_KB_ROOT, "..", "config", "ozon-api.json");
    const ozonCfg2 = await readJson(OZON_CONFIG_PATH2, {});
    if (ozonCfg2.clientId && ozonCfg2.apiKey) {
      console.log("\n[Stage 7] 自动提交到 Ozon...");

      // 读取所有可提交的mapping
      const productsDir2 = path.join(USER_KB_ROOT, "products");
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

        // 初始化代理（提前声明，后续所有 fetch 调用都用）
        let dispatcher;
        try {
          const { ProxyAgent } = await import("undici");
          const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
          if (proxyUrl) dispatcher = new ProxyAgent({ uri: proxyUrl, connections: 1, pipelining: 0 });
        } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 80)); }

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
        } catch (e) { if (e?.message) console.warn("  warn:", e.message.slice(0, 80)); }

        const DEFAULT_CAT = BIZ.ozon_defaults?.category_id || 17027937;
        const DEFAULT_TYPE = BIZ.ozon_defaults?.type_id || 970896147;

        // 构建import payload
        const items = readyMappings.map(m => {
          const images = [];
          if (m.primary_image_override) images.push(m.primary_image_override);
          if (m.images_override) for (const img of m.images_override) { if (img !== m.primary_image_override) images.push(img); }
          // 已存在的产品不能改类目，用原始默认类目
          const isExisting = existingOfferIds.has(m.offer_id || m.slug);
          const catId = isExisting ? DEFAULT_CAT : (m.import_fields?.description_category_id || DEFAULT_CAT);
          const typeId = isExisting ? DEFAULT_TYPE : (m.import_fields?.type_id || DEFAULT_TYPE);
          const item = {
            description_category_id: DEFAULT_CAT,
            type_id: DEFAULT_TYPE,
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
          // 加描述（如果有）
          if (m.description_override) item.description = m.description_override;
          return item;
        });

        // 提交（批次20）
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

        // ─── 上架后验证 + 自动归档有错误的 ───
        console.log(`\n  ─── 上架后验证 ───`);
        await new Promise(r => setTimeout(r, 10000));

        // 先拿 product_id 映射
        const ozonHeaders = { "Client-Id": String(ozonCfg2.clientId), "Api-Key": ozonCfg2.apiKey, "Content-Type": "application/json" };
        let offerToPid = {};
        try {
          const lr = await fetch("https://api-seller.ozon.ru/v3/product/list", {
            method: "POST", headers: ozonHeaders, body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 1000 }),
            ...(dispatcher ? { dispatcher } : {}),
          });
          const ld = await lr.json();
          for (const item of (ld.result?.items || [])) offerToPid[item.offer_id] = item.product_id;
        } catch (e) { console.warn("  产品列表查询失败:", e.message?.slice(0, 40)); }

        let realErrors = 0, realOk = 0;
        const errorPids = [];
        const submittedOfferIds = readyMappings.map(m => m.offer_id);
        for (let vi = 0; vi < submittedOfferIds.length; vi += 20) {
          const vBatch = submittedOfferIds.slice(vi, vi + 20);
          try {
            const vr = await fetch("https://api-seller.ozon.ru/v3/product/info/list", {
              method: "POST", headers: ozonHeaders, body: JSON.stringify({ offer_id: vBatch }),
              ...(dispatcher ? { dispatcher } : {}),
            });
            const vd = await vr.json();
            for (const p of (vd.result?.items || vd.items || [])) {
              const errs = (p.errors || []).filter(e => e.level === "ERROR_LEVEL_ERROR");
              if (errs.length) {
                realErrors++;
                const pid = offerToPid[p.offer_id];
                if (pid) errorPids.push(pid);
                console.log(`  ✗ ${(p.offer_id || "").slice(0, 25)} — ${errs.map(e => e.code).join(", ")}`);
              } else {
                realOk++;
              }
            }
          } catch (e) { console.warn("  验证查询失败:", e.message?.slice(0, 40)); }
        }
        console.log(`  验证结果: ${realOk} 正常 | ${realErrors} 有错误`);

        // 自动归档有错误的产品
        if (errorPids.length) {
          try {
            await fetch("https://api-seller.ozon.ru/v1/product/archive", {
              method: "POST", headers: ozonHeaders, body: JSON.stringify({ product_id: errorPids }),
              ...(dispatcher ? { dispatcher } : {}),
            });
            console.log(`  已自动归档 ${errorPids.length} 个有错误的产品`);
          } catch (e) { console.warn("  归档失败:", e.message?.slice(0, 40)); }
        }
      }
    } else {
      console.log("\n[Stage 7] 跳过自动上架 (未配置 Ozon API)");
    }
  }

  // ─── 汇总 ───
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const productDirs = await fs.readdir(path.join(USER_KB_ROOT, "products")).catch(() => []);
  let listings = 0;
  let uploaded = 0;
  for (const d of productDirs) {
    if (await readJson(path.join(USER_KB_ROOT, "products", d, "listing.json"), null)) listings++;
    const m = await readJson(path.join(USER_KB_ROOT, "products", d, "ozon-import-mapping.json"), null);
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
