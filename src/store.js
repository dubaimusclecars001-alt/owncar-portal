// Stores each client's password (securely hashed — never plain text).
// Identity still comes from Zoho Books; this only holds the password they set.
// Uses Supabase when SUPABASE_URL + SUPABASE_KEY are set (permanent), otherwise a
// local JSON file (NOT permanent on Render free — wiped on restart/redeploy).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "users.json");
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const TABLE = process.env.SUPABASE_USERS_TABLE || "users";
const usingSupabase = !!(SUPA_URL && SUPA_KEY);

function h(extra = {}) {
  return { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", ...extra };
}
function loadFile() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } }
function saveFile(obj) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj, null, 2)); }

export async function getUser(email) {
  const e = (email || "").toLowerCase();
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?email=eq.${encodeURIComponent(e)}&select=*`, { headers: h() });
    if (!res.ok) throw new Error("Supabase getUser " + res.status + ": " + (await res.text().catch(() => "")));
    const rows = await res.json();
    return rows[0] || null;
  }
  return loadFile()[e] || null;
}

export async function setUserPassword(email, password) {
  const e = (email || "").toLowerCase();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  const updated = new Date().toISOString();
  if (usingSupabase) {
    // Upsert on the email primary key.
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: h({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ email: e, salt, hash, updated }),
    });
    if (!res.ok) throw new Error("Supabase setUserPassword " + res.status + ": " + (await res.text().catch(() => "")));
    return;
  }
  const users = loadFile();
  users[e] = { salt, hash, updated };
  saveFile(users);
}

export async function verifyUserPassword(email, password) {
  const u = await getUser(email);
  if (!u || !u.hash) return false;
  const hh = crypto.scryptSync(password, u.salt, 64).toString("hex");
  const a = Buffer.from(hh), b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
