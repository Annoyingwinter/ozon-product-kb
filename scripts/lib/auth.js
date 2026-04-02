/**
 * JWT + password hashing — zero external dependencies.
 * Uses Node.js built-in crypto only.
 */
import { randomBytes, scryptSync, createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.JWT_SECRET ?? (() => {
  const s = randomBytes(32).toString("hex");
  console.warn("[auth] JWT_SECRET not set — using random key (tokens won't survive restart)");
  return s;
})();

const b64url = (buf) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString("base64url");
const b64decode = (str) => Buffer.from(str, "base64url");

// ─── Password ────────────────────────────────────────────────────────

/**
 * Hash a plaintext password (scrypt + random salt).
 * @param {string} plain
 * @returns {string} hex string: 32-byte salt + 64-byte hash
 */
export function hashPassword(plain) {
  const salt = randomBytes(32);
  const hash = scryptSync(plain, salt, 64);
  return Buffer.concat([salt, hash]).toString("hex");
}

/**
 * Verify a plaintext password against a stored hash.
 * @param {string} plain
 * @param {string} stored - hex string from hashPassword()
 * @returns {boolean}
 */
export function verifyPassword(plain, stored) {
  const buf = Buffer.from(stored, "hex");
  const salt = buf.subarray(0, 32);
  const original = buf.subarray(32);
  const derived = scryptSync(plain, salt, 64);
  return timingSafeEqual(original, derived);
}

// ─── JWT ─────────────────────────────────────────────────────────────

const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function sign(data) {
  return b64url(createHmac("sha256", SECRET).update(data).digest());
}

/**
 * Create a signed JWT.
 * @param {{ userId: number, email: string }} payload
 * @param {number} [expiresInHours=72]
 * @returns {string} JWT token
 */
export function signToken(payload, expiresInHours = 72) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    sub: payload.userId, email: payload.email, iat: now,
    exp: now + expiresInHours * 3600,
  }));
  const sig = sign(`${HEADER}.${body}`);
  return `${HEADER}.${body}.${sig}`;
}

/**
 * Verify and decode a JWT.
 * @param {string} token
 * @returns {object|null} decoded payload, or null if invalid/expired
 */
export function verifyToken(token) {
  try {
    const [h, p, s] = token.split(".");
    if (sign(`${h}.${p}`) !== s) return null;
    const payload = JSON.parse(b64decode(p).toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

/**
 * Express-compatible auth helper — extracts Bearer token from req.
 * @param {{ headers?: Record<string,string> }} req
 * @returns {{ userId: number, email: string }|null}
 */
export function authMiddleware(req) {
  const auth = req.headers?.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const payload = verifyToken(auth.slice(7));
  if (!payload) return null;
  return { userId: payload.sub, email: payload.email };
}
