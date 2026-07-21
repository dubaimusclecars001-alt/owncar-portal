import "dotenv/config";
import express from "express";
import session from "express-session";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCustomerByEmail, getInvoices, getPayments, getInvoicePdf, getPaymentPdf, buildStatementPdf, getVehicle, USE_MOCK } from "./src/zoho.js";
import { sendLoginCode, sendBookingNotice, emailConfigured } from "./src/mailer.js";
import { getUser, setUserPassword, verifyUserPassword } from "./src/users.js";
import { saveBooking, listBookings, updateBookingStatus, getBookingsByDate, usingSupabase } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // required so login cookies work behind Render/host proxies (https)
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 8 },
}));

// ---- login code store (in-memory; fine for a single small service) ----
const codes = new Map(); // email -> { code, expires, tries }
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

// ---- SMS (Twilio) — texts the login code to the customer's phone ----
const smsConfigured = !!process.env.TWILIO_ACCOUNT_SID;
async function sendCodeSMS(phone, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  const body = new URLSearchParams({ To: phone, From: from, Body: `Your OWN.CAR login code is ${code}. It expires in 10 minutes.` });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Twilio " + res.status + ": " + (await res.text()));
}

// ---- helpers ----
function requireAuth(req, res, next) {
  if (req.session && req.session.email) return next();
  return res.status(401).json({ error: "Not signed in" });
}
async function currentCustomer(req) {
  return getCustomerByEmail(req.session.email);
}
const money = (n) => Number(n || 0);

// Builds a statement (optionally for a date range) with a running opening balance.
// Dates are ISO "YYYY-MM-DD" strings, so plain string comparison is correct.
function computeStatement(invoices, payments, from, to) {
  const inRange = (d) => (!from || (d || "") >= from) && (!to || (d || "") <= to);
  const before = (d) => from && (d || "") < from;
  let opening = 0;
  for (const i of invoices) { if (before(i.date)) opening += money(i.total); }
  for (const p of payments) { if (before(p.date)) opening -= money(p.amount); }
  const entries = [
    ...invoices.filter((i) => inRange(i.date)).map((i) => ({ type: "invoice", date: i.date, label: `Invoice ${i.invoice_number}`, debit: money(i.total) })),
    ...payments.filter((p) => inRange(p.date)).map((p) => ({ type: "payment", date: p.date, label: `Payment · ${p.payment_mode || ""}`, credit: money(p.amount) })),
  ].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const invoiced = invoices.filter((i) => inRange(i.date)).reduce((s, i) => s + money(i.total), 0);
  const paid = payments.filter((p) => inRange(p.date)).reduce((s, p) => s + money(p.amount), 0);
  const closing = opening + invoiced - paid;
  return { entries, opening, invoiced, paid, closing, from: from || null, to: to || null };
}

// ---- auth routes ----
// Step 1: enter email. Tells the client whether they already have a password.
app.post("/api/auth/check", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });
    const customer = await getCustomerByEmail(email);
    if (!customer) return res.status(404).json({ error: "We couldn't find an account for that email. Please contact us." });
    const u = await getUser(email);
    res.json({ ok: true, hasPassword: !!(u && u.hash) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Something went wrong. Please try again." }); }
});

// Send a one-time code (used for first-time setup AND forgot-password).
app.post("/api/auth/send-code", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const customer = await getCustomerByEmail(email);
    if (!customer) return res.status(404).json({ error: "We couldn't find an account for that email." });
    const code = genCode();
    codes.set(email, { code, expires: Date.now() + 10 * 60 * 1000, tries: 0 });
    const out = await sendLoginCode(email, code);
    res.json({ ok: true, delivered: out.delivered, devCode: out.delivered ? undefined : out.code });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not send code." }); }
});

