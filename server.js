import express from "express";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* ======================================================
   GLOBAL OPTIONS HANDLER (prevents Railway 502 preflight)
====================================================== */
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
    return res.status(200).end();
  }
  next();
});

/* ======================================================
   CORS (WordPress)
====================================================== */
app.use((req, res, next) => {
  const allowed = (process.env.PUBLIC_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  next();
});

/* ======================================================
   CONFIG (GBP)
====================================================== */
const MIN_FARE_GBP = Number(process.env.MIN_FARE_GBP || 8);
const PER_MILE_GBP = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START_HOUR = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

const DATA_DIR = process.env.DATA_DIR || "/tmp/tttaxis";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set this in Railway

/* ======================================================
   LIGHTWEIGHT STORAGE (JSON)
====================================================== */
import fs from "fs";
import path from "path";

const BOOKINGS_PATH = path.join(DATA_DIR, "bookings.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOOKINGS_PATH)) fs.writeFileSync(BOOKINGS_PATH, JSON.stringify([]), "utf8");
}

function readBookings() {
  ensureDataDir();
  const raw = fs.readFileSync(BOOKINGS_PATH, "utf8");
  return JSON.parse(raw || "[]");
}

function writeBookings(bookings) {
  ensureDataDir();
  fs.writeFileSync(BOOKINGS_PATH, JSON.stringify(bookings, null, 2), "utf8");
}

function newBookingRef() {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `TTT-${n}`;
}

/* ======================================================
   PARSERS (deterministic)
====================================================== */
function extractRouteAndTime(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // Route: "kendal to manchester airport"
  const route = lower.match(/(.+?)\s+to\s+(.+?)(\s|$)/);
  if (!route) return null;

  // Time+Date: "23:30 25/12/2025"
  const td = lower.match(/(\d{1,2}:\d{2})\s+(\d{2}\/\d{2}\/\d{4})/);

  let pickup_time_iso = null;
  if (td) {
    const [, time, date] = td;
    const [day, month, year] = date.split("/");
    pickup_time_iso = `${year}-${month}-${day}T${time}:00`;
  }

  // Optional passengers "x2" or "2 passengers"
  let passengers = null;
  const pax1 = lower.match(/\bx(\d{1,2})\b/);
  const pax2 = lower.match(/\b(\d{1,2})\s*(passenger|passengers|pax)\b/);
  if (pax1) passengers = Number(pax1[1]);
  else if (pax2) passengers = Number(pax2[1]);

  return {
    pickup: route[1].trim(),
    dropoff: route[2].trim(),
    pickup_time_iso,
    passengers,
  };
}

function extractNamePhone(text) {
  if (!text) return null;
  const t = text.trim();

  // UK-ish phone (basic): allow +44 or 07… with spaces
  const phoneMatch = t.match(/(\+44\s?7\d{3}\s?\d{6}|07\d{3}\s?\d{6}|07\d{9})/);
  if (!phoneMatch) return null;

  const phone = phoneMatch[1].replace(/\s+/g, "");

  // Name: take everything before phone, strip punctuation
  const namePart = t.split(phoneMatch[1])[0].trim().replace(/[-–—,:]+$/g, "").trim();
  const name = namePart.length >= 2 ? namePart : null;

  return { name, phone };
}

function isYes(text) {
  if (!text) return false;
  const v = text.toLowerCase().trim();
  return ["yes", "yeah", "yep", "y", "ok", "okay", "book it", "confirm", "go ahead", "please book"].some(k => v === k || v.includes(k));
}

function isNo(text) {
  if (!text) return false;
  const v = text.toLowerCase().trim();
  return ["no", "nope", "nah", "cancel", "stop"].some(k => v === k || v.includes(k));
}

/* ======================================================
   DISTANCE (OSRM - no Google)
====================================================== */
async function getMiles(pickup, dropoff) {
  const url =
    "https://router.project-osrm.org/route/v1/driving/" +
    `${encodeURIComponent(pickup)};${encodeURIComponent(dropoff)}?overview=false`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes || !data.routes.length) {
    throw new Error("Route not found");
  }

  return Math.round((data.routes[0].distance / 1609.34) * 10) / 10;
}

/* ======================================================
   PRICING (GBP)
====================================================== */
function calculateFareGBP(miles, pickupTimeISO) {
  let price = Math.max(MIN_FARE_GBP, miles * PER_MILE_GBP);

  if (pickupTimeISO) {
    const hour = new Date(pickupTimeISO).getHours();
    if (hour >= NIGHT_START_HOUR) price *= NIGHT_MULTIPLIER;
  }

  return Math.round(price * 100) / 100;
}

