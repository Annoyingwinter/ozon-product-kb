/**
 * LLM 调用封装
 * 优先级: Claude CLI (零成本) > DeepSeek > 通义千问 > Claude API
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROVIDERS = {
  claude: {
    url: "https://api.anthropic.com/v1/messages",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }),
    body: (prompt, opts) => ({
      model: opts.model || "claude-sonnet-4-20250514",
      max_tokens: opts.maxTokens || 4096,
      messages: [{ role: "user", content: prompt }],
      ...(opts.system ? { system: opts.system } : {}),
    }),
    extract: (res) => res.content?.[0]?.text || "",
  },
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "content-type": "application/json" }),
    body: (prompt, opts) => ({
      model: opts.model || "deepseek-chat",
      max_tokens: opts.maxTokens || 4096,
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: prompt },
      ],
    }),
    extract: (res) => res.choices?.[0]?.message?.content || "",
  },
  qwen: {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "content-type": "application/json" }),
    body: (prompt, opts) => ({
      model: opts.model || "qwen-plus",
      max_tokens: opts.maxTokens || 4096,
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.system }] : []),
        { role: "user", content: prompt },
      ],
    }),
    extract: (res) => res.choices?.[0]?.message?.content || "",
  },
};

// ─── Claude CLI 调用 (零成本，利用当前 Claude Code 会话) ───
function callClaudeCli(prompt, opts = {}) {
  const fullPrompt = opts.system
    ? `${opts.system}\n\n---\n\n${prompt}`
    : prompt;

  // 写入临时文件避免命令行参数过长
  const tmpFile = path.join(os.tmpdir(), `ozon-pilot-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, fullPrompt, "utf8");

  try {
    // 用shell管道传prompt（避免Windows的execFileSync参数限制）
    const escapedPath = tmpFile.replace(/\//g, "\\");
    const cmd = process.platform === "win32"
      ? `type "${escapedPath}" | claude -p - --output-format text`
      : `cat "${tmpFile}" | claude -p - --output-format text`;
    const result = execSync(cmd, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      shell: true,
    });
    return result.trim();
  } catch (err) {
    throw new Error(`Claude CLI 不可用: ${err.message?.slice(0, 100)}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function isClaudeCliAvailable() {
  try {
    const claudeBin = process.platform === "win32" ? "claude.cmd" : "claude";
    execFileSync(claudeBin, ["--version"], {
      encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── 自动选择 provider ───
// 优先级: Claude CLI > DeepSeek > 通义 > Claude API
function autoDetect() {
  if (process.env.DEEPSEEK_API_KEY) return { provider: "deepseek", key: process.env.DEEPSEEK_API_KEY };
  if (process.env.DASHSCOPE_API_KEY) return { provider: "qwen", key: process.env.DASHSCOPE_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) return { provider: "claude", key: process.env.ANTHROPIC_API_KEY };
  return null;
}

/**
 * 调用 LLM 返回文本
 */
export async function llmChat(prompt, opts = {}) {
  // 1. 如果指定了 provider + key，直接用API
  const detected = autoDetect();
  if (opts.apiKey || detected) {
    const providerName = opts.provider || detected?.provider || "claude";
    const apiKey = opts.apiKey || detected?.key;
    const provider = PROVIDERS[providerName];
    if (!provider) throw new Error(`不支持的 LLM provider: ${providerName}`);

    const res = await fetch(provider.url, {
      method: "POST",
      headers: provider.headers(apiKey),
      body: JSON.stringify(provider.body(prompt, opts)),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    return provider.extract(json);
  }

  // 2. Fallback: Claude CLI
  console.log("  [llm] 无 API Key，使用 Claude CLI...");
  return callClaudeCli(prompt, opts);
}

/**
 * 调用 LLM 返回 JSON (自动提取 JSON 块)
 */
export async function llmJson(prompt, opts = {}) {
  const text = await llmChat(prompt, opts);
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/) || text.match(/(\[[\s\S]*\])/);
  if (!jsonMatch) throw new Error(`LLM 返回中未找到 JSON:\n${text.slice(0, 300)}`);
  return JSON.parse(jsonMatch[1]);
}

/**
 * 检测当前可用的 LLM provider
 */
export function detectProvider() {
  const api = autoDetect();
  if (api) return { type: "api", provider: api.provider };
  if (isClaudeCliAvailable()) return { type: "cli", provider: "claude-cli" };
  return { type: "none", provider: null };
}