// Verify the code and set a (new) password — used for first sign-in and for reset.
app.post("/api/auth/set-password", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const code = (req.body.code || "").trim();
  const password = req.body.password || "";
  const rec = codes.get(email);
  if (!rec) return res.status(400).json({ error: "Please request a new code." });
  if (Date.now() > rec.expires) { codes.delete(email); return res.status(400).json({ error: "Code expired. Request a new one." }); }
  if (rec.tries >= 5) { codes.delete(email); return res.status(429).json({ error: "Too many attempts. Request a new code." }); }
  rec.tries++;
  if (code !== rec.code) return res.status(401).json({ error: "Incorrect code." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const customer = await getCustomerByEmail(email);
  if (!customer) return res.status(404).json({ error: "Account not found." });
  try {
    await setUserPassword(email, password);
  } catch (e) { console.error(e); return res.status(500).json({ error: "Could not save your password. Please try again." }); }
  codes.delete(email);
  req.session.email = email;
  res.json({ ok: true });
});

// Normal login with email + password.
app.post("/api/auth/login", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const customer = await getCustomerByEmail(email);
  if (!customer) return res.status(404).json({ error: "We couldn't find an account for that email." });
  try {
    if (!(await verifyUserPassword(email, password))) return res.status(401).json({ error: "Incorrect password." });
  } catch (e) { console.error(e); return res.status(500).json({ error: "Sign-in failed. Please try again." }); }
  req.session.email = email;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// ---- data routes (all isolated to the signed-in customer) ----
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    if (!c) return res.status(404).json({ error: "Account not found" });
    const invoices = await getInvoices(c.contact_id);
    const outstanding = invoices.reduce((s, i) => s + money(i.balance), 0);
    const nextDue = invoices.filter(i => money(i.balance) > 0).sort((a,b)=> (a.due_date||"").localeCompare(b.due_date||""))[0];
    let vehicle = c.vehicle;
    if (!vehicle) { try { vehicle = await getVehicle(c.contact_id); } catch (e) {} }
    res.json({
      name: c.contact_name, email: c.email, vehicle, phone: c.phone || null,
      outstanding, nextDueDate: nextDue ? nextDue.due_date : null,
    });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load your account from Zoho Books." }); }
});

app.get("/api/invoices", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const invoices = await getInvoices(c.contact_id);
    res.json({ invoices });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load invoices." }); }
});

app.get("/api/statement", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const [invoices, payments] = await Promise.all([getInvoices(c.contact_id), getPayments(c.contact_id)]);
    const from = (req.query.from || "").slice(0, 10), to = (req.query.to || "").slice(0, 10);
    const st = computeStatement(invoices, payments, from, to);
    res.json({ entries: st.entries, summary: { invoiced: st.invoiced, paid: st.paid, closing: st.closing, opening: st.opening, from: st.from, to: st.to } });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load statement." }); }
});

app.get("/api/receipts", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const payments = await getPayments(c.contact_id);
    res.json({ payments });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load receipts." }); }
});

// ---- PDF downloads (a client can only download their own documents) ----
app.get("/api/invoices/:id/pdf", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    if (!c) return res.status(404).json({ error: "Account not found" });
    const invoices = await getInvoices(c.contact_id);
    const inv = invoices.find((i) => String(i.invoice_id) === String(req.params.id));
    if (!inv) return res.status(404).json({ error: "Invoice not found." });
    const lines = [
      `Invoice Number: ${inv.invoice_number}`,
      `Customer: ${c.contact_name}`,
      `Date: ${inv.date || "-"}`,
      `Due Date: ${inv.due_date || "-"}`,
      `Amount: AED ${money(inv.total)}`,
      `Balance: AED ${money(inv.balance)}`,
      `Status: ${inv.status || "-"}`,
    ];
    const pdf = await getInvoicePdf(inv.invoice_id, lines);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${inv.invoice_number}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not download the invoice from Zoho Books." }); }
});

app.get("/api/receipts/:id/pdf", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    if (!c) return res.status(404).json({ error: "Account not found" });
    const payments = await getPayments(c.contact_id);
    const p = payments.find((x) => String(x.payment_id) === String(req.params.id));
    if (!p) return res.status(404).json({ error: "Receipt not found." });
    const lines = [
      `Receipt Number: ${p.payment_number}`,
      `Customer: ${c.contact_name}`,
      `Date: ${p.date || "-"}`,
      `Amount: AED ${money(p.amount)}`,
      `Payment Mode: ${p.payment_mode || "-"}`,
      `Applied to: ${p.invoice_numbers || "-"}`,
    ];
    const pdf = await getPaymentPdf(p.payment_id, lines);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${p.payment_number}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not download the receipt from Zoho Books." }); }
});