/* ======================================================
   SESSION STATE (in-memory)
   - keeps a short-lived "pending quote" per visitor
====================================================== */
const pending = new Map(); // key -> { route, miles, price, createdAt }
const PENDING_TTL_MS = 30 * 60 * 1000;

function sessionKey(req) {
  // Prefer explicit session id from client if present
  const sid = req.body?.session_id;
  if (sid && typeof sid === "string" && sid.length >= 6) return `sid:${sid}`;
  // Fallback: origin + IP (works well enough for WordPress widget)
  const origin = req.headers.origin || "no-origin";
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "ip").toString();
  return `${origin}|${ip}`;
}

function setPending(key, value) {
  pending.set(key, { ...value, createdAt: Date.now() });
}

function getPending(key) {
  const v = pending.get(key);
  if (!v) return null;
  if (Date.now() - v.createdAt > PENDING_TTL_MS) {
    pending.delete(key);
    return null;
  }
  return v;
}

function clearPending(key) {
  pending.delete(key);
}

/* ======================================================
   ROUTES
====================================================== */

// Explicit /chat preflight (extra safety)
app.options("/chat", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
  return res.status(200).end();
});

app.post("/chat", async (req, res) => {
  try {
    const key = sessionKey(req);

    const messages = req.body.messages || [];
    const last = messages[messages.length - 1]?.content || "";

    // 1) If user provides route/time => quote immediately (no looping)
    const extracted = extractRouteAndTime(last);
    if (extracted && extracted.pickup && extracted.dropoff) {
      const miles = await getMiles(extracted.pickup, extracted.dropoff);
      const price = calculateFareGBP(miles, extracted.pickup_time_iso);

      setPending(key, {
        pickup: extracted.pickup,
        dropoff: extracted.dropoff,
        pickup_time_iso: extracted.pickup_time_iso,
        passengers: extracted.passengers,
        miles,
        price,
      });

      return res.json({
        reply:
          `Your journey from ${extracted.pickup} to ${extracted.dropoff}` +
          (extracted.pickup_time_iso ? ` at ${extracted.pickup_time_iso}` : "") +
          ` is approximately ${miles} miles. ` +
          `The estimated fare is £${price}. ` +
          `Would you like to proceed with the booking? (Yes/No)`,
      });
    }

    // 2) If user says "no" => cancel pending
    if (isNo(last)) {
      clearPending(key);
      return res.json({ reply: "No problem — booking cancelled. If you need anything else, tell me your pickup, dropoff and time/date." });
    }

    // 3) If user says "yes" and we have a pending quote => ask for name/phone
    if (isYes(last)) {
      const p = getPending(key);
      if (!p) {
        return res.json({ reply: "Please tell me your pickup, dropoff, and time/date first (e.g., Kendal to Manchester Airport 23:30 25/12/2025)." });
      }
      return res.json({ reply: "Great. Please reply with your name and mobile number (e.g., Terry 07500 123456)." });
    }

    // 4) If user provides name/phone and we have a pending quote => create booking
    const np = extractNamePhone(last);
    if (np) {
      const p = getPending(key);
      if (!p) {
        return res.json({ reply: "Thanks — please tell me your pickup, dropoff, and time/date so I can quote and book it." });
      }

      const booking = {
        id: newBookingRef(),
        created_at: new Date().toISOString(),
        status: "NEW",
        pickup: p.pickup,
        dropoff: p.dropoff,
        pickup_time_iso: p.pickup_time_iso,
        passengers: p.passengers || null,
        miles: p.miles,
        price_gbp: p.price,
        customer_name: np.name || "Customer",
        customer_phone: np.phone,
      };

      const bookings = readBookings();
      bookings.unshift(booking);
      writeBookings(bookings);

      clearPending(key);

      return res.json({
        reply:
          `Booked. Reference ${booking.id}. ` +
          `Pickup: ${booking.pickup}. Dropoff: ${booking.dropoff}. ` +
          (booking.pickup_time_iso ? `Time: ${booking.pickup_time_iso}. ` : "") +
          `Estimated fare: £${booking.price_gbp}. ` +
          `We will confirm your driver shortly.`,
      });
    }

    // 5) Default prompt (no looping)
    return res.json({
      reply:
        "I can take a booking. Please tell me your pickup, dropoff and time/date. " +
        "Example: Kendal to Manchester Airport 23:30 25/12/2025",
    });

  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.json({ reply: "Sorry — I couldn't process that. Please call." });
  }
});

/* Admin: list bookings */
app.get("/admin/bookings", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const bookings = readBookings();
    res.json({ bookings });
  } catch (err) {
    console.error("ADMIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* Health */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* Start */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});
