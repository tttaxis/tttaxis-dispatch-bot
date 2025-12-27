import express from "express";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 8080;

/* =====================================================
   BASIC MIDDLEWARE
===================================================== */
app.use(express.json());

/* =====================================================
   CORS – ALLOW TTTAXIS WEBSITE
===================================================== */
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

app.options("*", (_, res) => res.sendStatus(200));

/* =====================================================
   EMAIL (SMTP)
===================================================== */
const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* =====================================================
   PRICING RULES
===================================================== */
const MIN_FARE = 4.20;
const LOCAL_PRICE_PER_MILE = 2.20;
const NIGHT_MULTIPLIER = 1.5;
const NIGHT_START_HOUR = 23;

/* =====================================================
   FIXED AIRPORT ROUTES (NO NIGHT UPLIFT)
===================================================== */
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

/* =====================================================
   OPENSTREETMAP ROUTING (NO GOOGLE)
===================================================== */
async function getMiles(pickup, dropoff) {
  async function geocode(place) {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(place + ", UK")}`,
      { headers: { "User-Agent": "TTTaxis/1.0" } }
    );
    const data = await res.json();
    if (!data[0]) throw new Error("Location not found");
    return `${data[0].lon},${data[0].lat}`;
  }

  const from = await geocode(pickup);
  const to = await geocode(dropoff);

  const routeRes = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${from};${to}?overview=false`
  );
  const routeData = await routeRes.json();

  if (!routeData.routes?.[0]) throw new Error("Route not found");

  return routeData.routes[0].distance / 1609.34;
}

/* =====================================================
   LOCAL FARE CALCULATION
===================================================== */
function calculateLocalFare(miles, pickup_time_iso) {
  let price = Math.max(MIN_FARE, miles * LOCAL_PRICE_PER_MILE);

  if (pickup_time_iso) {
    const hour = new Date(pickup_time_iso).getHours();
    if (hour >= NIGHT_START_HOUR) {
      price *= NIGHT_MULTIPLIER;
    }
  }

  return Math.round(price * 100) / 100;
}

/* =====================================================
   QUOTE ENDPOINT
===================================================== */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, pickup_time_iso } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const fixedFare = getFixedRouteFare(pickup, dropoff);
    if (fixedFare !== null) {
      return res.json({ fixed: true, price_gbp: fixedFare });
    }

    const miles = await getMiles(pickup, dropoff);
    const price = calculateLocalFare(miles, pickup_time_iso);

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

/* =====================================================
   BOOK + EMAIL CONFIRMATION
===================================================== */
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

    if (!pickup || !dropoff || !name || !phone) {
      return res.status(400).json({ success: false });
    }

    const bookingId = Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase();

    const timeText = pickup_time_i