app.get("/api/statement/pdf", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    if (!c) return res.status(404).json({ error: "Account not found" });
    const [invoices, payments] = await Promise.all([getInvoices(c.contact_id), getPayments(c.contact_id)]);
    const from = (req.query.from || "").slice(0, 10), to = (req.query.to || "").slice(0, 10);
    const st = computeStatement(invoices, payments, from, to);
    const pdf = buildStatementPdf(c, st.entries, st);
    const range = st.from || st.to ? `_${st.from || "start"}_to_${st.to || "today"}` : "";
    const safe = ((c.contact_name || "account").replace(/[^a-z0-9]+/gi, "_")) + range;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Statement-${safe}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not generate the statement." }); }
});

// ---- Booking rules ----
const MAX_PER_DAY = 4;                 // at most 4 appointments per day
const BOOK_LEAD_DAYS = 4;              // earliest bookable day = today + 4 (the next 3 days are blocked)
const BOOK_WINDOW_DAYS = 60;           // booking open for ~2 months from the first available day
// Dates are computed in Dubai time (UTC+4) so the window matches the client.
const dubaiPlus = (n) => new Date(Date.now() + 4 * 3600 * 1000 + n * 864e5).toISOString().slice(0, 10);
const firstBookable = () => dubaiPlus(BOOK_LEAD_DAYS);
const lastBookable = () => dubaiPlus(BOOK_LEAD_DAYS + BOOK_WINDOW_DAYS - 1);

