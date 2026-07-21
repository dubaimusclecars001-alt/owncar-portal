// Live fleet data from the Muscle Cars Firestore ("cars" collection).
//
// Activated ONLY when the FIREBASE_SERVICE_ACCOUNT env var is set (a Firebase
// service-account key, as a JSON string). When active, it loads the whole `cars`
// collection into memory and refreshes every ~10 minutes, so changes made in the
// Muscle Cars software (muscle-cars-ea711.web.app) show up here automatically.
//
// It is fully optional and defensive: if the env var is missing, the JSON is bad,
// firebase-admin can't load, or Firestore is unreachable, it simply stays disabled
// and the app keeps using the bundled snapshot in fleet.js. It never throws.

import { makeIndex } from "./fleet.js";

let liveLookupFn = null; // set once data has loaded
let started = false;
let lastCount = 0;
let lastLoadedAt = 0;

// Map a Firestore `cars` document to our internal record shape.
function recordFromDoc(d) {
  const brand = String(d.brand || "").trim();
  const model = String(d.model || "").trim();
  const car = `${brand} ${model}`.trim();
  const num = String(d.number == null ? "" : d.number).replace(/[^0-9]/g, "");
  const code = String(d.code || "").toUpperCase().replace(/[^A-Z]/g, "");

  let percent = null;
  const cp = d.contractPercent;
  if (cp !== undefined && cp !== null && cp !== "") {
    const n = Math.round(Number(cp));
    if (!Number.isNaN(n)) percent = Math.max(0, Math.min(100, n));
  }

  let months = "";
  if (d.paidInstallments !== undefined && d.paidInstallments !== null && d.contractMonths) {
    months = `${d.paidInstallments}/${d.contractMonths}`;
  }

  return { car, year: String(d.year || ""), color: String(d.color || ""), percent, months, code, num };
}

export function recordsFromDocs(docs) {
  const out = [];
  for (const d of docs) {
    const rec = recordFromDoc(d);
    if (rec.num) out.push(rec);
    // If a car was re-plated, also index its new plate so either matches.
    const npNum = String(d.newPlate || "").replace(/[^0-9]/g, "");
    const npCode = String(d.newPlate || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (npNum && npNum !== rec.num) out.push({ ...rec, code: npCode, num: npNum });
  }
  return out;
}

// Synchronous lookup against the most recently loaded live data.
// Returns null when live data isn't available (caller then falls back to snapshot).
export function liveLookup(plate) {
  return liveLookupFn ? liveLookupFn(plate) : null;
}

export function liveStatus() {
  return { active: !!liveLookupFn, cars: lastCount, lastLoadedAt };
}

// Start the background loader. Safe to call once at server startup.
export async function initFleetLive() {
  if (started) return;
  started = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log("[fleetlive] FIREBASE_SERVICE_ACCOUNT not set — using bundled fleet snapshot");
    return;
  }

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    console.error("[fleetlive] FIREBASE_SERVICE_ACCOUNT is not valid JSON — using snapshot");
    return;
  }

  let admin;
  try {
    admin = (await import("firebase-admin")).default;
    if (!admin.apps || !admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(creds) });
    }
  } catch (e) {
    console.error("[fleetlive] firebase-admin init failed:", e && e.message, "— using snapshot");
    return;
  }

  const refresh = async () => {
    try {
      const snap = await admin.firestore().collection("cars").get();
      const records = recordsFromDocs(snap.docs.map((x) => x.data()));
      liveLookupFn = makeIndex(records);
      lastCount = snap.size;
      lastLoadedAt = Date.now();
      console.log(`[fleetlive] loaded ${snap.size} cars from Firestore (live)`);
    } catch (e) {
      console.error("[fleetlive] refresh failed:", e && e.message);
    }
  };

  await refresh();
  setInterval(refresh, 10 * 60 * 1000); // refresh every 10 minutes
}
