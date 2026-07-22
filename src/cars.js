// Admin-managed car assignments per customer (keyed by email).
//
// When a customer has a managed record here, it OVERRIDES the Zoho-derived cars
// on their home screen:
//   • a record WITH plates  -> those are the customer's cars
//   • a record with NO plates -> the customer is INACTIVE (no cars subscribed)
//   • NO record at all       -> "unmanaged": the app keeps deriving cars from
//                                Zoho invoices exactly as before (backward compat)
//
// Storage mirrors store.js / users.js: Supabase table `customer_cars` when
// SUPABASE_URL + SUPABASE_KEY are set (permanent), else a local JSON file
// (works locally but is wiped on Render's free tier restarts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plateIdentity } from "./fleet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "customer_cars.json");
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const TABLE = process.env.SUPABASE_CARS_TABLE || "customer_cars";
export const carsUsingSupabase = !!(SUPA_URL && SUPA_KEY);

function h(extra = {}) {
  return { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", ...extra };
}
function loadFile() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } }
function saveFile(obj) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error("cars write failed:", e.message); }
}

// De-dupes a plate list (case/spacing-insensitive) while keeping the typed form.
function cleanPlates(plates) {
  const out = [], seen = new Set();
  for (const p of plates || []) {
    const v = String(p || "").trim();
    const k = plateIdentity(v);
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

// Returns an array of plate strings if the customer is managed (possibly []),
// or null if the customer has no managed record at all.
export async function getManagedPlates(email) {
  const e = (email || "").toLowerCase();
  if (carsUsingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?email=eq.${encodeURIComponent(e)}&select=plate`, { headers: h() });
    if (!res.ok) throw new Error("Supabase getManagedPlates " + res.status + ": " + (await res.text().catch(() => "")));
    const rows = await res.json();
    if (!rows.length) return null; // no record -> unmanaged
    return rows.map((r) => String(r.plate || "").trim()).filter(Boolean);
  }
  const all = loadFile();
  if (!(e in all)) return null; // no record -> unmanaged
  return (all[e] || []).map((p) => String(p || "").trim()).filter(Boolean);
}

// Replaces the customer's managed plate list. An empty array marks the customer
// as managed-but-inactive (kept as a single blank sentinel row in Supabase so
// the record still exists and getManagedPlates returns [] rather than null).
export async function setManagedPlates(email, plates) {
  const e = (email || "").toLowerCase();
  const clean = cleanPlates(plates);
  if (carsUsingSupabase) {
    const del = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?email=eq.${encodeURIComponent(e)}`, { method: "DELETE", headers: h({ Prefer: "return=minimal" }) });
    if (!del.ok) throw new Error("Supabase clear cars " + del.status + ": " + (await del.text().catch(() => "")));
    const rows = clean.length ? clean.map((plate) => ({ email: e, plate })) : [{ email: e, plate: "" }];
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}`, { method: "POST", headers: h({ Prefer: "return=minimal" }), body: JSON.stringify(rows) });
    if (!res.ok) throw new Error("Supabase set cars " + res.status + ": " + (await res.text().catch(() => "")));
    return clean;
  }
  const all = loadFile();
  all[e] = clean; // empty array = managed-but-inactive (record still present)
  saveFile(all);
  return clean;
}
