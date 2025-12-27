import express from "express";
import fs from "fs";
import path from "path";

console.log("SERVER FILE LOADED");

const app = express();
app.use(express.json());

/* ======================================================
   OPTIONS + CORS (WordPress / Railway safe)
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
   CONFIG (GBP PRICING)
====================================================== */
const MIN_FARE_GBP = Number(process.env.MIN_FARE_GBP || 4.2);
const PER_MILE_GBP = Number(process.env.PER_MILE_GBP || 2.2);
const NIGHT_START_HOUR = Number(process.env.NIGHT_START_HOUR || 23);
const NIGHT_MULTIPLIER = Number(process.env.NIGHT_MULTIPLIER || 1.5);

const DATA_DIR = process.env.DATA_DIR || "/tmp/tttaxis";
const BOOKINGS_PATH = path.join(DATA_DIR, "bookings.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

/* ======================================================
   STORAGE (JSON – TEMP UNTIL POSTGRES)
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
   GEOCODING (UK-ONLY + CUMBRIA/LANCASHIRE BIAS)
====================================================== */
async function geocode(place) {
  // UK-only geocoding with Cumbria / Lancashire bias
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(place)}` +
    `&countrycodes=gb` +
    `&viewbox=-4.8,55.2,-2.2,53.5` +
    `&bounded=1` +
    `&format=json&limit=1`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "TTTaxis-Booking/1.0 (UK-only)"
    }
  });

  const data = await res.json();

  if (!data || !data.length) {
    throw new Error(`UK geocode failed: ${place}`);
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon)
  };
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
   QUOTE ENDPOINT (LIVE PRICING)
====================================================== */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, pickup_time_iso } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing pickup or dropoff" });
    }

    const miles = await getMiles(pickup, dropoff);
    const price = calculateFareGBP(miles, pickup_time_iso || null);

    res.json({ miles, price_gbp: price });
  } catch (err) {
    console.error("QUOTE ERROR:", err.message);
    res.status(500).json({
      error: "Unable to calculate price. Please check locations."
    });
  }
});

/* ======================================================
   BOOKING ENDPOINT (BOOK NOW BUTTON)
====================================================== */
app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      dropoff,
      pickup_time_iso,
      name,
      phone,
      notes
    } = req.body;

    if (!pickup || !dropoff || !name || !phone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const miles = await getMiles(pickup, dropoff);
    const price = calculateFareGBP(miles, pickup_time_iso || null);

    const booking = {
      id: newBookingRef(),
      created_at: new Date().toISOString(),

