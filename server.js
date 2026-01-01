/* =========================
   IMPORTS
========================= */
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   ENV CHECKS
========================= */
if (!process.env.SENDGRID_API_KEY) {
  console.error("❌ SENDGRID_API_KEY missing");
}
if (!process.env.SENDGRID_FROM) {
  console.error("❌ SENDGRID_FROM missing");
}

/* =========================
   SENDGRID
========================= */
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({
  origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(bodyParser.json());

/* =========================
   PRICING RULES
========================= */
const VAT_RATE = 0.2;
const MIN_FARE = 4.20;
const LOCAL_PER_MILE = 2.20;

const FIXED_AIRPORT_FARES = [
  { match: "manchester", price: 120 },
  { match: "liverpool", price: 132 },
  { match: "leeds", price: 98 }
];

/* =========================
   GEO + DISTANCE (UK ONLY)
========================= */
async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(address + ", UK")}` +
    "&format=json&limit=1&countrycodes=gb";

  const res = await fetch(url, {
    headers: { "User-Agent": "TTTaxis/1.0 (booking@tttaxis.uk)" }
  });

  const data = await res.json();

  if (!data || !data.length) {
    throw new Error("Location not found");
  }

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon)
  };
}

function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = d => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

async function calculateMiles(pickup, dropoff) {
  const [from, to] = await Promise.all([
    geocodeUK(pickup),
    geocodeUK(dropoff)
  ]);
  return haversineMiles(from, to);
}

/* =========================
   QUOTE ROUTE
========================= */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const pickupLc = pickup.toLowerCase();
    const dropoffLc = dropoff.toLowerCase();

    /* AIRPORT FIXED PRICES */
    for (const rule of FIXED_AIRPORT_FARES) {
      if (
        pickupLc.includes(rule.match) ||
        dropoffLc.includes(rule.match)
      ) {
        const total = Number(
          (rule.price * (1 + VAT_RATE)).toFixed(2)
        );

        return res.json({
          fixed: true,
          miles: null,
          price_gbp: total,
          note: "All prices include VAT"
        });
      }
    }

    /* DISTANCE PRICING */
    const miles = await calculateMiles(pickup, dropoff);
    const base = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
    const total = Number((base * (1 + VAT_RATE)).toFixed(2));

    return res.json({
      fixed: false,
      miles: Number(miles.toFixed(2)),
      price_gbp: total,
      note: "All prices include VAT"
    });

  } catch (err) {
    console.error("QUOTE ERROR:", err.message);
    return res.status(400).json({
      error: "Unable to calculate distance"
    });
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
      price_gbp
    } = req.body;

    if (!pickup || !dropoff || !name || !phone || typeof price_gbp !== "number") {
      return res.status(400).json({ success: false });
    }

    const booking = {
      id: crypto.randomUUID(),
      pickup,
      dropoff,
      pickup_time_iso,
      name,
      phone,
      email,
      price_gbp
    };

    /* CUSTOMER EMAIL */
    if (email) {
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM,
        subject: "Your TTTaxis Booking Confirmation",
        text:
`Thank you for booking with TTTaxis.

Reference: ${booking.id}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp}

All prices include VAT.

TTTaxis
01539 556160`
      });
    }

    /* OPERATOR EMAIL */
    await sgMail.send({
      to: process.env.SENDGRID_FROM,
      from: process.env.SENDGRID_FROM,
      subject: "New Booking Received",
      text:
`NEW BOOKING

Reference: ${booking.id}
Name: ${name}
Phone: ${phone}
Email: ${email || "N/A"}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp}`
    });

    return res.json({ success: true, booking });

  } catch (err) {
    console.error("BOOKING ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`✅ TTTaxis backend listening on port ${PORT}`);
});

