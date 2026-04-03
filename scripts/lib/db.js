/**
 * SQLite database layer (better-sqlite3, ESM).
 * Database file: data/ozon-pilot.db
 */
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../data/ozon-pilot.db");

let _db;

/** @returns {import('better-sqlite3').Database} singleton db instance */
export function getDb() {
  if (_db) return _db;
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now')),
      plan          TEXT DEFAULT 'free',
      product_quota INTEGER DEFAULT 10,
      products_used INTEGER DEFAULT 0,
      is_admin      INTEGER DEFAULT 0,
      invite_code   TEXT,
      api_calls     INTEGER DEFAULT 0,
      llm_tokens    INTEGER DEFAULT 0
    )
  `);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code       TEXT PRIMARY KEY,
      plan       TEXT DEFAULT 'basic',
      quota      INTEGER DEFAULT 100,
      max_uses   INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT,
      tokens     INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS product_financials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      offer_id    TEXT NOT NULL,
      units_sold  INTEGER DEFAULT 0,
      revenue_rub REAL DEFAULT 0,
      commission_rub REAL DEFAULT 0,
      shipping_rub REAL DEFAULT 0,
      refund_rub  REAL DEFAULT 0,
      actual_profit_rub REAL DEFAULT 0,
      actual_margin_pct REAL DEFAULT 0,
      period_from TEXT,
      period_to   TEXT,
      synced_at   TEXT DEFAULT (datetime('now'))
    )
  `);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      offer_id    TEXT NOT NULL,
      supplier_url TEXT,
      cost_cny    REAL DEFAULT 0,
      qty         INTEGER DEFAULT 1,
      shipping_cny REAL DEFAULT 0,
      note        TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `);
  return _db;
}

/**
 * Create a new user.
 * @param {string} email
 * @param {string} passwordHash - pre-hashed password string
 * @returns {{ id: number, email: string, plan: string, product_quota: number, products_used: number }}
 * @throws on duplicate email
 */
export function createUser(email, passwordHash, inviteCode) {
  const db = getDb();
  let plan = "free", quota = 10;

  // 验证邀请码
  if (inviteCode) {
    const code = db.prepare("SELECT * FROM invite_codes WHERE code = ?").get(inviteCode);
    if (!code) throw new Error("邀请码无效");
    if (code.used_count >= code.max_uses) throw new Error("邀请码已用完");
    plan = code.plan;
    quota = code.quota;
    db.prepare("UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?").run(inviteCode);
  }

  // 管理员邮箱列表（环境变量或硬编码）
  const adminEmails = (process.env.ADMIN_EMAILS || "3274834195@qq.com").split(",").map(s => s.trim().toLowerCase());
  const isAdmin = adminEmails.includes(email.toLowerCase()) ? 1 : 0;
  const info = db.prepare("INSERT INTO users (email, password_hash, plan, product_quota, is_admin, invite_code) VALUES (?, ?, ?, ?, ?, ?)").run(email, passwordHash, plan, quota, isAdmin, inviteCode || null);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

/**
 * Find user by email.
 * @param {string} email
 * @returns {object|null}
 */
export function getUserByEmail(email) {
  return getDb().prepare("SELECT * FROM users WHERE email = ?").get(email) ?? null;
}

/**
 * Find user by id.
 * @param {number} id
 * @returns {object|null}
 */
export function getUserById(id) {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

/**
 * Increment the products_used counter for a user.
 * @param {number} userId
 */
export function incrementProductsUsed(userId) {
  getDb().prepare("UPDATE users SET products_used = products_used + 1 WHERE id = ?").run(userId);
}

/**
 * Reset products_used to 0 for every user (monthly cron).
 */
export function resetMonthlyQuota() {
  getDb().prepare("UPDATE users SET products_used = 0").run();
}

// ─── 管理员函数 ───

/** 获取所有用户列表（管理员用） */
export function listAllUsers() {
  return getDb().prepare("SELECT id, email, plan, product_quota, products_used, is_admin, api_calls, llm_tokens, created_at FROM users ORDER BY id").all();
}

/** 更新用户套餐/配额 */
export function updateUserPlan(userId, plan, quota) {
  getDb().prepare("UPDATE users SET plan = ?, product_quota = ? WHERE id = ?").run(plan, quota, userId);
}

/** 记录 API 调用 */
export function logUsage(userId, action, detail, tokens = 0) {
  getDb().prepare("INSERT INTO usage_log (user_id, action, detail, tokens) VALUES (?, ?, ?, ?)").run(userId, action, detail, tokens);
  getDb().prepare("UPDATE users SET api_calls = api_calls + 1, llm_tokens = llm_tokens + ? WHERE id = ?").run(tokens, userId);
}

/** 获取用户用量明细 */
export function getUserUsage(userId, limit = 50) {
  return getDb().prepare("SELECT * FROM usage_log WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit);
}

/** 获取全局用量统计 */
export function getUsageStats() {
  const db = getDb();
  return {
    total_users: db.prepare("SELECT COUNT(*) as c FROM users").get().c,
    total_api_calls: db.prepare("SELECT SUM(api_calls) as c FROM users").get().c || 0,
    total_llm_tokens: db.prepare("SELECT SUM(llm_tokens) as c FROM users").get().c || 0,
    active_today: db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM usage_log WHERE created_at > datetime('now', '-1 day')").get().c,
  };
}

// ─── 邀请码 ───

/** 创建邀请码 */
export function createInviteCode(code, plan, quota, maxUses, createdBy) {
  getDb().prepare("INSERT INTO invite_codes (code, plan, quota, max_uses, created_by) VALUES (?, ?, ?, ?, ?)").run(code, plan, quota, maxUses, createdBy);
}

/** 列出所有邀请码 */
export function listInviteCodes() {
  return getDb().prepare("SELECT * FROM invite_codes ORDER BY created_at DESC").all();
}

// ─── 财务数据 ───

/** 更新/插入产品财务数据 */
export function upsertFinancials(userId, data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO product_financials
      (user_id, offer_id, units_sold, revenue_rub, commission_rub, shipping_rub, refund_rub, actual_profit_rub, actual_margin_pct, period_from, period_to, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = db.transaction((items) => {
    for (const p of items) {
      stmt.run(userId, p.offer_id, p.units_sold, p.revenue, p.commission, p.shipping, p.refund, p.actual_profit, p.actual_margin_pct, p.period_from || "", p.period_to || "");
    }
  });
  tx(Array.isArray(data) ? data : [data]);
}

/** 查询所有产品财务汇总 */
export function getFinancials(userId) {
  return getDb().prepare("SELECT * FROM product_financials WHERE user_id = ? ORDER BY actual_profit_rub DESC").all(userId);
}

/** 查询单品利润 */
export function getProductProfit(userId, offerId) {
  return getDb().prepare("SELECT * FROM product_financials WHERE user_id = ? AND offer_id = ?").get(userId, offerId) || null;
}

// ─── 采购记录 ───

/** 添加采购记录 */
export function addPurchaseLog(userId, data) {
  return getDb().prepare(
    "INSERT INTO purchase_log (user_id, offer_id, supplier_url, cost_cny, qty, shipping_cny, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(userId, data.offer_id, data.supplier_url || "", data.cost_cny || 0, data.qty || 1, data.shipping_cny || 0, data.note || "");
}

/** 查询采购记录 */
export function getPurchaseLog(userId, offerId) {
  if (offerId) return getDb().prepare("SELECT * FROM purchase_log WHERE user_id = ? AND offer_id = ? ORDER BY created_at DESC").all(userId, offerId);
  return getDb().prepare("SELECT * FROM purchase_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(userId);
}

/** 按offer_id汇总采购成本 */
export function getPurchaseCosts(userId) {
  return getDb().prepare("SELECT offer_id, SUM(cost_cny * qty) as total_cost_cny, SUM(qty) as total_qty FROM purchase_log WHERE user_id = ? GROUP BY offer_id").all(userId);
}
