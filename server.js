import "dotenv/config";
import express from "express";
import session from "express-session";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCustomerByEmail, getInvoices, getInvoicesTyped, getPayments, getInvoicePdf, getPaymentPdf, buildStatementPdf, getVehicle, getVehicles, enrichPlate, USE_MOCK } from "./src/zoho.js";
import { normPlate, plateIdentity } from "./src/fleet.js";
import { sendLoginCode, sendBookingNotice, sendBookingConfirmation, emailConfigured } from "./src/mailer.js";
import { getUser, setUserPassword, verifyUserPassword, listUsers } from "./src/users.js";
import { getManagedPlates, setManagedPlates } from "./src/cars.js";
import { addNotification, listAllNotifications, deleteNotification, listForCustomer, getSeen, setSeen } from "./src/notifications.js";
import { addPayment, listPayments, getPaymentProof, updatePaymentStatus, confirmPaymentByRef, saveCardPayment } from "./src/payments.js";
import { markApplicationPaid } from "./src/appswrite.js";
import { saveToken, tokensForEmail, allTokens, sendToTokens, uploadPushImage, listDevices } from "./src/push.js";
import { saveBooking, listBookings, updateBookingStatus, getBooking, markBookingConfirmSent, deleteBooking, getBookingsByDate, usingSupabase } from "./src/store.js";
import { initFleetLive } from "./src/fleetlive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // required so login cookies work behind Render/host proxies (https)
app.use(express.json({ limit: "8mb" })); // large limit so bank-transfer proof images fit
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
    // Admin-managed cars override the Zoho-derived vehicle when a record exists.
    let vehicle = null, active = true;
    let managed = null;
    try { managed = await getManagedPlates(c.email); } catch (e) {}
    if (managed !== null) {
      active = managed.length > 0;
      vehicle = managed.length ? enrichPlate(managed[0]) : null;
    } else {
      try { vehicle = await getVehicle(c.contact_id); } catch (e) {}
      if (!vehicle) vehicle = c.vehicle || null;
    }
    res.json({
      name: c.contact_name, email: c.email, vehicle, phone: c.phone || null,
      active, outstanding, nextDueDate: nextDue ? nextDue.due_date : null,
    });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load your account from Zoho Books." }); }
});

app.get("/api/vehicles", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    if (!c) return res.status(404).json({ error: "Account not found" });
    let managed = null;
    try { managed = await getManagedPlates(c.email); } catch (e) {}
    const vehicles = managed !== null ? managed.map(enrichPlate) : await getVehicles(c.contact_id);
    res.json({ vehicles, plates: vehicles.map((v) => v && v.plate).filter(Boolean), active: managed === null ? true : managed.length > 0 });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load vehicles." }); }
});

app.get("/api/invoices", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const invoices = req.query.typed ? await getInvoicesTyped(c.contact_id) : await getInvoices(c.contact_id);
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

// ---- In-app notifications (customer side) ----
app.get("/api/notifications", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const [items, seen] = await Promise.all([listForCustomer(c.email), getSeen(c.email)]);
    const seenT = seen ? Date.parse(seen) : 0;
    const unread = items.filter((n) => Date.parse(n.created) > seenT).length;
    res.json({ notifications: items, unread });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load notifications." }); }
});
app.post("/api/notifications/seen", requireAuth, async (req, res) => {
  try { const c = await currentCustomer(req); await setSeen(c.email); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not update notifications." }); }
});

// Register this device's push token against the logged-in customer. The native app reads its FCM
// token and posts it here (through the WebView) once the customer is signed in.
app.post("/api/push/register", requireAuth, async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    if (!token) return res.status(400).json({ error: "Missing device token." });
    await saveToken(req.session.email, token, String(req.body.platform || "").slice(0, 20));
    res.json({ ok: true });
  } catch (e) { console.error("push register:", e.message); res.status(500).json({ error: "Could not register device." }); }
});

