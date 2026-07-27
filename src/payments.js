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

// Confirm a card payment by the Foloosi transaction reference stored in its proof text.
// Used by the Foloosi webhook to auto-confirm (Pending -> Confirmed).
export async function confirmPaymentByRef(ref) {
  if (!ref) return null;
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?proof=like.*${encodeURIComponent(ref)}*&status=neq.Confirmed`, {
      method: "PATCH", headers: h({ Prefer: "return=representation" }), body: JSON.stringify({ status: "Confirmed" }),
    });
    if (!res.ok) throw new Error("Supabase confirmByRef " + res.status + ": " + (await res.text().catch(() => "")));
    const d = await res.json().catch(() => []); return Array.isArray(d) ? d[0] || null : d;
  }
  const all = loadFile();
  const rec = all.find((x) => String(x.proof || "").includes(ref) && x.status !== "Confirmed");
  if (rec) { rec.status = "Confirmed"; saveFile(all); }
  return rec || null;
}

// Upsert a card payment keyed by its Foloosi transaction number (stored in `proof`).
// Handles the return-vs-webhook race: whichever arrives first creates the row; the
// webhook (confirmed=true) flips it to Confirmed; neither ever duplicates or downgrades.
export async function saveCardPayment({ email, customer_name, amount, transaction_no, confirmed }) {
  const proof = transaction_no ? ("Foloosi transaction: " + transaction_no) : "Card payment";
  const status = confirmed ? "Confirmed" : "Pending";
  if (usingSupabase) {
    if (transaction_no) {
      const q = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?proof=like.*${encodeURIComponent(transaction_no)}*&select=id,status`, { headers: h() });
      const rows = q.ok ? await q.json().catch(() => []) : [];
      if (rows && rows.length) {
        if (confirmed && rows[0].status !== "Confirmed") {
          await fetch(`${SUPA_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(rows[0].id)}`, { method: "PATCH", headers: h({ Prefer: "return=minimal" }), body: JSON.stringify({ status: "Confirmed" }) });
        }
        return { id: rows[0].id, existed: true };
      }
    }
    const rec = { email: (email || "").toLowerCase(), customer_name: customer_name || "", amount: Number(amount) || 0, mode: "Card", proof, status };
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}`, { method: "POST", headers: h({ Prefer: "return=representation" }), body: JSON.stringify(rec) });
    if (!res.ok) throw new Error("Supabase saveCardPayment " + res.status + ": " + (await res.text().catch(() => "")));
    const d = await res.json(); return Array.isArray(d) ? d[0] : d;
  }
  const all = loadFile();
  const idx = transaction_no ? all.findIndex((x) => String(x.proof || "").includes(transaction_no)) : -1;
  if (idx >= 0) { if (confirmed) all[idx].status = "Confirmed"; saveFile(all); return all[idx]; }
  const rec = { email: (email || "").toLowerCase(), customer_name: customer_name || "", amount: Number(amount) || 0, mode: "Card", proof, status, id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), created: new Date().toISOString() };
  all.push(rec); saveFile(all); return rec;
}

export async function updatePaymentStatus(id, status) {
  if (usingSupabase) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: h({ Prefer: "return=minimal" }), body: JSON.stringify({ status }) });
    if (!res.ok) throw new Error("Supabase updatePaymentStatus " + res.status + ": " + (await res.text().catch(() => "")));
    return;
  }
  const all = loadFile(); const rec = all.find((x) => String(x.id) === String(id)); if (rec) { rec.status = status; saveFile(all); }
}
