// Native push notifications (FCM) — Phase 1 (server side).
//
// Device tokens are stored in Supabase (table `push_tokens`, keyed by the token). Sending uses
// firebase-admin's messaging on the SAME Firebase project the apps are registered in, via the
// existing WEBSITE_FIREBASE_SA (falling back to FIREBASE_SERVICE_ACCOUNT). Fully defensive:
// if Supabase or the service account isn't configured, every call is a safe no-op.

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const TOKENS_TABLE = process.env.PUSH_TOKENS_TABLE || "push_tokens";
const usingSupabase = !!(SUPA_URL && SUPA_KEY);
const h = (extra = {}) => ({ apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", ...extra });

// ---------------- image upload (Supabase Storage) ----------------
// Turns an uploaded photo into the public https URL that FCM/APNs require for a notification image.
const PUSH_BUCKET = process.env.PUSH_IMAGE_BUCKET || "push-images";
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady || !usingSupabase) return;
  // Create the public bucket if it doesn't exist yet (already-exists errors are ignored).
  try {
    await fetch(`${SUPA_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ id: PUSH_BUCKET, name: PUSH_BUCKET, public: true }),
    });
  } catch (e) { /* ignore — proceed and let the upload surface any real problem */ }
  bucketReady = true;
}

// Accepts a base64 data URL (data:image/...;base64,....) and returns a public https URL.
export async function uploadPushImage(dataUrl) {
  if (!usingSupabase) throw new Error("Image storage is not configured on the server.");
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || "").trim());
  if (!m) throw new Error("That doesn't look like an image.");
  const mime = m[1];
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw new Error("The image is empty.");
  if (buf.length > 5 * 1024 * 1024) throw new Error("Image is too large (max 5 MB).");
  await ensureBucket();
  const ext = (mime.split("/")[1] || "jpg").toLowerCase().replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "jpg";
  const filePath = `push/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const res = await fetch(`${SUPA_URL}/storage/v1/object/${PUSH_BUCKET}/${filePath}`, {
    method: "POST",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": mime, "x-upsert": "true" },
    body: buf,
  });
  if (!res.ok) throw new Error("Upload failed (" + res.status + "): " + (await res.text().catch(() => "")));
  return `${SUPA_URL}/storage/v1/object/public/${PUSH_BUCKET}/${filePath}`;
}

// ---------------- token storage (Supabase) ----------------

// Upsert a device token -> its owner. A device has one token; re-registering just updates the owner.
export async function saveToken(email, token, platform) {
  if (!usingSupabase || !token) return { ok: false, reason: "not configured" };
  const res = await fetch(`${SUPA_URL}/rest/v1/${TOKENS_TABLE}?on_conflict=token`, {
    method: "POST",
    headers: h({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ token, email: (email || "").toLowerCase() || null, platform: platform || null, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error("token save " + res.status + ": " + (await res.text().catch(() => "")));
  return { ok: true };
}

async function selectTokens(query) {
  if (!usingSupabase) return [];
  const res = await fetch(`${SUPA_URL}/rest/v1/${TOKENS_TABLE}?select=token${query}`, { headers: h() });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return [...new Set(rows.map((r) => r && r.token).filter(Boolean))];
}
export const tokensForEmail = (email) => (email ? selectTokens(`&email=eq.${encodeURIComponent(email.toLowerCase())}`) : Promise.resolve([]));
export const allTokens = () => selectTokens("");

// List registered devices (email + platform + when) for the admin screen. Newest first.
export async function listDevices() {
  if (!usingSupabase) return [];
  const res = await fetch(`${SUPA_URL}/rest/v1/${TOKENS_TABLE}?select=email,platform,updated_at&order=updated_at.desc`, { headers: h() });
  if (!res.ok) return [];
  return await res.json().catch(() => []);
}

// Remove dead/expired tokens (called automatically after a send reports them invalid).
export async function removeTokens(tokens) {
  if (!usingSupabase || !tokens || !tokens.length) return;
  const list = tokens.map((t) => `"${String(t).replace(/[",()]/g, "")}"`).join(",");
  await fetch(`${SUPA_URL}/rest/v1/${TOKENS_TABLE}?token=in.(${list})`, { method: "DELETE", headers: h() }).catch(() => {});
}

// ---------------- FCM sending (firebase-admin) ----------------

let msgPromise = null, disabled = false;
async function getMessaging() {
  if (disabled) return null;
  if (msgPromise) return msgPromise;
  msgPromise = (async () => {
    const raw = process.env.WEBSITE_FIREBASE_SA || process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) { console.log("[push] no Firebase service account set — push sending disabled"); disabled = true; return null; }
    let creds; try { creds = JSON.parse(raw); } catch (e) { console.error("[push] service account is not valid JSON — disabled"); disabled = true; return null; }
    let admin; try { admin = (await import("firebase-admin")).default; } catch (e) { console.error("[push] firebase-admin unavailable — disabled"); disabled = true; return null; }
    try {
      const app = (admin.apps || []).find((a) => a && a.name === "push") || admin.initializeApp({ credential: admin.credential.cert(creds) }, "push");
      return admin.messaging(app);
    } catch (e) { console.error("[push] init failed:", e && e.message, "— disabled"); disabled = true; return null; }
  })();
  return msgPromise;
}

// Only public https images work in a push (FCM/APNs reject http and data: URLs).
function cleanImage(image) {
  const s = typeof image === "string" ? image.trim() : "";
  return /^https:\/\/\S+$/i.test(s) ? s : "";
}

// DATA-ONLY messages: there is NO `notification` block anywhere (not top-level and
// not under `android`). That forces the Android app to render every push itself —
// so it always shows the small white icon, gold accent, the app logo as the large
// icon, expandable text, and buzzes via its "owncar_default" channel — even when the
// app is in the background. The app reads these data keys (all values are strings):
//   title (required), body (required), url (optional https deep-link), type, id, image.
// Sound/vibration come from the app's channel, so we deliberately set no sound here.
function buildMessage({ title, body, data, image }) {
  const img = cleanImage(image);
  const payload = {
    // caller-supplied keys first (e.g. url, type, id) — coerced to strings…
    ...Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [String(k), String(v == null ? "" : v)])),
    // …then the required text keys, which always win.
    title: String(title || "OWN.CAR"),
    body: String(body || ""),
  };
  if (img) payload.image = img;
  return {
    data: payload,
    android: { priority: "high" },
  };
}

// Send to a list of device tokens. Auto-removes tokens FCM reports as dead.
// Returns { ok, sent, failed, invalidTokens }.
export async function sendToTokens(tokens, opts = {}) {
  const messaging = await getMessaging();
  if (!messaging) return { ok: false, reason: "not configured" };
  tokens = [...new Set((tokens || []).filter(Boolean))];
  if (!tokens.length) return { ok: true, sent: 0, failed: 0, invalidTokens: [] };
  const base = buildMessage(opts);
  const invalidTokens = [];
  let sent = 0, failed = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const resp = await messaging.sendEachForMulticast({ ...base, tokens: batch });
    sent += resp.successCount; failed += resp.failureCount;
    resp.responses.forEach((r, idx) => {
      const code = r && r.error && r.error.code;
      if (!r.success && (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument")) {
        invalidTokens.push(batch[idx]);
      }
    });
  }
  if (invalidTokens.length) await removeTokens(invalidTokens).catch(() => {});
  return { ok: true, sent, failed, invalidTokens };
}

// Broadcast to everyone via a topic the apps subscribe to on launch (one call, no token list).
// Not used by Phase 1's admin endpoint yet (that broadcasts over stored tokens) — ready for later.
export async function sendToTopic(topic, opts = {}) {
  const messaging = await getMessaging();
  if (!messaging) return { ok: false, reason: "not configured" };
  const id = await messaging.send({ ...buildMessage(opts), topic: topic || process.env.PUSH_BROADCAST_TOPIC || "all" });
  return { ok: true, id };
}
