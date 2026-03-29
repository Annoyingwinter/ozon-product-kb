/**
 * 共享工具函数 — 零外部依赖
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function compact(value, limit = 5000) {
  return normalize(value).slice(0, limit);
}

export function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

export function slug(text) {
  const base = normalize(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").slice(0, 40);
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, "utf8");
}

export function convertWeightToKg(rawValue, unit) {
  const rawText = String(rawValue || "");
  const amount = parseNumber(rawText.match(/\d+(?:\.\d+)?/)?.[0], 0);
  if (!amount) return 0;
  const unitText = `${rawValue || ""} ${unit || ""}`;
  if (/(?:^|[^a-z])kg(?:$|[^a-z])/i.test(unitText) || /千克|公斤/.test(unitText)) return amount;
  if (/(?:^|[^a-z])g(?:$|[^a-z])/i.test(unitText) || /克/.test(unitText) || amount > 10) {
    return Number((amount / 1000).toFixed(3));
  }
  return amount;
}

export function parseCliArgs(argv, schema = {}) {
  const args = { ...schema };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key.startsWith("--") && next && !next.startsWith("--")) {
      const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[name] = next;
      i++;
    } else if (key.startsWith("--")) {
      const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[name] = true;
    }
  }
  return args;
}

/** 项目根目录 */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
export const KB_ROOT = path.join(PROJECT_ROOT, "knowledge-base");
export const OUTPUT_ROOT = path.join(PROJECT_ROOT, "output");
