// Booking storage.
// Uses a Supabase database when SUPABASE_URL + SUPABASE_KEY are set (permanent).
// Otherwise falls back to a local JSON file — works, but is NOT permanent on Render's
// free tier (the disk is wiped on restart/redeploy), so set up Supabase for real use.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const TABLE = process.env.SUPABASE_TABLE || "bookings";
export const usingSupabase = !!(SUPA_URL && SUPA_KEY);

const FILE = path.join(__dirname, "..", "data", "bookings.json");

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; }
}
function writeFile(all) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch (e) { console.error("booking write failed:", e.message); }
}

function supaHeaders(extra = {}) {
  return { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", ...extra };
}

export async function saveBooking(b) {
  const rec = { ...b, status: b.status || "Not confirmed yet" };
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: supaHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify(rec),
    });
    if (!res.ok) throw new Error("Supabase insert " + res.status + ": " + (await res.text().catch(() => "")));
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  }
  const all = readFile();
  rec.id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  rec.created = rec.created || new Date().toISOString();
  all.push(rec);
  writeFile(all);
  return rec;
}

export async function listBookings() {
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?select=*&order=preferred_date.desc,created.desc`, { headers: supaHeaders() });
    if (!res.ok) throw new Error("Supabase list " + res.status + ": " + (await res.text().catch(() => "")));
    return await res.json();
  }
  return readFile().sort((a, b) => (b.preferred_date || "").localeCompare(a.preferred_date || ""));
}

export async function updateBookingStatus(id, status) {
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: supaHeaders({ Prefer: "return=representation" }),
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error("Supabase update " + res.status + ": " + (await res.text().catch(() => "")));
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  }
  const all = readFile();
  const rec = all.find((x) => String(x.id) === String(id));
  if (rec) { rec.status = status; writeFile(all); }
  return rec;
}
