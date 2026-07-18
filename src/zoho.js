// Zoho Books data access. Uses sample data when USE_MOCK=true, otherwise
// talks to the real Zoho Books API with a read-only refresh token.
import { mockCustomers, mockInvoices, mockPayments } from "./mock.js";

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
    // Vehicle details can be stored as a custom field in Books; adjust the key as needed.
    vehicle: null,
  };
}

export async function getInvoices(contactId) {
  if (USE_MOCK) return mockInvoices.filter((i) => i.contact_id === contactId);
  const data = await booksGet("invoices", { customer_id: contactId });
  return (data.invoices || []).map((i) => ({
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

// Generates a Statement of Account PDF from the customer's own invoices + payments.
export function buildStatementPdf(customer, entries, summary) {
  const name = customer && customer.contact_name ? customer.contact_name : "";
  let content = `BT /F2 24 Tf 60 800 Td (OWN.CAR) Tj ET\n`;
  content += `BT /F1 12 Tf 60 782 Td (Muscle Cars Rent A Car LLC) Tj ET\n`;
  content += `BT /F2 17 Tf 60 748 Td (Statement of Account) Tj ET\n`;
  content += `BT /F1 12 Tf 60 726 Td (Customer: ${pdfEsc(name)}) Tj ET\n`;
  content += `BT /F1 11 Tf 60 702 Td (Total Invoiced: AED ${pdfNum(summary.invoiced)}) Tj ET\n`;
  content += `BT /F1 11 Tf 260 702 Td (Paid: AED ${pdfNum(summary.paid)}) Tj ET\n`;
  content += `BT /F2 11 Tf 420 702 Td (Balance Due: AED ${pdfNum(summary.closing)}) Tj ET\n`;
  content += `BT /F2 11 Tf 60 668 Td (Date) Tj ET\n`;
  content += `BT /F2 11 Tf 150 668 Td (Description) Tj ET\n`;
  content += `BT /F2 11 Tf 470 668 Td (Amount) Tj ET\n`;
  let y = 646;
  const maxRows = 26;
  const shown = (entries || []).slice(0, maxRows);
  for (const e of shown) {
    const amt = e.credit ? `- AED ${pdfNum(e.credit)}` : `AED ${pdfNum(e.debit)}`;
    content += `BT /F1 10 Tf 60 ${y} Td (${pdfEsc(pdfDate(e.date))}) Tj ET\n`;
    content += `BT /F1 10 Tf 150 ${y} Td (${pdfEsc(String(e.label).slice(0, 52))}) Tj ET\n`;
    content += `BT /F1 10 Tf 470 ${y} Td (${pdfEsc(amt)}) Tj ET\n`;
    y -= 20;
  }
  if ((entries || []).length > maxRows) {
    content += `BT /F1 10 Tf 60 ${y} Td (...and ${entries.length - maxRows} earlier transactions) Tj ET\n`;
  }
  content += `BT /F1 9 Tf 60 60 Td (Generated by the OWN.CAR client portal.) Tj ET\n`;
  return assemblePdf(content);
}

export { USE_MOCK };
