// Writes payment status back to the website's Firebase `applications` collection
// (project owncar-website-97c05) when a website card payment is confirmed via Foloosi.
//
// Service account comes from WEBSITE_FIREBASE_SA (a JSON string), falling back to
// FIREBASE_SERVICE_ACCOUNT. Runs on a NAMED firebase-admin app ("appswrite") so it
// never collides with the fleet loader's default app. Fully defensive: if it isn't
// configured or firebase-admin is unavailable, every call is a no-op (never throws).

const COLLECTION = process.env.APPLICATIONS_COLLECTION || "applications";
let dbPromise = null;
let disabled = false;
let adminMod = null;   // the firebase-admin module, kept so we can use FieldValue.arrayUnion

async function getDb() {
  if (disabled) return null;
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const raw = process.env.WEBSITE_FIREBASE_SA || process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) { console.log("[appswrite] no Firebase service account set — website payment write disabled"); disabled = true; return null; }
    let creds;
    try { creds = JSON.parse(raw); } catch (e) { console.error("[appswrite] service account is not valid JSON — disabled"); disabled = true; return null; }
    let admin;
    try { admin = (await import("firebase-admin")).default; adminMod = admin; } catch (e) { console.error("[appswrite] firebase-admin unavailable — disabled"); disabled = true; return null; }
    try {
      const existing = (admin.apps || []).find((a) => a && a.name === "appswrite");
      const app = existing || admin.initializeApp({ credential: admin.credential.cert(creds) }, "appswrite");
      return admin.firestore(app);
    } catch (e) { console.error("[appswrite] init failed:", e && e.message, "— disabled"); disabled = true; return null; }
  })();
  return dbPromise;
}

// Mark a website subscription application (matched by its OWN-XXXX `ref`) as paid.
// Sets exactly the fields the website admin expects.
export async function markApplicationPaid(ref, { transaction_no = "", paidAmount = 0 } = {}) {
  if (!ref) return { ok: false, reason: "no ref" };
  const db = await getDb();
  if (!db) return { ok: false, reason: "not configured" };
  const snap = await db.collection(COLLECTION).where("ref", "==", ref).limit(1).get();
  if (snap.empty) { console.warn("[appswrite] no application found for ref", ref); return { ok: false, reason: "not found" }; }
  const doc = snap.docs[0];
  await doc.ref.set({
    paymentStatus: "paid",
    confirmSent: true,
    transaction_no: String(transaction_no || ""),
    paidAmount: Number(paidAmount) || 0,
    paidAt: Date.now(),
  }, { merge: true });
  console.log("[appswrite] marked application paid:", ref, doc.id);

  // Booked = hide the car from the website. The website reads site/config.hidden. Defensive:
  // never let a hide failure undo the paid write above.
  try {
    const carId = ((doc.data() || {}).car || {}).id;
    if (carId && adminMod) {
      await db.collection("site").doc("config").set(
        { hidden: adminMod.firestore.FieldValue.arrayUnion(carId) }, { merge: true }
      );
      console.log("[appswrite] car hidden from website:", carId);
    }
  } catch (e) { console.error("[appswrite] hide car failed:", e && e.message); }

  return { ok: true, id: doc.id };
}
