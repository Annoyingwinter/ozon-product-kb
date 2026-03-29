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
    headless: false,
    dryRun: false,
  });

  const startTime = Date.now();
  console.log(`\n  Ozon Pilot Pipeline — ${new Date().toLocaleString()}`);
  console.log(`  模式: ${args.dryRun ? "DRY RUN" : "正式执行"}`);

  // ─── Stage 1: 种子生成 ───
  let seedsPath = args.input ? path.resolve(args.input) : null;

  if (!args.skipSeeds && !seedsPath) {
    console.log("\n[Stage 1/5] 生成种子商品...");
    if (args.dryRun) {
      console.log("  [dry-run] 跳过种子生成");
    } else {
      const seedArgs = ["--count", args.count];
      if (args.category) seedArgs.push("--category", args.category);
      const ok = run("1-generate-seeds.js", seedArgs);
      if (!ok) { console.error("种子生成失败，中止"); process.exit(1); }
    }
    seedsPath = await findLatestFile(OUTPUT_ROOT, "seeds-");
  }

  if (!seedsPath) {
    // 尝试找最近的种子文件
    seedsPath = await findLatestFile(OUTPUT_ROOT, "seeds-");
  }

  if (!seedsPath) {
    console.error("未找到种子文件。请先运行 Stage 1 或用 --input 指定");
    process.exit(1);
  }
  console.log(`\n  使用种子: ${path.basename(seedsPath)}`);

  // ─── Stage 2: 多平台采集 ───
  if (!args.skipScrape) {
    const scrapeArgs = ["--input", seedsPath, "--limit", args.limit];
    if (args.headless) scrapeArgs.push("--headless");

    const do1688 = !args.only || args.only === "1688";
    const doPdd = !args.only || args.only === "pdd";

    if (do1688) {
      console.log("\n[Stage 2a/5] 1688 数据采集...");
      if (!args.dryRun) run("2a-scrape-1688.js", scrapeArgs, { timeout: 1200_000 });
      else console.log("  [dry-run] 跳过1688采集");
    }

    if (doPdd) {
      console.log("\n[Stage 2b/5] 拼多多数据采集...");
      if (!args.dryRun) run("2b-scrape-pdd.js", scrapeArgs, { timeout: 1200_000 });
      else console.log("  [dry-run] 跳过拼多多采集");
    }
  } else {
    console.log("\n[Stage 2/5] 跳过采集 (--skip-scrape)");
  }

  // ─── Stage 3: 评分筛选 ───
  console.log("\n[Stage 3/5] 评分筛选...");
  if (!args.dryRun) {
    run("3-evaluate.js", ["--input", seedsPath]);
  } else {
    console.log("  [dry-run] 跳过评分");
  }

  // ─── Stage 4: AI 属性推理 ───
  if (!args.skipInfer) {
    console.log("\n[Stage 4/5] AI 属性推理...");
    if (!args.dryRun) {
      run("4-infer-attributes.js", ["--all"]);
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

  // ─── 汇总 ───
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const productDirs = await fs.readdir(path.join(KB_ROOT, "products")).catch(() => []);
  let listings = 0;
  for (const d of productDirs) {
    if (await readJson(path.join(KB_ROOT, "products", d, "listing.json"), null)) listings++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Pipeline 完成`);
  console.log(`  耗时: ${elapsed}s`);
  console.log(`  知识库商品: ${productDirs.length}`);
  console.log(`  上架草稿: ${listings}`);
  console.log(`  输出目录: ${OUTPUT_ROOT}`);
  console.log(`  知识库: ${KB_ROOT}`);
  console.log("=".repeat(60));
}

main().catch(err => { console.error(err); process.exit(1); });
