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

function buildMessage({ title, body, data }) {
  return {
    notification: { title: title || "OWN.CAR", body: body || "" },
    data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [String(k), String(v)])),
    android: { priority: "high", notification: { sound: "default", channelId: "owncar_default" } },
    apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
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
