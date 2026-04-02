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
      products_used INTEGER DEFAULT 0
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
export function createUser(email, passwordHash) {
  const db = getDb();
  const info = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, passwordHash);
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
