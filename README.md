# OWN.CAR — Client Portal (custom app)

A branded customer portal for **Muscle Cars Rent A Car LLC**. Clients sign in and see
**only their own** invoices, statement of account, receipts, and can request maintenance —
all read live from **Zoho Books**.

This app is **complete and working**. Out of the box it runs with built-in sample data so
you can see and click it immediately. Then you plug in your Zoho credentials to go live.

---

## 1. See it running (sample data — 3 steps)

You need **Node.js** installed (nodejs.org, the "LTS" version). Then, in a terminal inside
this folder:

```
npm install
copy .env.example .env      (Mac/Linux: cp .env.example .env)
npm start
```

Open **http://localhost:3000** and sign in as **jay@example.com**:

- **First time:** enter the email → a 6-digit code appears on screen (in production it's
  emailed) → enter the code and **create a password**.
- **After that:** email + the password you set.
- **Forgot password:** click "Forgot password?" → a new code is sent → set a new password.

You'll then see the full portal with sample data.

**How client logins work:** there are no usernames/passwords for you to hand out. Anyone
whose email is a **customer in Zoho Books** can set their own password via the email code.
Zoho Books stays the master list of who's allowed in.

---

## 2. Connect your real Zoho Books

### 2a. Create API credentials (one time, free)

1. Go to **https://api-console.zoho.com** (sign in with your Zoho account).
2. Click **Add Client → Self Client → Create**.
3. Open the **Generate Code** tab. In **Scope**, paste:
   `ZohoBooks.invoices.READ,ZohoBooks.contacts.READ,ZohoBooks.customerpayments.READ`
   (These are **read-only** — the app can never change or delete anything in your books.)
4. Choose a duration (10 minutes is fine), any "Scope Description", click **Create**, and
   copy the **code** it shows.
5. You now have three values: **Client ID**, **Client Secret** (both on the Client Secret
   tab), and you'll turn the code into a **Refresh Token** next.

### 2b. Turn the code into a refresh token

Run this once (replace the three values). This is a normal, safe Zoho step:

```
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=THE_CODE_FROM_STEP_2a"
```

Copy the **refresh_token** from the response.

### 2c. Fill in `.env`

Open the `.env` file and set:

```
USE_MOCK=false
ZOHO_ORG_ID=841304922
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
SESSION_SECRET=(any long random text)
```

Restart (`npm start`). The portal now shows **real** Zoho Books data. A client can log in
only if their email exists as a **customer (contact)** in Zoho Books.

> **Note on region:** if your Zoho is not on the global (.com) data centre, change
> `ZOHO_ACCOUNTS_HOST` and `ZOHO_API_HOST` in `.env` to your region (e.g. `.sa`, `.eu`, `.in`).

---

## 3. Email for login codes

So clients receive their login code by email, set the `SMTP_*` values in `.env` (you can use
your Zoho Mail SMTP, or a service like Brevo/SendGrid). Until this is set, codes are shown on
screen — fine for testing, **not** for real clients.

---

## 4. Put it online (hosting)

Easiest free option is **Render.com**:

1. Push this folder to a **GitHub** repo (or upload it).
2. On Render: **New → Web Service**, connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Add all the `.env` values under **Environment**.
5. Deploy. Render gives you a URL like `https://owncar.onrender.com`.
6. (Optional) Point your own domain, e.g. `portal.owncar.ae`, at it.

---

## 5. Before real clients use it — safety checklist

- [ ] `USE_MOCK=false` and real Zoho values set.
- [ ] Log in as **two different** test customers and confirm each sees **only** their own
      invoices. (This is the most important check.)
- [ ] Email (SMTP) configured so codes are emailed, not shown on screen.
- [ ] `SESSION_SECRET` is a long random value; site served over **https** (Render does this).
- [ ] Zoho credentials are **read-only** scopes.
- [ ] Have a developer do a quick security review before onboarding real customers.

---

## Where things are

- `server.js` — the backend (login, sessions, API, data isolation).
- `src/zoho.js` — Zoho Books connection (and sample-data fallback).
- `src/mailer.js` — sends login codes and booking alerts.
- `public/index.html` — the whole front-end (all five screens).
- `data/bookings.json` — maintenance requests clients submit.
