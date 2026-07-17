// Stores each client's password (securely hashed — never plain text).
// Identity still comes from Zoho Books; this only holds the password they set.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "users.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}
function save(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
}

export function getUser(email) {
  return load()[email.toLowerCase()] || null;
}

export function setUserPassword(email, password) {
  const users = load();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  users[email.toLowerCase()] = { salt, hash, updated: new Date().toISOString() };
  save(users);
}

export function verifyUserPassword(email, password) {
  const u = getUser(email);
  if (!u || !u.hash) return false;
  const h = crypto.scryptSync(password, u.salt, 64).toString("hex");
  const a = Buffer.from(h), b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
