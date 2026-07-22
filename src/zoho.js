// Zoho Books data access. Uses sample data when USE_MOCK=true, otherwise
// talks to the real Zoho Books API with a read-only refresh token.
import { mockCustomers, mockInvoices, mockPayments } from "./mock.js";
import { lookupCar, carLabel, colorLabel, normPlate } from "./fleet.js";
import { liveLookup } from "./fleetlive.js";

const USE_MOCK = (process.env.USE_MOCK || "true").toLowerCase() !== "false";
const ORG = process.env.ZOHO_ORG_ID;
const ACCOUNTS = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API = process.env.ZOHO_API_HOST || "https://www.zohoapis.com";

// --- access token cache (refresh tokens are long-lived; access tokens ~1h) ---
let cachedToken = null;
let cachedUntil = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const res = await fetch(`${ACCOUNTS}/oauth/v2/token?${params.toString()}`, { method: "POST" });
  const data = await res.json();
  if (!data.access_token) throw new Error("Zoho token error: " + JSON.stringify(data));
  cachedToken = data.access_token;
  cachedUntil = Date.now() + (data.expires_in ? data.expires_in * 1000 - 60000 : 3000000);
  return cachedToken;
}

async function booksGet(path, extraParams = {}) {
  const token = await getAccessToken();
  const params = new URLSearchParams({ organization_id: ORG, ...extraParams });
  const res = await fetch(`${API}/books/v3/${path}?${params.toString()}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (data.code && data.code !== 0) throw new Error("Zoho API error: " + JSON.stringify(data));
  return data;
}

// ---------------- public functions (mock or real) ----------------

export async function getCustomerByEmail(email) {
  const e = (email || "").trim().toLowerCase();
  if (USE_MOCK) {
    return mockCustomers.find((c) => c.email.toLowerCase() === e) || null;
  }
  const data = await booksGet("contacts", { email: e });
  const c = (data.contacts || [])[0];
  if (!c) return null;
  return {
    contact_id: c.contact_id,
    contact_name: c.contact_name,
    email: c.email,
    phone: c.mobile || c.phone || null,
    vehicle: null,
  };
}

// Best-effort: pull the car number plate(s) from the customer's invoices
// (custom field, line-item text, or reference/notes). Cached briefly per contact.
const _vehCache = new Map(); // contactId -> { plates, until }

// Turn a raw plate string into a rich vehicle object, matching the plate against
// the Muscle Cars fleet inventory to attach the make / model / year / colour.
export function enrichPlate(plate) {
  if (!plate) return null;
  const rec = { plate: String(plate).trim() };
  // Prefer live Firestore data (if connected); fall back to the bundled snapshot.
  const info = liveLookup(plate) || lookupCar(plate);
  if (info) {
    if (info.car) rec.car = carLabel(info.car);
    if (/^\d{4}$/.test(info.year || "")) rec.year = info.year;
    const col = colorLabel(info.color);
    if (col) rec.color = col;
    if (typeof info.percent === "number") rec.percent = info.percent;
    if (info.months && !/^0\/[-–]?$/.test(info.months)) rec.months = info.months;
  }
  return rec;
}

// One vehicle for the home card (light: most recent invoice only).
export async function getVehicle(contactId) {
  if (USE_MOCK) {
    const c = mockCustomers.find((x) => x.contact_id === contactId);
    if (!c) return null;
    const firstPlate = (c.plates && c.plates[0]) || (c.vehicle && c.vehicle.plate);
    if (!firstPlate) return null;
    const v = enrichPlate(firstPlate) || {};
    return { plate: firstPlate, car: v.car || (c.vehicle && c.vehicle.name), year: v.year || (c.vehicle && c.vehicle.year), color: v.color, percent: v.percent, months: v.months };
  }
  const cached = _vehCache.get(contactId);
  if (cached && Date.now() < cached.until && cached.plates.length) return enrichPlate(cached.plates[0]);
  try {
    const list = await booksGet("invoices", { customer_id: contactId, sort_column: "date", sort_order: "D", per_page: 1 });
    const inv0 = (list.invoices || [])[0];
    if (!inv0) return null;
    const full = await booksGet(`invoices/${inv0.invoice_id}`);
    const p = extractAllPlates((full && full.invoice) || {})[0];
    return p ? enrichPlate(p) : null;
  } catch (e) { return null; }
}

// All distinct vehicles for the "Show all cars" list (heavier scan; cached 15 min).
export async function getVehicles(contactId) {
  if (USE_MOCK) {
    const c = mockCustomers.find((x) => x.contact_id === contactId);
    if (!c) return [];
    const list = (c.plates && c.plates.length) ? c.plates : (c.vehicle && c.vehicle.plate ? [c.vehicle.plate] : []);
    return list.map(enrichPlate);
  }
  const cached = _vehCache.get(contactId);
  if (cached && Date.now() < cached.until) return cached.plates.map(enrichPlate);
  const plates = [];
  const seen = new Set(); // de-dupe by normalised plate (ignores case/spacing/order)
  try {
    const list = await booksGet("invoices", { customer_id: contactId, sort_column: "date", sort_order: "D", per_page: 20 });
    const invs = (list.invoices || []).slice(0, 12);
    for (const li of invs) {
      if (plates.length >= 8) break;
      const full = await booksGet(`invoices/${li.invoice_id}`);
      for (const p of extractAllPlates((full && full.invoice) || {})) {
        const nk = normPlate(p);
        if (nk && !seen.has(nk)) { seen.add(nk); plates.push(p); }
      }
    }
  } catch (e) { /* ignore */ }
  _vehCache.set(contactId, { plates, until: Date.now() + 15 * 60 * 1000 });
  return plates.map(enrichPlate);
}

function plateFromText(s) {
  if (!s) return null;
  const str = String(s);
  // "Plate/Vehicle/Reg no: XXXX"
  let m = str.match(/(?:plate|vehicle|reg(?:istration)?|car)\s*(?:no\.?|number|#)?[\s:#\-]*([A-Za-z]{0,4}[\s-]?\d{1,5}[\s-]?[A-Za-z]{0,3})/i);
  if (m && m[1] && /\d/.test(m[1])) return m[1].replace(/\s+/g, " ").trim().toUpperCase();
  // emirate name/code followed by the plate
  m = str.match(/\b(?:dubai|dxb|abu\s*dhabi|auh|sharjah|shj|ajman|ajm|rak|ras\s*al\s*khaimah|uaq|umm\s*al\s*quwain|fujairah|fuj)\b[\s:\-]*([A-Za-z]{0,3}\s?\d{1,5})/i);
  if (m && m[1] && /\d/.test(m[1])) return (str.match(/\b(?:dubai|dxb|abu\s*dhabi|auh|sharjah|shj|ajman|ajm|rak|uaq|fujairah|fuj)\b/i)[0] + " " + m[1]).replace(/\s+/g, " ").trim().toUpperCase();
  return null;
}
function extractAllPlates(inv) {
  const out = [];
  const push = (p) => { if (p) { const v = String(p).trim(); if (v && !out.includes(v)) out.push(v); } };
  for (const f of (inv.custom_fields || [])) {
    if (/plate|vehicle|car|reg/i.test(f.label || "") && f.value) push(f.value);
  }
  for (const li of (inv.line_items || [])) {
    for (const f of (li.custom_fields || [])) {
      if (/plate|vehicle|car|reg/i.test(f.label || "") && f.value) push(f.value);
    }
    push(plateFromText(li.description)); push(plateFromText(li.name));
  }
  push(plateFromText(inv.reference_number)); push(plateFromText(inv.notes)); push(plateFromText(inv.customer_notes));
  return out;
}

export async function getInvoices(contactId) {
  // Void (cancelled) invoices are never shown to the customer.
  const notVoid = (i) => (i.status || "").toLowerCase() !== "void";
  if (USE_MOCK) return mockInvoices.filter((i) => i.contact_id === contactId && notVoid(i));
  const data = await booksGet("invoices", { customer_id: contactId });
  return (data.invoices || []).filter(notVoid).map((i) => ({
    invoice_id: i.invoice_id,
    contact_id: contactId,
    invoice_number: i.invoice_number,
    date: i.date,
    due_date: i.due_date,
    total: i.total,
    balance: i.balance,
    status: i.status,
  }));
}

// ---- invoice type classification (Salik / Fine / Rent / ...) ----
// Rules are checked in order; the first match wins. Keywords are matched
// against all of the invoice's text (line items, reference, notes, custom
// fields), so the type is found wherever the owner wrote it in Zoho.
const TYPE_RULES = [
  ["Salik", /salik|\btoll\b|\bdarb\b/i],
  ["Fine", /\bfine\b|traffic|violation|mukhalafa|black\s*point|penalt/i],
  ["Long-term rent", /\brent|\blease|monthly|instal?ment|subscription|\bhire\b/i],
  ["Insurance", /insurance|takaful/i],
  ["Registration", /registration|mulkiya|renewal|\bregister/i],
  ["Service", /service|maintenance|repair|\boil\b|tyre|tire|\bwash|detailing/i],
  ["Fuel", /\bfuel\b|petrol|diesel/i],
];
function classifyType(text) {
  const s = String(text || "");
  for (const [label, re] of TYPE_RULES) if (re.test(s)) return label;
  return "Other";
}

// Runs an async mapper over items with a small concurrency cap (avoids
// bursting the Zoho rate limit when a customer has many invoices).
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

const _invTypeCache = new Map(); // contactId -> { map: {invoice_id: type}, until }

// Same invoice list as getInvoices, but each invoice gets a { type } label.
// The type is read from the full invoice (line items etc.) and cached ~15 min
// per customer, so the fast list endpoints (home, statement) stay untouched.
export async function getInvoicesTyped(contactId) {
  const invoices = await getInvoices(contactId);
  if (USE_MOCK) {
    return invoices.map((i) => ({
      ...i,
      type: i.type || classifyType([i.invoice_number, i.reference_number, i.items, i.description].join(" ")),
    }));
  }
  const now = Date.now();
  const cached = _invTypeCache.get(contactId);
  const map = cached && now < cached.until ? cached.map : {};
  const missing = invoices.filter((i) => !map[i.invoice_id]);
  if (missing.length) {
    await mapLimit(missing, 5, async (i) => {
      try {
        const full = await booksGet(`invoices/${i.invoice_id}`);
        const inv = (full && full.invoice) || {};
        const parts = [inv.invoice_number, inv.reference_number, inv.notes, inv.customer_notes];
        for (const li of inv.line_items || []) parts.push(li.name, li.description);
        for (const f of inv.custom_fields || []) parts.push(f.value);
        map[i.invoice_id] = classifyType(parts.join(" "));
      } catch (e) {
        map[i.invoice_id] = map[i.invoice_id] || "Other";
      }
    });
    _invTypeCache.set(contactId, { map, until: now + 15 * 60 * 1000 });
  }
  return invoices.map((i) => ({ ...i, type: map[i.invoice_id] || "Other" }));
}

export async function getPayments(contactId) {
  if (USE_MOCK) return mockPayments.filter((p) => p.contact_id === contactId);
  const data = await booksGet("customerpayments", { customer_id: contactId });
  return (data.customerpayments || []).map((p) => ({
    payment_id: p.payment_id,
    contact_id: contactId,
    payment_number: p.payment_number,
    date: p.date,
    amount: p.amount,
    payment_mode: p.payment_mode,
    invoice_numbers: p.invoice_numbers,
  }));
}

// ---------------- PDF downloads (real Zoho files) ----------------

async function booksPdf(pathStr) {
  const token = await getAccessToken();
  const params = new URLSearchParams({ organization_id: ORG, accept: "pdf" });
  const res = await fetch(`${API}/books/v3/${pathStr}?${params.toString()}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: "application/pdf" },
  });
  if (!res.ok) throw new Error("Zoho PDF error " + res.status + ": " + (await res.text().catch(() => "")));
  return Buffer.from(await res.arrayBuffer());
}

