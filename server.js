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
if (!process.env.ORS_API_KEY) console.error("ORS_API_KEY missing");
if (!process.env.SENDGRID_API_KEY) console.error("SENDGRID_API_KEY missing");
if (!process.env.SENDGRID_FROM) console.error("SENDGRID_FROM missing");
if (!process.env.QUOTE_SECRET) console.error("QUOTE_SECRET missing");

/* =========================
   SENDGRID
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());
app.use(
  cors({
    origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
    methods: ["POST"],
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
   GEO (UK ONLY)
========================= */
async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    "?q=" +
    encodeURIComponent(address + ", United Kingdom") +
    "&format=json&limit=1&countrycodes=gb";

  const res = await axios.get(url, {
    headers: { "User-Agent": "TTTaxis Booking System" }
  });

  if (!res.data || !res.data.length) {
    throw new Error("Geocode failed");
  }

  return {
    lat: Number(res.data[0].lat),
    lon: Number(res.data[0].lon)
  };
}

/* =========================
   ROUTING + FALLBACK
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
      }
    }
  );

  const meters =
    res.data.features[0].properties.summary.distance;

  return meters / 1609.344;
}

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

async function calculateMiles(pickup, dropoff) {
  const from = await geocodeUK(pickup);
  const to = await geocodeUK(dropoff);

  try {
    const miles = await routeMilesORS(from, to);
    if (Number.isFinite(miles)) return miles;
  } catch {}

  return haversineMiles(from.lat, from.lon, to.lat, to.lon) * 1.25;
}

/* =========================
   PRICE CALCULATION
========================= */
async function calculatePrice(pickup, dropoff) {
  const p = pickup.toLowerCase();
  const d = dropoff.toLowerCase();

  for (const rule of FIXED_AIRPORT_FARES) {
    if (p.includes(rule.match) || d.includes(rule.match)) {
      return {
        fixed: true,
        miles: null,
        price: Number((rule.price * (1 + VAT_RATE)).toFixed(2))
      };
    }
  }

  const miles = await calculateMiles(pickup, dropoff);
  const base = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
  return {
    fixed: false,
    miles: Number(miles.toFixed(2)),
    price: Number((base * (1 + VAT_RATE)).toFixed(2))
  };
}

/* =========================
   SIGNED QUOTE TOKEN
========================= */
function signQuote(data) {
  return crypto
    .createHmac("sha256", process.env.QUOTE_SECRET)
    .update(JSON.stringify(data))
    .digest("hex");
}

/* =========================
   QUOTE ROUTE (LOCKED)
========================= */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff } = req.body;
    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const result = await calculatePrice(pickup, dropoff);

    const quotePayload = {
      pickup,
      dropoff,
      price_gbp_inc_vat: result.price,
      fixed: result.fixed,
      miles: result.miles
    };

    const quote_signature = signQuote(quotePayload);

    res.json({
      ...quotePayload,
      vat_rate: VAT_RATE,
      currency: "GBP",
      quote_signature,
      note: "Price locked for booking"
    });

  } catch (err) {
    console.error(err.message);
    res.status(422).json({ error: "Unable to calculate quote" });
  }
});

/* =========================
   BOOK ROUTE (VALIDATED)
========================= */
app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      dropoff,
      name,
      phone,
      email,
      price_gbp_inc_vat,
      quote_signature
    } = req.body;

    if (!pickup || !dropoff || !name || !phone || !quote_signature) {
      return res.status(400).json({ success: false });
    }

    // Recalculate price
    const result = await calculatePrice(pickup, dropoff);

    const verifyPayload = {
      pickup,
      dropoff,
      price_gbp_inc_vat: result.price,
      fixed: result.fixed,
      miles: result.miles
    };

    const expectedSignature = signQuote(verifyPayload);

    if (
      expectedSignature !== quote_signature ||
      Number(price_gbp_inc_vat) !== result.price
    ) {
      return res.status(403).json({
        success: false,
        error: "Price validation failed"
      });
    }

    const booking = {
      id: crypto.randomUUID(),
      pickup,
      dropoff,
      name,
      phone,
      email: email || null,
      price_gbp_inc_vat: result.price,
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
          "\nPrice: £" + booking.price_gbp_inc_vat
      });
    }

    res.json({ success: true, booking });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false });
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log("TTTaxis backend running on port " + PORT);
});
