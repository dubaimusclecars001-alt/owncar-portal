import "dotenv/config";
import express from "express";
import session from "express-session";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCustomerByEmail, getInvoices, getPayments, USE_MOCK } from "./src/zoho.js";
import { sendLoginCode, sendBookingNotice, emailConfigured } from "./src/mailer.js";
import { getUser, setUserPassword, verifyUserPassword } from "./src/users.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
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

// ---- helpers ----
function requireAuth(req, res, next) {
  if (req.session && req.session.email) return next();
  return res.status(401).json({ error: "Not signed in" });
}
async function currentCustomer(req) {
  return getCustomerByEmail(req.session.email);
}
const money = (n) => Number(n || 0);

// ---- auth routes ----
// Step 1: enter email. Tells the client whether they already have a password.
app.post("/api/auth/check", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });
    const customer = await getCustomerByEmail(email);
    if (!customer) return res.status(404).json({ error: "We couldn't find an account for that email. Please contact us." });
    const u = getUser(email);
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
  codes.delete(email);
  setUserPassword(email, password);
  req.session.email = email;
  res.json({ ok: true });
});

// Normal login with email + password.
app.post("/api/auth/login", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const customer = await getCustomerByEmail(email);
  if (!customer) return res.status(404).json({ error: "We couldn't find an account for that email." });
  if (!verifyUserPassword(email, password)) return res.status(401).json({ error: "Incorrect password." });
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
    res.json({
      name: c.contact_name, email: c.email, vehicle: c.vehicle,
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
    const entries = [
      ...invoices.map(i => ({ type: "invoice", date: i.date, label: `Invoice ${i.invoice_number}`, debit: money(i.total) })),
      ...payments.map(p => ({ type: "payment", date: p.date, label: `Payment · ${p.payment_mode}`, credit: money(p.amount) })),
    ].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const invoiced = invoices.reduce((s, i) => s + money(i.total), 0);
    const paid = payments.reduce((s, p) => s + money(p.amount), 0);
    const closing = invoices.reduce((s, i) => s + money(i.balance), 0);
    res.json({ entries, summary: { invoiced, paid, closing } });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load statement." }); }
});

app.get("/api/receipts", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const payments = await getPayments(c.contact_id);
    res.json({ payments });
  } catch (e) { console.error(e); res.status(502).json({ error: "Could not load receipts." }); }
});

app.post("/api/bookings", requireAuth, async (req, res) => {
  try {
    const c = await currentCustomer(req);
    const booking = {
      customer_email: c.email,
      vehicle: (req.body.vehicle || "").slice(0, 120),
      service_type: (req.body.service_type || "").slice(0, 60),
      preferred_date: (req.body.preferred_date || "").slice(0, 40),
      time_slot: (req.body.time_slot || "").slice(0, 20),
      notes: (req.body.notes || "").slice(0, 500),
      created: new Date().toISOString(),
      status: "Requested",
    };
    const file = path.join(__dirname, "data", "bookings.json");
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    all.push(booking);
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
    await sendBookingNotice(booking);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not submit booking." }); }
});

app.get("/api/config", (req, res) => res.json({ mock: USE_MOCK, emailConfigured }));

// ---- static frontend ----
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => console.log(`OWN.CAR portal running on http://localhost:${PORT}  (mock=${USE_MOCK})`));
