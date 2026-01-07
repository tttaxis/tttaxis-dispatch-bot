import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import { Pool } from "pg";

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   RAW BODY (Square Webhook)
========================= */
app.use("/square/webhook", express.raw({ type: "application/json" }));

/* =========================
   GENERAL MIDDLEWARE
========================= */
app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

/* =========================
   SENDGRID SETUP
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.warn("SENDGRID_API_KEY not set");
}

/* =========================
   DATABASE (Postgres)
========================= */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;

async function dbInit() {
  if (!pool) {
    console.warn("DATABASE_URL not set – DB features disabled");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      booking_id TEXT UNIQUE,
      booking_ref TEXT UNIQUE,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      pickup TEXT,
      dropoff TEXT,
      pickup_time TEXT,
      additional_info TEXT,
      quote_price_gbp_inc_vat NUMERIC,
      payment_type TEXT,
      amount_due NUMERIC,
      amount_paid NUMERIC,
      payment_status TEXT DEFAULT 'pending',
      square_payment_id TEXT,
      square_note TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("DB: bookings table ready");
}

/* =========================
   HELPERS
========================= */
function nowIso() {
  return new Date().toISOString();
}

/* =========================
   PRICING RULES
========================= */
const VAT_RATE = 0.2;
const MIN_FARE = 4.2;
const LOCAL_PER_MILE = 2.2;

const FIXED_AIRPORT_FARES = [
  { match: "manchester", price: 120 },
  { match: "liverpool", price: 132 },
  { match: "leeds", price: 98 }
];

/* =========================
   GEO + ROUTING
========================= */
async function geocodeUK(address) {
  const res = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: {
      q: address + ", United Kingdom",
      format: "json",
      limit: 1,
      countrycodes: "gb"
    },
    headers: { "User-Agent": "TTTaxis Booking System" }
  });

  if (!res.data?.length) throw new Error("Geocoding failed");

  return {
    lat: Number(res.data[0].lat),
    lon: Number(res.data[0].lon)
  };
}

async function calculateMiles(pickup, dropoff) {
  const from = await geocodeUK(pickup);
  const to = await geocodeUK(dropoff);

  try {
    const res = await axios.post(
      "https://api.openrouteservice.org/v2/directions/driving-car",
      { coordinates: [[from.lon, from.lat], [to.lon, to.lat]] },
      {
        headers: {
          Authorization: process.env.ORS_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.features[0].properties.summary.distance / 1609.344;
  } catch {
    const R = 3958.8;
    const dLat = (to.lat - from.lat) * Math.PI / 180;
    const dLon = (to.lon - from.lon) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(from.lat * Math.PI / 180) *
        Math.cos(to.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) * 1.25;
  }
}

async function calculatePrice(pickup, dropoff) {
  const p = pickup.toLowerCase();
  const d = dropoff.toLowerCase();

  for (const rule of FIXED_AIRPORT_FARES) {
    if (p.includes(rule.match) || d.includes(rule.match)) {
      return { fixed: true, miles: null, price: rule.price * (1 + VAT_RATE) };
    }
  }

  const miles = await calculateMiles(pickup, dropoff);
  const base = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
  return { fixed: false, miles, price: base * (1 + VAT_RATE) };
}

/* =========================
   ROUTES
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff } = req.body;
    if (!pickup || !dropoff) return res.status(400).json({ error: "Missing locations" });

    const q = await calculatePrice(pickup, dropoff);

    res.json({
      fixed: q.fixed,
      miles: q.miles,
      price_gbp_inc_vat: Number(q.price.toFixed(2))
    });
  } catch {
    res.status(422).json({ error: "Unable to calculate quote" });
  }
});

/* =========================
   START SERVER (ONE TIME ONLY)
========================= */
(async () => {
  try {
    await dbInit();
  } catch (e) {
    console.error("DB init failed:", e);
  }

  app.listen(PORT, () => {
    console.log("TTTaxis backend running on port " + PORT);
  });
})();
