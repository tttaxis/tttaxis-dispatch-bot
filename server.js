import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({
  origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());
app.options("*", cors());

/* =========================
   QUOTE ROUTE (SAFE BASELINE)
========================= */
app.post("/quote", (req, res) => {
  const { pickup, dropoff } = req.body;

  if (!pickup || !dropoff) {
    return res.status(400).json({ error: "Missing locations" });
  }

  // TEMP: fixed price to prove server stability
  res.json({
    fixed: false,
    price_gbp: 22.00
  });
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});
import fetch from "node-fetch";

const PORT = process.env.PORT || 8080;

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({
  origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());
app.options("*", cors());

/* =========================
   PRICING CONSTANTS
========================= */
const MIN_FARE = 4.20;
const LOCAL_PER_MILE = 2.20;
const VAT_RATE = 0.20;

const FIXED_AIRPORT_FARES = [
  { from: "kendal", to: "manchester", price: 120 },
  { from: "lancaster", to: "manchester", price: 90 },
  { from: "kendal", to: "leeds", price: 98 },
  { from: "lancaster", to: "leeds", price: 111 },
  { from: "kendal", to: "liverpool", price: 132 },
  { from: "lancaster", to: "liverpool", price: 102 }
];

/* =========================
   GEO HELPERS (UK ONLY)
========================= */
async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(address + ", United Kingdom")}` +
    "&format=json&limit=1&countrycodes=gb";

  const res = await fetch(url, {
    headers: { "User-Agent": "TTTaxis/1.0 (booking@tttaxis.uk)" }
  });

  const data = await res.json();

  if (!data.length) throw new Error("Location not found");

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
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

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

    // Fixed airport fares
    for (const rule of FIXED_AIRPORT_FARES) {
      if (pickupLc.includes(rule.from) && dropoffLc.includes(rule.to)) {
        const vatPrice = Number((rule.price * (1 + VAT_RATE)).toFixed(2));
        return res.json({
          fixed: true,
          miles: null,
          price_gbp: vatPrice,
          note: "All prices include VAT"
        });
      }
    }

    // Distance-based pricing
    const miles = await calculateMiles(pickup, dropoff);
    const base = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
    const total = Number((base * (1 + VAT_RATE)).toFixed(2));

    res.json({
      fixed: false,
      miles: Number(miles.toFixed(2)),
      price_gbp: total,
      note: "All prices include VAT"
    });

  } catch (err) {
    console.error("QUOTE ERROR:", err.message);
    res.status(500).json({ error: "Unable to calculate distance" });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});

