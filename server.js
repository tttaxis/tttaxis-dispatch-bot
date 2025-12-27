import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   BASIC MIDDLEWARE
========================= */
app.use(express.json());

/* =========================
   CORS – ALLOW TTTAXIS.UK
========================= */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin === "https://tttaxis.uk" ||
    origin === "https://www.tttaxis.uk"
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (req, res) => res.sendStatus(200));

/* =========================
   PRICING RULES
========================= */
const MIN_FARE = 4.2;
const PRICE_PER_MILE = 1.5;
const NIGHT_MULTIPLIER = 1.5;
const NIGHT_START_HOUR = 23;

/* =========================
   FIXED ROUTE FARES
========================= */
const FIXED_ROUTE_FARES = [
  { from: "Lancaster", to: "Manchester Airport", price: 90 },
  { from: "Kendal", to: "Manchester Airport", price: 120 },
  { from: "Kendal", to: "Leeds Bradford Airport", price: 98 },
  { from: "Lancaster", to: "Leeds Bradford Airport", price: 111 },
  { from: "Kendal", to: "Liverpool John Lennon Airport", price: 132 },
  { from: "Lancaster", to: "Liverpool John Lennon Airport", price: 102 }
];

function getFixedRouteFare(pickup, dropoff) {
  const p = pickup.toLowerCase();
  const d = dropoff.toLowerCase();

  for (const r of FIXED_ROUTE_FARES) {
    const from = r.from.toLowerCase();
    const to = r.to.toLowerCase();

    if (
      (p.includes(from) && d.includes(to)) ||
      (p.includes(to) && d.includes(from))
    ) {
      return r.price;
    }
  }
  return null;
}

/* =========================
   GOOGLE DISTANCE MATRIX
========================= */
async function getMiles(pickup, dropoff) {
  const key = process.env.GOOGLE_MAPS_KEY;
  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json" +
    `?origins=${encodeURIComponent(pickup + ", UK")}` +
    `&destinations=${encodeURIComponent(dropoff + ", UK")}` +
    `&units=imperial&region=uk&key=${key}`;

  const res = await fetch(url);
  const data = await res.json();

  if (
    data.status !== "OK" ||
    !data.rows[0].elements[0].distance
  ) {
    throw new Error("Distance lookup failed");
  }

  const meters = data.rows[0].elements[0].distance.value;
  return meters / 1609.34;
}

function calculateFare(miles, pickup_time_iso) {
  let price = Math.max(MIN_FARE, miles * PRICE_PER_MILE);

  if (pickup_time_iso) {
    const hour = new Date(pickup_time_iso).getHours();
    if (hour >= NIGHT_START_HOUR) {
      price *= NIGHT_MULTIPLIER;
    }
  }

  return Math.round(price * 100) / 100;
}

/* =========================
   QUOTE ENDPOINT
========================= */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, pickup_time_iso } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const fixed = getFixedRouteFare(pickup, dropoff);
    if (fixed !== null) {
      let price = fixed;
      if (
        pickup_time_iso &&
        new Date(pickup_time_iso).getHours() >= NIGHT_START_HOUR
      ) {
        price *= NIGHT_MULTIPLIER;
      }

      return res.json({
        fixed: true,
        price_gbp: Math.round(price * 100) / 100
      });
    }

    const miles = await getMiles(pickup, dropoff);
    const price = calculateFare(miles, pickup_time_iso);

    res.json({
      fixed: false,
      miles: Math.round(miles * 10) / 10,
      price_gbp: price
    });
  } catch (err) {
    console.error("QUOTE ERROR:", err);
    res.status(500).json({ error: "Quote failed" });
  }
});

/* =========================
   BOOK ENDPOINT
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
      notes
    } = req.body;

    if (!pickup || !dropoff || !name || !phone) {
      return res.status(400).json({ success: false });
    }

    const booking = {
      id: Math.random().toString(36).substring(2, 8).toUpperCase(),
      pickup,
      dropoff,
      pickup_time_iso,
      name,
      phone,
      email: email || null,
      notes: notes || null
    };

    res.json({ success: true, booking });
  } catch (err) {
    console.error("BOOK ERROR:", err);
    res.status(500).json({ success: false });
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (_, res) => res.send("OK"));

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});

