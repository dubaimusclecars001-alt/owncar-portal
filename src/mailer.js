// Sends login codes and booking notifications. When SMTP is not configured,
// it "sends" by logging to the console and returning the code (dev/testing).
import nodemailer from "nodemailer";

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

export const emailConfigured = hasSMTP;

export async function sendLoginCode(to, code) {
  const subject = "Your OWN.CAR login code";
  const text = `Your OWN.CAR portal login code is ${code}. It expires in 10 minutes.`;
  if (!transport) {
    console.log(`[login code] ${to} -> ${code}  (SMTP not configured; showing on screen)`);
    return { delivered: false, code };
  }
  await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
  return { delivered: true };
}

export async function sendBookingNotice(booking) {
  const to = process.env.BOOKINGS_NOTIFY_EMAIL;
  const body = `New maintenance request from ${booking.customer_email}\n\n` +
    `Vehicle: ${booking.vehicle}\nService: ${booking.service_type}\n` +
    `Date: ${booking.preferred_date}  Time: ${booking.time_slot}\nNotes: ${booking.notes || "-"}`;
  if (!transport || !to) { console.log("[booking]", body); return; }
  await transport.sendMail({ from: process.env.MAIL_FROM, to, subject: "New maintenance request — OWN.CAR", text: body });
}
