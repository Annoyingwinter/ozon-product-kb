import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const MOJIBAKE_HINT_RE = /[瀹鍙鏀绾鎵閫鍏鐗浠鏋澶鍚鍖鍒鐢鍖鎴鍑鐝鏂鐮鎶鍜瑁璐鏉鍝鍢鍛鍥鍚閮锛銆锟�]/u;
const mojibakeCache = new Map();

function countSuspiciousChars(text) {
  const value = String(text || "");
  let score = 0;
  for (const char of value) {
    if (MOJIBAKE_HINT_RE.test(char)) {
      score += 3;
    } else if (char === "�") {
      score += 8;
    }
  }
  return score;
}

function repairWindows936RoundTrip(value) {
  if (process.platform !== "win32") return value;

  try {
    const input = String(value || "");
    const payload = Buffer.from(input, "utf16le").toString("base64");
    const script = [
      "$input = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:CODEX_MOJIBAKE_PAYLOAD))",
      "$bytes = [System.Text.Encoding]::GetEncoding(936).GetBytes($input)",
      "$output = [System.Text.Encoding]::UTF8.GetString($bytes)",
      "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($output))",
    ].join("; ");
    const repairedB64 = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          CODEX_MOJIBAKE_PAYLOAD: payload,
        },
      },
    ).trim();
    if (!repairedB64) return value;
    return Buffer.from(repairedB64, "base64").toString("utf8");
  } catch {
    return value;
  }
}

function cleanupRecoveredText(value) {
  let text = normalize(value).replace(/\uFFFD+/g, "").trim();
  if (!text) return text;

  const openParenCount = (text.match(/（/g) || []).length;
  const closeParenCount = (text.match(/）/g) || []).length;
  if (text.endsWith("?") && openParenCount > closeParenCount) {
    text = `${text.slice(0, -1)}）`;
  }

  if (text.endsWith("?") && !/[?？]{2,}/.test(text)) {
    text = text.slice(0, -1).trim();
  }

  return text;
}

export function repairMojibakeText(value) {
  const original = normalize(value);
  if (!original) return original;
  if (!MOJIBAKE_HINT_RE.test(original) && !original.includes("�")) {
    return original;
  }

  if (mojibakeCache.has(original)) {
    return mojibakeCache.get(original);
  }

  const repaired = cleanupRecoveredText(repairWindows936RoundTrip(original));
  const finalValue =
    repaired &&
    repaired !== original &&
    countSuspiciousChars(repaired) < countSuspiciousChars(original)
      ? repaired
      : original;

  mojibakeCache.set(original, finalValue);
  return finalValue;
}

export function repairDeepMojibake(value) {
  if (Array.isArray(value)) {
    return value.map((item) => repairDeepMojibake(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairDeepMojibake(item)]),
    );
  }
  if (typeof value === "string") {
    return repairMojibakeText(value);
  }
  return value;
}

export function compact(value) {
  return normalize(value);
}

export function compactText(value, limit = 5000) {
  return normalize(value).slice(0, limit);
}

export function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
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

export function convertWeightToKg(rawValue, unit) {
  const rawText = String(rawValue || "");
  const amount = parseNumber(rawText.match(/\d+(?:\.\d+)?/)?.[0], 0);
  if (!amount) return 0;
  const unitText = `${rawValue || ""} ${unit || ""}`;
  if (/(?:^|[^a-z])kg(?:$|[^a-z])/i.test(unitText) || /千克|公斤/.test(unitText)) {
    return amount;
  }
  if (/(?:^|[^a-z])g(?:$|[^a-z])/i.test(unitText) || /克/.test(unitText) || amount > 10) {
    return Number((amount / 1000).toFixed(3));
  }
  return amount;
}

export function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  const n = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(n)) return true;
  if (["0", "false", "no", "n", "off"].includes(n)) return false;
  return defaultValue;
}