// ---- Payments (customer submits a payment + bank-transfer proof) ----
app.post("/api/payments", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    if (!c) return res.status(404).json({ error: "Account not found" });
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) return res.status(400).json({ error: "Please enter a valid amount." });
    const mode = String(req.body.mode || "bank").slice(0, 20);
    const proof = String(req.body.proof || "");
    if (mode === "bank" && !proof) return res.status(400).json({ error: "Please upload your transfer proof." });
    if (proof.length > 7 * 1024 * 1024) return res.status(413).json({ error: "Proof image is too large." });
    const saved = await addPayment({ email: c.email, customer_name: c.contact_name, amount, mode, proof });
    res.json({ ok: true, id: saved && saved.id });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not submit your payment." }); }
});

// ---- Card payments via Foloosi ----
const FOLOOSI_SECRET_KEY = process.env.FOLOOSI_SECRET_KEY || "";
const FOLOOSI_MERCHANT_KEY = process.env.FOLOOSI_MERCHANT_KEY || "";
// 2.5% card gateway fee added on top of the amount and paid by the customer. Only the base
// amount (optional2) counts toward the balance/application; withFee(base) is what's charged.
const GATEWAY_FEE = 0.025;
const withFee = (base) => Math.round(base * (1 + GATEWAY_FEE) * 100) / 100;
// own.car website origins allowed to start a website card payment + be redirected back to.
const WEBSITE_ORIGINS = (process.env.WEBSITE_ORIGINS || "https://own.car,https://www.own.car,https://owncar.netlify.app,https://owncar-app.netlify.app,https://mysimmit.own.car,https://owncar-portal.onrender.com").split(",").map((s) => s.trim()).filter(Boolean);
function corsWebsite(req, res) {
  const origin = req.headers.origin;
  if (origin && WEBSITE_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
}
function safeWebsiteUrl(url) {
  try { const u = new URL(String(url)); if (WEBSITE_ORIGINS.includes(u.origin)) return u.toString(); } catch (e) {}
  return process.env.WEBSITE_DEFAULT_RETURN || "https://own.car";
}
// Create a Foloosi payment token for the amount (server-side, using the secret key).
app.post("/api/pay/foloosi/init", requireAuth, async (req, res) => {
  try {
    if (!FOLOOSI_SECRET_KEY || !FOLOOSI_MERCHANT_KEY) return res.status(503).json({ error: "Card payments are not available right now." });
    const base = Math.round((Number(req.body.amount) || 0) * 100) / 100;
    if (!(base > 0)) return res.status(400).json({ error: "Please enter a valid amount." });
    const c = await currentCustomer(req);
    const r = await fetch("https://api.foloosi.com/aggregatorapi/web/initialize-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "secret_key": FOLOOSI_SECRET_KEY },
      body: JSON.stringify({
        currency: "AED",
        transaction_amount: withFee(base),
        customer_name: (c && c.contact_name) || "",
        customer_email: (c && c.email) || "",
        description: "OWN.CAR payment",
        site_return_url: `${req.protocol}://${req.get("host")}/api/pay/foloosi/return`,
        optional1: (c && c.email) || "",
        optional2: String(base),
      }),
    });
    const d = await r.json().catch(() => ({}));
    const token = d && d.data && d.data.reference_token;
    if (!token) { console.error("foloosi init failed:", d && d.message); return res.status(502).json({ error: (d && d.message) || "Could not start the card payment." }); }
    res.json({ reference_token: token, merchant_key: FOLOOSI_MERCHANT_KEY });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not start the card payment." }); }
});
// Record a card payment after the widget reports success (admin confirms against the Foloosi dashboard).
app.post("/api/pay/foloosi/record", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    if (!c) return res.status(404).json({ error: "Account not found" });
    const amount = Number(req.body.amount) || 0;
    const ref = String(req.body.transaction_no || "").slice(0, 80);
    const saved = await addPayment({ email: c.email, customer_name: c.contact_name, amount, mode: "Card", proof: ref ? ("Foloosi transaction: " + ref) : "Card payment" });
    res.json({ ok: true, id: saved && saved.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not record the payment." }); }
});
// Website (own.car) subscription card payment: create a Foloosi token tagged with the
// application's OWN-ref (optional1="website:<ref>") so the return/webhook can mark that
// application paid in the website's Firebase. Called cross-origin from the website (CORS).
app.options("/api/pay/foloosi/website-init", (req, res) => { corsWebsite(req, res); res.sendStatus(204); });
app.post("/api/pay/foloosi/website-init", async (req, res) => {
  corsWebsite(req, res);
  try {
    if (!FOLOOSI_SECRET_KEY || !FOLOOSI_MERCHANT_KEY) return res.status(503).json({ error: "Card payments are not available right now." });
    const base = Math.round((Number(req.body.amount) || 0) * 100) / 100;
    if (!(base > 0)) return res.status(400).json({ error: "Please enter a valid amount." });
    const ref = String(req.body.ref || "").trim().slice(0, 40);
    if (!ref) return res.status(400).json({ error: "Missing application reference." });
    const returnUrl = safeWebsiteUrl(req.body.return_url);
    const r = await fetch("https://api.foloosi.com/aggregatorapi/web/initialize-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "secret_key": FOLOOSI_SECRET_KEY },
      body: JSON.stringify({
        currency: "AED",
        transaction_amount: withFee(base),
        customer_name: String(req.body.customer_name || "").slice(0, 100),
        customer_email: String(req.body.customer_email || "").slice(0, 120),
        description: String(req.body.description || "OWN.CAR subscription").slice(0, 140),
        site_return_url: `${req.protocol}://${req.get("host")}/api/pay/foloosi/return`,
        optional1: "website:" + ref,
        optional2: String(base),
        optional3: returnUrl,
      }),
    });
    const d = await r.json().catch(() => ({}));
    const token = d && d.data && d.data.reference_token;
    if (!token) { console.error("foloosi website init failed:", d && d.message); return res.status(502).json({ error: (d && d.message) || "Could not start the card payment." }); }
    res.json({ reference_token: token, merchant_key: FOLOOSI_MERCHANT_KEY });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not start the card payment." }); }
});
// Hosted-checkout return: Foloosi POSTs the result here after the customer pays. optional1
// tells us the source: "website:<OWN-ref>" -> mark the Firebase application paid + return to
// the website; otherwise it's the customer email -> record a portal payment + return to /portal.
app.post("/api/pay/foloosi/return", express.urlencoded({ extended: true }), async (req, res) => {
  const redirectTo = (url) => res.set("Content-Type", "text/html").send(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#050505;color:#F2F2EE;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">Returning to OWN.CAR…<script>location.replace(${JSON.stringify(url)})</script></body>`);
  try {
    const b = req.body || {};
    console.log("foloosi return:", JSON.stringify(b).slice(0, 700));
    const d = (b && typeof b.data === "object" && b.data) ? b.data : b;
    const status = String(b.status || d.status || "").toLowerCase();
    const transaction_no = d.transaction_no || b.transaction_no || "";
    const opt1 = String(d.optional1 || b.optional1 || "");
    // optional2 is the base amount (excl. the 2.5% gateway fee) — that's what counts toward the balance/application.
    const amount = Number(d.optional2 || b.optional2 || d.amount || 0) || 0;
    const paidQ = status === "success" ? "paid=success" : (status === "closed" || status === "cancelled") ? "paid=cancelled" : "paid=error";
    // Website subscription payment -> mark the Firebase application paid, return to the website.
    if (opt1.indexOf("website:") === 0) {
      const ref = opt1.slice("website:".length);
      if (status === "success" && ref) {
        try { await markApplicationPaid(ref, { transaction_no, paidAmount: amount }); }
        catch (e) { console.error("website return: markApplicationPaid failed:", e.message); }
      }
      const dest = safeWebsiteUrl(d.optional3 || b.optional3);
      return redirectTo(dest + (dest.indexOf("?") >= 0 ? "&" : "?") + paidQ);
    }
    // Portal payment -> record it (Pending; the webhook confirms). De-dupes by transaction_no.
    const email = opt1.toLowerCase();
    if (status === "success" && email) {
      let customer = null; try { customer = await getCustomerByEmail(email); } catch (e) {}
      try { await saveCardPayment({ email, customer_name: customer ? customer.contact_name : "", amount, transaction_no, confirmed: false }); }
      catch (e) { console.error("foloosi return record failed:", e.message); }
    }
    return redirectTo("/portal?" + paidQ);
  } catch (e) { console.error("foloosi return error:", e.message); return redirectTo("/portal?paid=error"); }
});
// GET responder so Foloosi's "ping/verify" test on the webhook URL returns 200, not 404.
app.get("/api/pay/foloosi/webhook", (req, res) => res.json({ ok: true, endpoint: "foloosi-webhook" }));
// Foloosi webhook (order.success): server-to-server confirmation. Auto-confirms the payment.
app.post("/api/pay/foloosi/webhook", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const b = req.body || {};
    console.log("foloosi webhook:", JSON.stringify(b).slice(0, 700));
    // Foloosi nests it as { data: { transfer: { ...fields, api: { optional1,... } } } }.
    const t = (b.data && b.data.transfer) || b.data || b;
    const api = (t && t.api) || (b.data && b.data.api) || b.data || b;
    const status = String(t.transaction_status || t.status || b.status || "").toLowerCase();
    const event = String(b.event || (b.data && b.data.event) || "").toLowerCase();
    const txn = t.transaction_no || t.payment_reference || b.transaction_no || "";
    const opt1 = String(api.optional1 || t.optional1 || b.optional1 || "");
    const amt = Number(api.optional2 || t.optional2 || t.transaction_amount || 0) || 0;
    if (txn && (status === "success" || event === "order.success")) {
      if (opt1.indexOf("website:") === 0) {
        // Website subscription payment -> mark the Firebase application paid.
        const ref = opt1.slice("website:".length);
        try { const w = await markApplicationPaid(ref, { transaction_no: txn, paidAmount: amt }); console.log("foloosi webhook website:", w); }
        catch (e) { console.error("webhook markApplicationPaid failed:", e.message); }
      } else {
        // Portal payment -> record-and-confirm (opt1 is the customer email; de-dupes by txn).
        let customer = null; try { customer = await getCustomerByEmail(opt1); } catch (e) {}
        try { const r = await saveCardPayment({ email: opt1, customer_name: customer ? customer.contact_name : "", amount: amt, transaction_no: txn, confirmed: true }); console.log("foloosi webhook confirmed:", r && r.id); }
        catch (e) { console.error("webhook confirm failed:", e.message); }
      }
    }
    res.json({ ok: true });
  } catch (e) { console.error("foloosi webhook error:", e.message); res.json({ ok: true }); }
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
    res.setHeader("Content-Disposition", `inline; filename="${inv.invoice_number}.pdf"`);
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
    res.setHeader("Content-Disposition", `inline; filename="${p.payment_number}.pdf"`);
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
    res.setHeader("Content-Disposition", `inline; filename="Statement-${safe}.pdf"`);
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
    // Oil-change bookings carry an odometer + oil-sticker photo (base64). Only attach them when
    // present so other bookings never reference these columns (and keep sizes sane).
    if (req.body.odometer_photo) booking.odometer_photo = String(req.body.odometer_photo).slice(0, 700000);
    if (req.body.oil_sticker_photo) booking.oil_sticker_photo = String(req.body.oil_sticker_photo).slice(0, 700000);
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
    // No email here — the customer only sees the on-screen confirmation. The confirmation
    // email is sent manually by staff from the admin (POST /api/admin/bookings/:id/confirm-email).
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
// Mark a booking's confirmation email as sent. The email itself is sent client-side
// from the admin via EmailJS (same account/template as the website); this persists the flag.
app.post("/api/admin/bookings/:id/confirm-sent", requireAdmin, async (req, res) => {
  try {
    let confirm_sent = false;
    try { const upd = await markBookingConfirmSent(req.params.id); confirm_sent = !!(upd && upd.confirm_sent); }
    catch (e) { console.error("confirm_sent not persisted — add a boolean 'confirm_sent' column to the bookings table to remember it:", e.message); confirm_sent = true; }
    res.json({ ok: true, confirm_sent });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not update the booking." }); }
});
// Permanently delete a booking.
app.post("/api/admin/bookings/:id/delete", requireAdmin, async (req, res) => {
  try {
    await deleteBooking(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not delete the booking." }); }
});
// ---- Admin: customer car management ----
// Builds the full detail for one customer: name (Zoho), managed state, and the
// enriched car list (make/model/%-owned looked up from the Muscle Cars fleet).
async function customerDetail(email) {
  const e = (email || "").toLowerCase();
  let customer = null;
  try { customer = await getCustomerByEmail(e); } catch (err) {}
  const managed = await getManagedPlates(e);
  let plates, isManaged;
  if (managed !== null) {
    plates = managed; isManaged = true;
  } else {
    isManaged = false; plates = [];
    if (customer) { try { plates = (await getVehicles(customer.contact_id)).map((v) => v && v.plate).filter(Boolean); } catch (err) {} }
  }
  const cars = plates.map((p) => enrichPlate(p) || { plate: p });
  return { email: e, name: customer ? customer.contact_name : null, found: !!customer, managed: isManaged, active: cars.length > 0, cars };
}

// The effective plate list for a customer right now (managed list, or the
// Zoho-derived list if they've never been managed). Used to seed edits.
async function effectivePlates(email) {
  const e = (email || "").toLowerCase();
  const managed = await getManagedPlates(e);
  if (managed !== null) return managed.slice();
  let plates = [];
  try {
    const customer = await getCustomerByEmail(e);
    if (customer) plates = (await getVehicles(customer.contact_id)).map((v) => v && v.plate).filter(Boolean);
  } catch (err) {}
  return plates;
}

// List of every client who has registered a password.
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try { res.json({ customers: await listUsers() }); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not load customers." }); }
});

// Live plate lookup against the fleet (make / model / %-owned) for the add form.
app.get("/api/admin/lookup", requireAdmin, (req, res) => {
  const plate = (req.query.plate || "").trim();
  if (!plate) return res.json({ found: false, vehicle: null });
  const v = enrichPlate(plate) || { plate };
  res.json({ found: !!(v && v.car), vehicle: v });
});

app.get("/api/admin/customers/:email", requireAdmin, async (req, res) => {
  try { res.json(await customerDetail(req.params.email)); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not load customer." }); }
});

// Add a car (by plate) to a customer.
app.post("/api/admin/customers/:email/cars", requireAdmin, async (req, res) => {
  try {
    const email = (req.params.email || "").toLowerCase();
    const plate = (req.body.plate || "").trim();
    if (!plate) return res.status(400).json({ error: "Enter a number plate." });
    const plates = await effectivePlates(email);
    if (!plates.some((p) => plateIdentity(p) === plateIdentity(plate))) plates.push(plate);
    await setManagedPlates(email, plates);
    res.json(await customerDetail(email));
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not add the car." }); }
});

// Remove a car (by plate) from a customer. Removing the last car makes the
// customer inactive on their home screen.
app.post("/api/admin/customers/:email/cars/remove", requireAdmin, async (req, res) => {
  try {
    const email = (req.params.email || "").toLowerCase();
    const raw = (req.body.plate || "").trim();
    if (!raw) return res.status(400).json({ error: "No plate given." });
    const target = plateIdentity(raw);
    let plates = await effectivePlates(email);
    plates = plates.filter((p) => plateIdentity(p) !== target);
    await setManagedPlates(email, plates);
    res.json(await customerDetail(email));
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not remove the car." }); }
});

// ---- Admin: send / list notifications ----
app.get("/api/admin/notifications", requireAdmin, async (req, res) => {
  try { res.json({ notifications: await listAllNotifications() }); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not load notifications." }); }
});
app.post("/api/admin/notifications", requireAdmin, async (req, res) => {
  try {
    const title = (req.body.title || "").trim();
    const body = (req.body.body || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    if (!title && !body) return res.status(400).json({ error: "Enter a title or a message." });
    const notification = await addNotification({ email, title, body });
    res.json({ ok: true, notification });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not send the notification." }); }
});
app.post("/api/admin/notifications/:id/delete", requireAdmin, async (req, res) => {
  try { await deleteNotification(req.params.id); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not delete the notification." }); }
});

// Registered push devices, grouped by customer + platform (for the admin Push screen).
app.get("/api/admin/push/devices", requireAdmin, async (req, res) => {
  try {
    const rows = await listDevices();
    const byPlatform = {};
    const byEmail = {};
    rows.forEach((r) => {
      const p = (r.platform || "unknown").toLowerCase();
      byPlatform[p] = (byPlatform[p] || 0) + 1;
      const e = ((r.email || "").toLowerCase()) || "(not signed in)";
      if (!byEmail[e]) byEmail[e] = { email: e, count: 0, platforms: {}, last: null };
      byEmail[e].count++;
      byEmail[e].platforms[p] = (byEmail[e].platforms[p] || 0) + 1;
      if (!byEmail[e].last || String(r.updated_at) > String(byEmail[e].last)) byEmail[e].last = r.updated_at;
    });
    const customers = Object.values(byEmail).sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
    res.json({ total: rows.length, byPlatform, customers });
  } catch (e) { console.error("push devices:", e.message); res.status(500).json({ error: "Could not load devices." }); }
});

// Upload a photo for a push notification -> returns a public https URL (stored in Supabase Storage).
app.post("/api/admin/push/upload", requireAdmin, async (req, res) => {
  try {
    const data = String(req.body.data || "");
    if (!data) return res.status(400).json({ error: "No image was provided." });
    if (data.length > 7 * 1024 * 1024) return res.status(413).json({ error: "Image is too large (max ~5 MB)." });
    const url = await uploadPushImage(data);
    res.json({ ok: true, url });
  } catch (e) { console.error("push upload:", e.message); res.status(500).json({ error: e.message || "Could not upload the image." }); }
});

// Send a NATIVE push notification (buzzes the phone) — to one customer (by email) or everyone.
// Dead tokens are cleaned up automatically. Returns how many devices it reached.
app.post("/api/admin/push/send", requireAdmin, async (req, res) => {
  try {
    const title = String(req.body.title || "").slice(0, 120).trim();
    const body = String(req.body.body || "").slice(0, 300).trim();
    if (!title && !body) return res.status(400).json({ error: "Enter a title or message." });
    const image = String(req.body.image || "").trim();
    if (image && !/^https:\/\/\S+$/i.test(image)) return res.status(400).json({ error: "The image must be a public https:// link." });
    const email = String(req.body.email || "").trim().toLowerCase();
    const tokens = email ? await tokensForEmail(email) : await allTokens();
    if (!tokens.length) return res.status(404).json({ error: email ? "That customer has no device registered for notifications yet." : "No devices are registered for notifications yet." });
    const r = await sendToTokens(tokens, { title, body, image, data: (req.body.data && typeof req.body.data === "object") ? req.body.data : {} });
    if (!r.ok) return res.status(503).json({ error: "Push is not configured on the server yet." });
    res.json({ ok: true, sent: r.sent, failed: r.failed, devices: tokens.length });
  } catch (e) { console.error("push send:", e.message); res.status(500).json({ error: "Could not send the notification." }); }
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
// The customer portal (invoices/statement/service/notifications) — opened from
// the V4 app's Sign-in / Account tab. The V4 app itself is served at "/".
// ---- Admin: received payments ----
app.get("/api/admin/payments", requireAdmin, async (req, res) => {
  try { res.json({ payments: await listPayments() }); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not load payments." }); }
});
app.get("/api/admin/payments/:id/proof", requireAdmin, async (req, res) => {
  try { res.json({ proof: await getPaymentProof(req.params.id) }); }
  catch (e) { console.error(e); res.status(502).json({ error: "Could not load proof." }); }
});
app.post("/api/admin/payments/:id/status", requireAdmin, async (req, res) => {
  try {
    const status = req.body.status;
    if (!["Pending", "Confirmed", "Rejected"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    await updatePaymentStatus(req.params.id, status);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not update payment." }); }
});

app.get("/portal", (req, res) => res.sendFile(path.join(__dirname, "public", "portal.html")));

// ---- static frontend ----
// HTML must never be served stale — the packaged app's WebView caches hard, so force it to
// revalidate the pages on every load (assets like images/pdf.js can still cache normally).
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => { if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, must-revalidate"); },
}));

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

// Start the live Firestore fleet loader (no-op unless FIREBASE_SERVICE_ACCOUNT is set).
initFleetLive().catch((e) => console.error("[fleetlive] init error:", e && e.message));