export async function getInvoicePdf(invoiceId, lines) {
  if (USE_MOCK) return mockPdf("INVOICE", lines);
  return booksPdf(`invoices/${invoiceId}`);
}

export async function getPaymentPdf(paymentId, lines) {
  if (USE_MOCK) return mockPdf("PAYMENT RECEIPT", lines);
  return booksPdf(`customerpayments/${paymentId}`);
}

// ---- lightweight PDF builder (used for demo docs + the generated statement) ----
function pdfEsc(s) { return String(s == null ? "" : s).replace(/[^\x20-\x7E]/g, "-").replace(/([\\()])/g, "\\$1"); }
function pdfNum(n) { return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function pdfDate(s) { if (!s) return ""; const d = new Date(s); if (isNaN(d)) return String(s); return d.toISOString().slice(0, 10); }

function assemblePdf(content) {
  const objs = [];
  objs.push("<</Type/Catalog/Pages 2 0 R>>");
  objs.push("<</Type/Pages/Kids[3 0 R]/Count 1>>");
  objs.push("<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>");
  objs.push(`<</Length ${Buffer.byteLength(content, "latin1")}>>\nstream\n${content}endstream`);
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>");
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += String(off).padStart(10, "0") + " 00000 n \n"; });
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// Assembles a multi-page PDF from an array of page content streams.
function assemblePdfPages(pageContents) {
  const N = pageContents.length;
  const fontF1 = 3 + 2 * N, fontF2 = 4 + 2 * N;
  const objs = {};
  const kids = [];
  for (let i = 0; i < N; i++) kids.push(`${3 + i} 0 R`);
  objs[1] = `<</Type/Catalog/Pages 2 0 R>>`;
  objs[2] = `<</Type/Pages/Kids[${kids.join(" ")}]/Count ${N}>>`;
  for (let i = 0; i < N; i++) {
    const pageNum = 3 + i, contentNum = 3 + N + i, c = pageContents[i];
    objs[pageNum] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 ${fontF1} 0 R/F2 ${fontF2} 0 R>>>>/Contents ${contentNum} 0 R>>`;
    objs[contentNum] = `<</Length ${Buffer.byteLength(c, "latin1")}>>\nstream\n${c}endstream`;
  }
  objs[fontF1] = `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`;
  objs[fontF2] = `<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>`;
  const total = fontF2;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let n = 1; n <= total; n++) { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += String(off).padStart(10, "0") + " 00000 n \n"; });
  pdf += `trailer\n<</Size ${total + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// Builds a small, valid PDF so downloads work in demo (USE_MOCK) mode.
function mockPdf(title, lines = []) {
  let content = `BT /F2 24 Tf 60 770 Td (OWN.CAR) Tj ET\n`;
  content += `BT /F1 13 Tf 60 748 Td (Muscle Cars Rent A Car LLC) Tj ET\n`;
  content += `BT /F2 18 Tf 60 702 Td (${pdfEsc(title)}) Tj ET\n`;
  let y = 666;
  for (const ln of lines) { content += `BT /F1 12 Tf 60 ${y} Td (${pdfEsc(ln)}) Tj ET\n`; y -= 24; }
  content += `BT /F1 10 Tf 60 80 Td (Sample document generated in demo mode.) Tj ET\n`;
  return assemblePdf(content);
}

// Generates a full Statement of Account PDF (paginated) from the customer's invoices + payments.
export function buildStatementPdf(customer, entries, summary) {
  const name = customer && customer.contact_name ? customer.contact_name : "";
  const period = (summary.from || summary.to) ? `Period: ${summary.from || "Start"} to ${summary.to || "Today"}` : "Period: All transactions";
  const all = entries || [];
  const tableHeader = (y) =>
    `BT /F2 11 Tf 60 ${y} Td (Date) Tj ET\n` +
    `BT /F2 11 Tf 150 ${y} Td (Description) Tj ET\n` +
    `BT /F2 11 Tf 470 ${y} Td (Amount) Tj ET\n`;
  const rowLine = (e, y) => {
    const amt = e.credit ? `- AED ${pdfNum(e.credit)}` : `AED ${pdfNum(e.debit)}`;
    return `BT /F1 10 Tf 60 ${y} Td (${pdfEsc(pdfDate(e.date))}) Tj ET\n` +
      `BT /F1 10 Tf 150 ${y} Td (${pdfEsc(String(e.label).slice(0, 52))}) Tj ET\n` +
      `BT /F1 10 Tf 470 ${y} Td (${pdfEsc(amt)}) Tj ET\n`;
  };
  const STEP = 19, BOTTOM = 70;
  const pages = [];
  let idx = 0, pageNo = 0;
  do {
    let content = "";
    let y;
    if (pageNo === 0) {
      content += `BT /F2 24 Tf 60 800 Td (OWN.CAR) Tj ET\n`;
      content += `BT /F1 12 Tf 60 782 Td (Muscle Cars Rent A Car LLC) Tj ET\n`;
      content += `BT /F2 17 Tf 60 752 Td (Statement of Account) Tj ET\n`;
      content += `BT /F1 11 Tf 60 732 Td (Customer: ${pdfEsc(name)}) Tj ET\n`;
      content += `BT /F1 10 Tf 60 715 Td (${pdfEsc(period)}) Tj ET\n`;
      content += `BT /F1 11 Tf 60 690 Td (Opening Balance: AED ${pdfNum(summary.opening || 0)}) Tj ET\n`;
      content += `BT /F1 11 Tf 300 690 Td (Invoiced: AED ${pdfNum(summary.invoiced)}) Tj ET\n`;
      content += `BT /F1 11 Tf 60 672 Td (Paid: AED ${pdfNum(summary.paid)}) Tj ET\n`;
      content += `BT /F2 11 Tf 300 672 Td (Closing Balance: AED ${pdfNum(summary.closing)}) Tj ET\n`;
      content += tableHeader(642);
      y = 620;
    } else {
      content += `BT /F2 14 Tf 60 806 Td (Statement of Account (continued)) Tj ET\n`;
      content += tableHeader(780);
      y = 758;
    }
    while (idx < all.length && y >= BOTTOM) {
      content += rowLine(all[idx], y);
      y -= STEP;
      idx++;
    }
    if (idx >= all.length) {
      content += `BT /F1 9 Tf 60 44 Td (Generated by the OWN.CAR client portal.  Total transactions: ${all.length}) Tj ET\n`;
    }
    pages.push(content);
    pageNo++;
  } while (idx < all.length);
  return assemblePdfPages(pages);
}

export { USE_MOCK };
