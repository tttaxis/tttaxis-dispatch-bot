import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   ENV CHECKS
========================= */
if (!process.env.SENDGRID_API_KEY) console.error("SENDGRID_API_KEY missing");
if (!process.env.SENDGRID_FROM) console.error("SENDGRID_FROM missing");
if (!process.env.ORS_API_KEY) console.error("ORS_API_KEY missing");

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
    allowedHeaders: ["Content-Type"]
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
  { match: "leeds", price: 98 }
];

/* =========================
   GEOCODING (UK ONLY)
========================= */
async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    "?q=" +
    encodeURIComponent(address + ", United Kingdom") +
    "&format=json&limit=1&countrycodes=gb";

  const res = await axios.get(url, {
    headers: { "User-Agent": "TTTaxis Booking System" },
    timeout: 12000
  });

  if (!res.data || !res.data.length) {
    throw new Error("Geocode failed for " + address);
  }

  return {
    lat: Number(res.data[0].lat),
    lon: Number(res.data[0].lon)
  };
}

/* =========================
   ROUTING (ORS)
========================= */
async function routeMilesORS(from, to) {
  const res = await axios.post(
    "https://api.openrouteservice.org/v2/directions/driving-car",
    {
      coordinates: [
        [from.lon, from.lat],
        [to.lon, to.lat]
      ]
    },
    {
      headers: {
        Authorization: process.env.ORS_API_KEY,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  const meters =
    res.data?.features?.[0]?.properties?.summary?.distance;

  if (typeof meters !== "number") {
    throw new Error("ORS returned no distance");
  }

  return meters / 1609.344; // meters → miles
}

/* =========================
   FALLBACK DISTANCE (HAVERSINE)
========================= */
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/* =========================
   CALCULATE MILES (ROBUST)
========================= */
async function calculateMiles(pickup, dropoff) {
  const from = await geocodeUK(pickup);
  const to = await geocodeUK(dropoff);

  try {
    const miles = await routeMilesORS(from, to);
    if (Number.isFinite(miles) && miles > 0) {
      return miles;
    }
  } catch (err) {
    console.warn("ORS failed, using fallback:", err.message);
  }

  // Fallback: straight-line + buffer
  return haversineMiles(from.lat, from.lon, to.lat, to.lon) * 1.25;
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
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

    const p = pickup.toLowerCase();
    const d = dropoff.toLowerCase();

    // FIXED AIRPORT PRICING (NO ROUTING)
    for (const rule of FIXED_AIRPORT_FARES) {
      if (p.includes(rule.match) || d.includes(rule.match)) {
        const total = Number((rule.price * (1 + VAT_RATE)).toFixed(2));
        return res.json({
          fixed: true,
          miles: null,
          price_gbp_inc_vat: total,
          vat_rate: VAT_RATE,
          currency: "GBP",
          pricing_model: "fixed_airport",
          note: "All prices include VAT"
        });
      }
    }

    // DISTANCE PRICING
    const miles = await calculateMiles(pickup, dropoff);
    const base = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
    const total = Number((base * (1 + VAT_RATE)).toFixed(2));

    return res.json({
      fixed: false,
      miles: Number(miles.toFixed(2)),
      price_gbp_inc_vat: total,
      vat_rate: VAT_RATE,
      currency: "GBP",
      pricing_model: "distance",
      note: "All prices include VAT"
    });

  } catch (err) {
    console.error("QUOTE ERROR:", err.message);
    res.status(422).json({ error: "Unable to calculate distance" });
  }
});

/* =========================
   BOOKING ROUTE
========================= */
app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      dropoff,
      name,
      phone,
      email,
      price_gbp_inc_vat
    } = req.body || {};

    if (!pickup || !dropoff || !name || !phone || typeof price_gbp_inc_vat !== "number") {
      return res.status(400).json({ success: false });
    }

    const booking = {
      id: crypto.randomUUID(),
      pickup,
      dropoff,
      name,
      phone,
      email: email || null,
      price_gbp_inc_vat,
      created_at: new Date().toISOString()
    };

    if (email && process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM,
        subject: "TTTaxis Booking Confirmation",
        text:
          "Reference: " + booking.id +
          "\nPickup: " + pickup +
          "\nDropoff: " + dropoff +
          "\nPrice: £" + price_gbp_inc_vat
      });
    }

    res.json({ success: true, booking });

  } catch (err) {
    console.error("BOOK ERROR:", err.message);
    res.status(500).json({ success: false });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log("TTTaxis backend running on port " + PORT);
});
