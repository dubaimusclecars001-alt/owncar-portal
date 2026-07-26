// Customer payment submissions (partial payments + bank-transfer proof).
// Stored in Supabase table `payment_submissions` when configured, else a local
// JSON file (works locally; wiped on Render free-tier restarts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "payments.json");
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const TABLE = process.env.SUPABASE_PAYMENTS_TABLE || "payment_submissions";
const usingSupabase = !!(SUPA_URL && SUPA_KEY);

function h(extra = {}) { return { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", ...extra }; }
function loadFile() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } }
function saveFile(v) { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(v, null, 2)); } catch (e) { console.error("payments write failed:", e.message); } }

// Record a new payment submission (status starts "Pending").
export async function addPayment(p) {
  const rec = {
    email: (p.email || "").toLowerCase(),
    customer_name: p.customer_name || "",
    amount: Number(p.amount) || 0,
    mode: p.mode || "bank",
    proof: p.proof || "",
    status: "Pending",
  };
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}`, { method: "POST", headers: h({ Prefer: "return=representation" }), body: JSON.stringify(rec) });
    if (!res.ok) throw new Error("Supabase addPayment " + res.status + ": " + (await res.text().catch(() => "")));
    const d = await res.json(); return Array.isArray(d) ? d[0] : d;
  }
  const all = loadFile();
  rec.id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  rec.created = new Date().toISOString();
  all.push(rec); saveFile(all); return rec;
}

// Admin list — WITHOUT the (heavy) proof image; fetch that separately per row.
export async function listPayments() {
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?select=id,created,email,customer_name,amount,mode,status&order=created.desc&limit=300`, { headers: h() });
    if (!res.ok) throw new Error("Supabase listPayments " + res.status + ": " + (await res.text().catch(() => "")));
    return await res.json();
  }
  return loadFile().map(({ proof, ...r }) => r).sort((a, b) => (b.created || "").localeCompare(a.created || ""));
}

// The proof image (data URI) for one submission.
export async function getPaymentProof(id) {
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&select=proof`, { headers: h() });
    if (!res.ok) throw new Error("Supabase getPaymentProof " + res.status + ": " + (await res.text().catch(() => "")));
    const rows = await res.json(); return rows[0] ? rows[0].proof : "";
  }
  const rec = loadFile().find((x) => String(x.id) === String(id)); return rec ? rec.proof : "";
}

export async function updatePaymentStatus(id, status) {
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: h({ Prefer: "return=minimal" }), body: JSON.stringify({ status }) });
    if (!res.ok) throw new Error("Supabase updatePaymentStatus " + res.status + ": " + (await res.text().catch(() => "")));
    return;
  }
  const all = loadFile(); const rec = all.find((x) => String(x.id) === String(id)); if (rec) { rec.status = status; saveFile(all); }
}
