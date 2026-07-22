// In-app notifications (the bell). Staff send a notice to all customers or to
// one customer; each customer sees them in the app, with an unread red dot until
// they open the bell.
//
// Storage mirrors the other stores: Supabase tables `notifications` +
// `notif_seen` when SUPABASE_URL + SUPABASE_KEY are set (permanent), else local
// JSON files (fine locally, wiped on Render free-tier restarts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NFILE = path.join(__dirname, "..", "data", "notifications.json");
const SFILE = path.join(__dirname, "..", "data", "notif_seen.json");
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const NTABLE = process.env.SUPABASE_NOTIF_TABLE || "notifications";
const STABLE = process.env.SUPABASE_NOTIF_SEEN_TABLE || "notif_seen";
const usingSupabase = !!(SUPA_URL && SUPA_KEY);

function h(extra = {}) { return { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", ...extra }; }
function loadJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }
function saveJson(f, v) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) { console.error("notif write failed:", e.message); } }

// Create a notification. An empty email = broadcast to ALL customers.
export async function addNotification({ email, title, body }) {
  const rec = {
    email: (email || "").toLowerCase() || null,
    title: String(title || "").slice(0, 140),
    body: String(body || "").slice(0, 1000),
  };
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${NTABLE}`, { method: "POST", headers: h({ Prefer: "return=representation" }), body: JSON.stringify(rec) });
    if (!res.ok) throw new Error("Supabase addNotification " + res.status + ": " + (await res.text().catch(() => "")));
    const d = await res.json(); return Array.isArray(d) ? d[0] : d;
  }
  const all = loadJson(NFILE, []);
  rec.id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  rec.created = new Date().toISOString();
  all.push(rec); saveJson(NFILE, all); return rec;
}

// Every notification, newest first (admin history).
export async function listAllNotifications() {
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${NTABLE}?select=*&order=created.desc&limit=100`, { headers: h() });
    if (!res.ok) throw new Error("Supabase listAll " + res.status + ": " + (await res.text().catch(() => "")));
    return await res.json();
  }
  return loadJson(NFILE, []).slice().sort((a, b) => (b.created || "").localeCompare(a.created || ""));
}

// Notifications visible to one customer (their own + broadcasts), newest first.
export async function listForCustomer(email) {
  const e = (email || "").toLowerCase();
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${NTABLE}?or=(email.is.null,email.eq.${encodeURIComponent(e)})&order=created.desc&limit=50`, { headers: h() });
    if (!res.ok) throw new Error("Supabase listForCustomer " + res.status + ": " + (await res.text().catch(() => "")));
    return await res.json();
  }
  return loadJson(NFILE, []).filter((n) => !n.email || n.email === e).sort((a, b) => (b.created || "").localeCompare(a.created || ""));
}

// Timestamp the customer last opened the bell (ISO string), or null.
export async function getSeen(email) {
  const e = (email || "").toLowerCase();
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${STABLE}?email=eq.${encodeURIComponent(e)}&select=seen_at`, { headers: h() });
    if (!res.ok) throw new Error("Supabase getSeen " + res.status + ": " + (await res.text().catch(() => "")));
    const rows = await res.json(); return rows[0] ? rows[0].seen_at : null;
  }
  return loadJson(SFILE, {})[e] || null;
}

// Mark all current notifications as seen for this customer (clears the red dot).
export async function setSeen(email) {
  const e = (email || "").toLowerCase();
  const seen_at = new Date().toISOString();
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${STABLE}`, { method: "POST", headers: h({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify({ email: e, seen_at }) });
    if (!res.ok) throw new Error("Supabase setSeen " + res.status + ": " + (await res.text().catch(() => "")));
    return seen_at;
  }
  const map = loadJson(SFILE, {}); map[e] = seen_at; saveJson(SFILE, map); return seen_at;
}
