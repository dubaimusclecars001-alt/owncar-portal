// Sends login codes and booking notifications.
// Priority: Brevo HTTP API (works on hosts that block SMTP, like Render free) >
// SMTP (nodemailer) > console log (local/dev).
import nodemailer from "nodemailer";

const BREVO_KEY = process.env.BREVO_API_KEY;
const SENDER = process.env.BREVO_SENDER || process.env.SMTP_USER || "no-reply@owncar.ae";
const hasSMTP = !!process.env.SMTP_HOST;

let transport = null;
if (hasSMTP) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export const emailConfigured = !!BREVO_KEY || hasSMTP;

async function sendViaBrevo(to, subject, text) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_KEY, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({
      sender: { name: "OWN.CAR", email: SENDER },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) throw new Error("Brevo " + res.status + ": " + (await res.text()));
}

export async function sendLoginCode(to, code) {
  const subject = "Your OWN.CAR login code";
  const text = `Your OWN.CAR portal login code is ${code}. It expires in 10 minutes.`;
  if (BREVO_KEY) { await sendViaBrevo(to, subject, text); return { delivered: true }; }
  if (!transport) { console.log(`[login code] ${to} -> ${code} (email not configured; shown on screen)`); return { delivered: false, code }; }
  await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
  return { delivered: true };
}

export async function sendBookingNotice(booking) {
  const to = process.env.BOOKINGS_NOTIFY_EMAIL;
  const subject = "New maintenance request — OWN.CAR";
  const body = `New maintenance request from ${booking.customer_email}\n\n` +
    `Vehicle: ${booking.vehicle}\nService: ${booking.service_type}\n` +
    `Date: ${booking.preferred_date}  Time: ${booking.time_slot}\nNotes: ${booking.notes || "-"}`;
  if (!to) { console.log("[booking]", body); return; }
  try {
    if (BREVO_KEY) { await sendViaBrevo(to, subject, body); return; }
    if (transport) { await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text: body }); return; }
  } catch (e) { console.error("booking notice failed:", e.message); }
  console.log("[booking]", body);
}
