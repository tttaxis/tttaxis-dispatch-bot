/* =========================
   IMPORTS
========================= */
import express from "express";
import cors from "cors";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import axios from "axios";

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   ENV CHECKS
========================= */
const requiredEnv = ["SENDGRID_API_KEY", "SENDGRID_FROM", "ORS_API_KEY"];
for (const k of requiredEnv) {
  if (!process.env[k]) console.error(`❌ ${k} missing`);
}

/* =========================
   SENDGRID
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json({ limit: "256kb" }));

app.use(
  cors({
    origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

/* =========================
   PRICING RULES
========================= */
const VAT_RATE = 0.2;
const MIN_FARE = 4.2;
const LOCAL_PER_MILE = 2.2;

const FIXED_AIRPORT_FARES = [
  { match: "manchester", price: 120 },
  { match: "liverpool", price: 132 },
  { match: "leeds", price: 98 },
];

/* =========================
   GEO (UK ONLY) - NOMINATIM
========================= */
async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(`${address}, United Kingdom`)}` +
    "&format=json&limit=1&countrycodes=gb";

  // Nominatim requires a valid User-Agent
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "TTTaxis Booking System - terry@tttaxis.uk",
    },
    timeout: 12_000,
  });

  const data = res.data;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No geocode result for: ${address}`);
  }

  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

/* =========================
   ROUTING (DRIVING DISTANCE) - OPENROUTESERVICE
========================= */
async function routeMilesORS(from, to) {
  if (!process.env.ORS_API_KEY) {
    throw new Error("ORS_API_KEY missing - cannot route");
  }

  const orsUrl = "https://api.openrouteservice.org/v2/directions/driving-car";

  const res = await axios.post(
    orsUrl,
    {
      coordinates: [
        [from.lon, from.lat],
        [to.lon, to.lat],
      ],
    },
    {
      headers: {
        Authorization: process.env.ORS_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );

  const meters = res.data?.features?.[0]?.properties?.summary?.distance;
  if (typeof meters !== "number") {
    throw new Error("ORS returned no distance");
  }

  const miles = meters / 1609.344;
  return miles;
}

/* =========================
   CALCULATE MILES (END-TO-END)
========================= */
async function calculateMiles(pickup, dropoff) {
  const from = await geocodeUK(pickup);
  const to = await geocodeUK(dropoff);
  const miles = await routeMilesORS(from, to);

  // Defensive sanity check
  if (!Number.isFinite(miles) || miles <= 0) {
    throw new Error("Invalid miles result");
  }

  return miles;
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "tttaxis-booking", time: new Date().toISOString() });
});

/* =========================
   QUOTE ROUTE
========================= */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff } = req.body || {};

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const pickupLc = String(pickup).toLowerCase();
    const dropoffLc = String(dropoff).toLowerCase();

    // Fixed airport fares
    for (const rule of FIXED_AIRPORT_FARES) {
      if (pickupLc.includes(rule.match) || dropoffLc.includes(rule.match)) {
        const total = Number((rule.price * (1 + VAT_RATE)).toFixed(2));
        return res.json({
          fixed: true,
          miles: null,
          price_gbp: total,
          note: "All prices include VAT",
        });
      }
    }

    // Distance pricing
    const miles = await calculateMiles(pickup, dropoff);
    const base = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
    const total = Number((base * (1 + VAT_RATE)).toFixed(2));

    return res.json({
      fixed: false,
      miles: Number(miles.toFixed(2)),
      price_gbp: total,
      note: "All prices include VAT",
    });
  } catch (err) {
    console.error("QUOTE ERROR:", err?.message || err);
    return res.status(422).json({ error: "Unable to calculate distance" });
  }
});

/* =========================
   BOOKING + EMAILS
========================= */
app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      dropoff,
      pickup_time_iso,
      name,
      phone,
      email,
      price_gbp,
    } = req.body || {};

    // Basic validation
    if (!pickup || !dropoff || !name || !phone || typeof price_gbp !== "number") {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    const booking = {
      id: crypto.randomUUID(),
      pickup,
      dropoff,
      pickup_time_iso: pickup_time_iso || null,
      name,
      phone,
      email: email || null,
      price_gbp,
      created_at: new Date().toISOString(),
    };

    // If SendGrid not configured, still return success (but log)
    if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM) {
      console.error("SendGrid not configured; booking created without emails");
      return res.json({ success: true, booking, emails_sent: false });
    }

    // Customer email (optional)
    if (email) {
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM,
        subject: "Your TTTaxis Booking Confirmation",
        text: `Thank you for booking with TTTaxis.

Reference: ${booking.id}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp}

All prices include VAT.

TTTaxis
01539 556160`,
      });
    }

    // Operator email
    await sgMail.send({
      to: process.env.SENDGRID_FROM,
      from: process.env.SENDGRID_FROM,
      subject: "New Booking Received",
      text: `NEW BOOKING

Reference: ${booking.id}
Name: ${name}
Phone: ${phone}
Email: ${email || "N/A"}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp}`,
    });

    return res.json({ success: true, booking, emails_sent: true });
  } catch (err) {
    console.error("BOOKING ERROR:", err?.response?.data || err?.message || err);
    return res.status(500).json({ success: false });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`✅ TTTaxis backend listening on port ${PORT}`);
});

