import fs from "node:fs/promises";
import path from "node:path";
import { normalize as _normalize, readJson as _readJson, writeJson as _writeJson } from "./shared-utils.js";

const DEFAULT_WAIT_AFTER_GOTO_MS = 2500;
const DEFAULT_RETRY_DELAY_MS = 2000;

const V2RAYN_CONFIG_CANDIDATES = [
  path.resolve(process.env.USERPROFILE || "", "Downloads", "v2rayN-windows-64-desktop", "v2rayN-windows-64", "guiConfigs", "guiNConfig.json"),
  path.resolve("C:\\Users\\More\\Downloads\\v2rayN-windows-64-desktop\\v2rayN-windows-64\\guiConfigs\\guiNConfig.json"),
];



function normalizeHostPattern(value) {
  const text = _normalize(value).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!text) return "";
  return text.replace(/^\*\./, "");
}

export function extractHostname(value) {
  const text = _normalize(value);
  if (!text) return "";
  try {
    return new URL(text).hostname || "";
  } catch {
    return normalizeHostPattern(text);
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function buildProxyExceptionList(existing = "", hosts = []) {
  const current = String(existing || "");
  const segments = current
    .split(";")
    .map((item) => _normalize(item))
    .filter(Boolean);
  const known = new Set(segments.map((item) => item.toLowerCase()));

  const add = (entry) => {
    const normalized = _normalize(entry);
    if (!normalized) return;
    const lower = normalized.toLowerCase();
    if (known.has(lower)) return;
    segments.push(normalized);
    known.add(lower);
  };

  for (const host of hosts.map(normalizeHostPattern).filter(Boolean)) {
    add(host);
    if (!host.startsWith("*.") && !host.startsWith(".")) {
      add(`*.${host}`);
    }
  }

  return segments.join(";");
}





function isLikelyNavigationError(error) {
  const message = String(error?.message || error || "");
  return /ERR_CONNECTION|net::ERR|Navigation timeout|Timeout|ECONNRESET|ECONNREFUSED|socket hang up|closed/i.test(message);
}

async function updateV2RayNExceptions(hosts) {
  const normalizedHosts = unique(hosts.map(normalizeHostPattern));
  if (!normalizedHosts.length) {
    return { updated: false, hosts: [] };
  }

  for (const configPath of V2RAYN_CONFIG_CANDIDATES) {
    const config = await _readJson(configPath, null);
    if (!config?.SystemProxyItem) continue;

    const current = config.SystemProxyItem.SystemProxyExceptions || "";
    const updated = buildProxyExceptionList(current, normalizedHosts);
    if (updated === current) {
      return { updated: false, configPath, hosts: normalizedHosts };
    }

    const backupPath = `${configPath}.bak-${new Date().toISOString().replaceAll(":", "-")}`;
    await fs.copyFile(configPath, backupPath).catch(() => {});
    config.SystemProxyItem.SystemProxyExceptions = updated;
    await _writeJson(configPath, config);
    return { updated: true, configPath, backupPath, hosts: normalizedHosts };
  }

  return { updated: false, hosts: normalizedHosts, reason: "v2rayn_config_not_found" };
}

export async function ensureHostsDirectConnection(hosts = []) {
  try {
    return await updateV2RayNExceptions(hosts);
  } catch (error) {
    return {
      updated: false,
      hosts: unique(hosts.map(normalizeHostPattern).filter(Boolean)),
      reason: String(error?.message || error || "proxy_exception_update_failed"),
    };
  }
}

export async function gotoWithProxyFallback(page, url, options = {}) {
  const target = _normalize(url);
  if (!target) {
    throw new Error("Missing target URL.");
  }

  const waitUntil = options.waitUntil || "domcontentloaded";
  const timeout = Number(options.timeoutMs || 120000);
  const afterGotoWaitMs = Number.isFinite(Number(options.afterGotoWaitMs))
    ? Number(options.afterGotoWaitMs)
    : DEFAULT_WAIT_AFTER_GOTO_MS;
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs))
    ? Number(options.retryDelayMs)
    : DEFAULT_RETRY_DELAY_MS;
  const attempts = Math.max(1, Number(options.attempts || 3));
  const hosts = unique([target, ...(options.hosts || [])].map(extractHostname).filter(Boolean));

  let lastError = null;
  let proxyAdjusted = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(target, { waitUntil, timeout });
      if (afterGotoWaitMs > 0) {
        await page.waitForTimeout(afterGotoWaitMs);
      }
      return {
        ok: true,
        attempt,
        proxyAdjusted,
      };
    } catch (error) {
      lastError = error;
      if (!isLikelyNavigationError(error) || attempt >= attempts) {
        break;
      }

      if (options.adjustProxy !== false && !proxyAdjusted) {
        const result = await updateV2RayNExceptions(hosts);
        proxyAdjusted = Boolean(result.updated);
      }

      await page.waitForTimeout(retryDelayMs * attempt).catch(() => {});
    }
  }

  throw lastError || new Error(`Failed to navigate to ${target}`);
}
