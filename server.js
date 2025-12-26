import express from "express";
import fs from "fs";
import path from "path";
import twilio from "twilio";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* ======================================================
   GLOBAL OPTIONS HANDLER (Railway-safe)
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
  const allowed = (process.env.PUBLIC_ORIGIN || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

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
const BOOKINGS_PATH = path.join(DATA_DIR, "bookings.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/* ======================================================
   TWILIO SMS (ALPHANUMERIC SENDER ID)
====================================================== */
let twilioClient = null;

if (
  process.env.TWILIO_ACCOUNT_SID?.startsWith("AC") &&
  process.env.TWILIO_AUTH_TOKEN
) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  } catch (err) {
    console.error("TWILIO INIT ERROR:", err.message);
  }
} else {
  console.warn("Twilio not configured — SMS disabled");
}

/* ======================================================
   STORAGE (JSON)
====================================================== */
function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOOKINGS_PATH)) fs.writeFileSync(BOOKINGS_PATH, "[]", "utf8");
}

function readBookings() {
  ensureStorage();
  return JSON.parse(fs.readFileSync(BOOKINGS_PATH, "utf8"));
}

function writeBookings(data) {
  ensureStorage();
  fs.writeFileSync(BOOKINGS_PATH, JSON.stringify(data, null, 2), "utf8");
}

function newBookingRef() {
  return `TTT-${Math.floor(10000 + Math.random() * 90000)}`;
}

/* ======================================================
   PARSERS
====================================================== */
function extractRouteAndTime(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  const route = lower.match(/(.+?)\s+to\s+(.+?)(\s|$)/);
  if (!route) return null;

  const td = lower.match(/(\d{1,2}:\d{2})\s+(\d{2}\/\d{2}\/\d{4})/);

  let pickup_time_iso = null;
  if (td) {
    const [, time, date] = td;
    const [day, month, year] = date.split("/");
    pickup_time_iso = `${year}-${month}-${day}T${time}:00`;
  }

  return {
    pickup: route[1].trim(),
    dropoff: route[2].trim(),
    pickup_time_iso
  };
}

function extractNamePhone(text) {
  if (!text) return null;
  const phoneMatch = text.match(/(\+44\s?7\d{3}\s?\d{6}|07\d{9})/);
  if (!phoneMatch) return null;

  const phone = phoneMatch[1].replace(/\s+/g, "");
  const name = text.replace(phoneMatch[1], "").trim() || "Customer";

  return { name, phone };
}

function isYes(text) {
  return /^(yes|yep|yeah|ok|okay|confirm|book)/i.test(text || "");
}

function isNo(text) {
  return /^(no|cancel|stop)/i.test(text || "");
}

/* ======================================================
   GEOCODING (OpenStreetMap)
====================================================== */
async function geocode(place) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(place)}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "TTTaxis-Dispatch/1.0" }
  });

  const data = await res.json();
  if (!data || !data.length) throw new Error(`Geocode failed: ${place}`);

  return { lat: +data[0].lat, lon: +data[0].lon };
}

/* ======================================================
   DISTANCE (OSRM)
====================================================== */
async function getMiles(pickup, dropoff) {
  const a = await geocode(pickup);
  const b = await geocode(dropoff);

  const url =
    "https://router.project-osrm.org/route/v1/driving/" +
    `${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes?.length) throw new Error("Route not found");

  return Math.round((data.routes[0].distance / 1609.34) * 10) / 10;
}

/* ======================================================
   PRICING (GBP)
====================================================== */
function calculateFareGBP(miles, isoTime) {
  let price = Math.max(MIN_FARE_GBP, miles * PER_MILE_GBP);
  if (isoTime && new Date(isoTime).getHours() >= NIGHT_START_HOUR) {
    price *= NIGHT_MULTIPLIER;
  }
  return Math.round(price * 100) / 100;
}

/* ======================================================
   SMS HELPER
====================================================== */
async function sendSMSBooking(booking) {
  if (!twilioClient) return;

  const message =
    `TTTaxis NEW BOOKING\n` +
    `Ref: ${booking.id}\n` +
    `Pickup: ${booking.pickup}\n` +
    `Dropoff: ${booking.dropoff}\n` +
    (booking.pickup_time_iso ? `Time: ${booking.pickup_time_iso}\n` : "") +
    `Fare: £${booking.price_gbp}\n` +
    `Customer: ${booking.customer_name}\n` +
    `Phone: ${booking.customer_phone}`;

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_SMS_FROM, // "TTTaxis"
      to: process.env.DISPATCH_SMS_TO,   // +44...
      body: message
    });
  } catch (err) {
    console.error("SMS SEND ERROR:", err.message);
  }
}

/* ======================================================
   SESSION STATE
====================================================== */
const pending = new Map();

/* ======================================================
   CHAT ENDPOINT
====================================================== */
app.post("/chat", async (req, res) => {
  try {
    const messages = req.body.messages || [];
    const last = messages[messages.length - 1]?.content || "";
    const key = req.headers.origin || "default";

    const extracted = extractRouteAndTime(last);
    if (extracted) {
      const miles = await getMiles(extracted.pickup, extracted.dropoff);
      const price = calculateFareGBP(miles, extracted.pickup_time_iso);

      pending.set(key, { ...extracted, miles, price });

      return res.json({
        reply:
          `Your journey from ${extracted.pickup} to ${extracted.dropoff}` +
          (extracted.pickup_time_iso ? ` at ${extracted.pickup_time_iso}` : "") +
          ` is approximately ${miles} miles. ` +
          `The estimated fare is £${price}. Would you like to proceed with the booking?`
      });
    }

    if (isNo(last)) {
      pending.delete(key);
      return res.json({ reply: "No problem — booking cancelled." });
    }

    if (isYes(last)) {
      if (!pending.has(key)) {
        return res.json({ reply: "Please tell me your pickup, dropoff and time/date first." });
      }
      return res.json({ reply: "Great — please reply with your name and mobile number." });
    }

    const np = extractNamePhone(last);
    if (np && pending.has(key)) {
      const p = pending.get(key);
      const booking = {
        id: newBookingRef(),
        created_at: new Date().toISOString(),
        pickup: p.pickup,
        dropoff: p.dropoff,
        pickup_time_iso: p.pickup_time_iso,
        miles: p.miles,
        price_gbp: p.price,
        customer_name: np.name,
        customer_phone: np.phone,
        status: "NEW"
      };

      const bookings = readBookings();
      bookings.unshift(booking);
      writeBookings(bookings);
      pending.delete(key);

      sendSMSBooking(booking);

      return res.json({
        reply:
          `Booked. Reference ${booking.id}. ` +
          `Fare £${booking.price_gbp}. We will confirm your driver shortly.`
      });
    }

    return res.json({
      reply:
        "I can take a booking. Example: Kendal to Manchester Airport 23:30 25/12/2025"
    });

  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.json({ reply: "Sorry — I couldn't process that. Please call." });
  }
});

/* ======================================================
   ADMIN BOOKINGS
====================================================== */
app.get("/admin/bookings", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ bookings: readBookings() });
});

/* ======================================================
   HEALTH
====================================================== */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ======================================================
   START SERVER
====================================================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});

