// Passwords, session tokens and login throttling.
import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

export const SESSION_COOKIE = "unspoken_session";
export const SESSION_DAYS = 30;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** "scrypt$N$r$p$salt$hash" (salt and hash in base64). */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

/** A random password-shaped string for admin resets and invite codes. */
export function randomCode(bytes = 9) {
  return randomBytes(bytes).toString("base64url");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

/** Only this hash is stored, so a leaked database cannot be used to log in. */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validPassword(password) {
  return typeof password === "string" && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

/**
 * Counts failed logins per key (email, and separately client address) in a sliding window.
 * After `max` failures the key is blocked until the window passes.
 */
export function createThrottle({ max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const recent = (key, now) => (failures.get(key) || []).filter((t) => now - t < windowMs);
  return {
    blocked(key, now = Date.now()) {
      return recent(key, now).length >= max;
    },
    fail(key, now = Date.now()) {
      const list = recent(key, now);
      list.push(now);
      failures.set(key, list);
    },
    clear(key) {
      failures.delete(key);
    },
  };
}