// Tells the client which slots are already taken for a date (no customer details leaked).
app.get("/api/bookings/availability", requireAuth, async (req, res) => {
  try {
    const date = (req.query.date || "").slice(0, 10);
    const maxDate = lastBookable(), minDate = firstBookable();
    if (!date) return res.json({ date, takenSlots: [], count: 0, full: false, minDate, maxDate });
    const rows = await getBookingsByDate(date);
    const takenSlots = rows.map((r) => r.time_slot).filter(Boolean);
    res.json({ date, takenSlots, count: rows.length, full: rows.length >= MAX_PER_DAY, minDate, maxDate });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not check availability." }); }
});

// Returns the bookable window (today .. today+N) with per-day availability, so the
// client can show only bookable days and grey out full ones.
app.get("/api/bookings/window", requireAuth, async (req, res) => {
  try {
    const days = [];
    for (let i = BOOK_LEAD_DAYS; i < BOOK_LEAD_DAYS + BOOK_WINDOW_DAYS; i++) {
      const iso = dubaiPlus(i);
      const rows = await getBookingsByDate(iso);
      const takenSlots = rows.map((r) => r.time_slot).filter(Boolean);
      days.push({ date: iso, takenSlots, count: rows.length, full: rows.length >= MAX_PER_DAY });
    }
    res.json({ days });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load availability." }); }
});

app.post("/api/bookings", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const booking = {
      customer_email: c.email,
      customer_name: c.contact_name || "",
      car_name: (req.body.car_name || "").slice(0, 120),
      plate: (req.body.plate || "").slice(0, 40),
      phone: (req.body.phone || c.phone || "").slice(0, 40),
      service_type: (req.body.service_type || "").slice(0, 60),
      preferred_date: (req.body.preferred_date || "").slice(0, 20),
      time_slot: (req.body.time_slot || "").slice(0, 20),
      description: (req.body.description || "").slice(0, 1000),
      created: new Date().toISOString(),
      status: "Not confirmed yet",
    };
    // Enforce the booking window (within the next few days).
    if (!booking.preferred_date || booking.preferred_date < firstBookable() || booking.preferred_date > lastBookable()) {
      return res.status(400).json({ error: "Please choose an available date." });
    }
    // Enforce the per-day cap and prevent double-booking a slot.
    const dayRows = await getBookingsByDate(booking.preferred_date);
    if (dayRows.length >= MAX_PER_DAY) return res.status(409).json({ error: "That day is fully booked. Please choose another date." });
    if (booking.time_slot && dayRows.some((r) => r.time_slot === booking.time_slot)) {
      return res.status(409).json({ error: "That time slot was just taken. Please pick another." });
    }
    const saved = await saveBooking(booking);
    res.json({ ok: true, id: saved && saved.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not submit booking." }); }
});

app.get("/api/config", (req, res) => res.json({ mock: USE_MOCK, emailConfigured }));

// ---- Admin (staff) area — protected by ADMIN_PASSWORD ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "owncar-admin";
const STATUSES = ["Not confirmed yet", "Confirmed", "Service done"];
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: "Admin sign-in required" });
}
app.post("/api/admin/login", (req, res) => {
  const pw = req.body.password || "";
  if (pw && pw === ADMIN_PASSWORD) { req.session.admin = true; return res.json({ ok: true }); }
  return res.status(401).json({ error: "Wrong password." });
});
app.post("/api/admin/logout", (req, res) => { if (req.session) req.session.admin = false; res.json({ ok: true }); });
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true, storage: usingSupabase ? "database" : "file (not permanent)" }));
app.get("/api/admin/bookings", requireAdmin, async (req, res) => {
  try { res.json({ bookings: await listBookings() }); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not load bookings." }); }
});
app.post("/api/admin/bookings/:id/status", requireAdmin, async (req, res) => {
  try {
    const status = req.body.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status." });
    const booking = await updateBookingStatus(req.params.id, status);
    res.json({ ok: true, booking });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not update status." }); }
});
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ---- static frontend ----
app.use(express.static(path.join(__dirname, "public")));

// ---- One-time Zoho connect helper (safe to remove after setup) ----
app.get("/connect", (req, res) => {
  res.type("html").send(`<meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;background:#0b0b0d;color:#eee;max-width:540px;margin:auto;padding:24px"><h2>Connect Zoho Books</h2><form method=post><input name=client_id placeholder="Client ID" style="width:100%;padding:12px;margin:6px 0;box-sizing:border-box"><input name=client_secret placeholder="Client Secret" style="width:100%;padding:12px;margin:6px 0;box-sizing:border-box"><input name=code placeholder="Authorization Code" style="width:100%;padding:12px;margin:6px 0;box-sizing:border-box"><button style="background:#E11531;color:#fff;border:0;padding:14px;width:100%">Get refresh token</button></form></body>`);
});
app.post("/connect", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { client_id, client_secret, code } = req.body;
    const host = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
    const p = new URLSearchParams({ grant_type: "authorization_code", client_id, client_secret, code });
    const r = await fetch(`${host}/oauth/v2/token`, { method: "POST", body: p });
    const d = await r.json();
    if (!d.refresh_token) return res.type("html").send(`<body style="font-family:sans-serif;background:#0b0b0d;color:#eee;padding:24px"><h3 style="color:#ff8a97">No token yet</h3><pre style="white-space:pre-wrap">${JSON.stringify(d)}</pre><a style="color:#E11531" href="/connect">Try again</a> (codes expire in minutes — make a fresh one in Zoho).</body>`);
    res.type("html").send(`<body style="font-family:sans-serif;background:#0b0b0d;color:#eee;max-width:640px;margin:auto;padding:24px"><h2 style="color:#43B581">Success!</h2><p>Copy these into Render &rarr; Environment, set USE_MOCK to false, then redeploy:</p><p>ZOHO_CLIENT_ID</p><pre style="white-space:pre-wrap;background:#151519;padding:10px">${client_id}</pre><p>ZOHO_CLIENT_SECRET</p><pre style="white-space:pre-wrap;background:#151519;padding:10px">${client_secret}</pre><p>ZOHO_REFRESH_TOKEN</p><pre style="white-space:pre-wrap;background:#151519;padding:10px">${d.refresh_token}</pre></body>`);
  } catch (e) { res.status(500).send("Error: " + e.message); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OWN.CAR portal running on http://localhost:${PORT}  (mock=${USE_MOCK})`));
