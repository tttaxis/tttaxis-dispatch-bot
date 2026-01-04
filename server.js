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
   MIDDLEWARE
========================= */
app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
  })
);

/* =========================
   SENDGRID (OPTIONAL)
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
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
  const url =
    "https://nominatim.openstreetmap.org/search" +
    "?q=" +
    encodeURIComponent(address + ", United Kingdom") +
    "&format=json&limit=1&countrycodes=gb";

  const res = await axios.get(url, {
    headers: { "User-Agent": "TTTaxis Booking System" },
    timeout: 10000
  });

  if (!res.data?.length) {
    throw new Error("Geocode failed");
  }

  return {
    lat: Number(res.data[0].lat),
    lon: Number(res.data[0].lon)
  };
}

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

  if (!meters) throw new Error("ORS failed");

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
    return await routeMilesORS(from, to);
  } catch {
    return haversineMiles(from.lat, from.lon, to.lat, to.lon) * 1.25;
  }
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
   PRICE LOCKING
========================= */
function signQuote(payload) {
  if (!process.env.QUOTE_SECRET) return null;
  return crypto
    .createHmac("sha256", process.env.QUOTE_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");
}

/* =========================
   DEFERRED DATABASE (CRITICAL FIX)
========================= */
let pool = null;

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL not set – availability disabled");
    return;
  }

  const { Pool } = await import("pg");

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost")
      ? false
      : { rejectUnauthorized: false }
  });

  await pool.query("select 1");
  console.log("Postgres connected");
}

async function findAvailableDriver(startIso, endIso) {
  if (!pool) throw new Error("Database not initialised");

  const { rows } = await pool.query(
    `
    SELECT d.id
    FROM drivers d
    WHERE d.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.driver_id = d.id
        AND $1 < e.end_ts
        AND $2 > e.start_ts
    )
    ORDER BY d.id
    LIMIT 1
    `,
    [startIso, endIso]
  );

  return rows[0]?.id || null;
}

/* =========================
   ROUTES
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff } = req.body;
    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const result = await calculatePrice(pickup, dropoff);

    const payload = {
      pickup,
      dropoff,
      fixed: result.fixed,
      miles: result.miles,
      price_gbp_inc_vat: result.price
    };

    const quote_signature = signQuote(payload);

    res.json({
      ...payload,
      vat_rate: VAT_RATE,
      currency: "GBP",
      quote_signature
    });

  } catch (err) {
    console.error(err.message);
    res.status(422).json({ error: "Unable to calculate quote" });
  }
});

app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      dropoff,
      pickup_time_iso,
      duration_minutes = 60,
      name,
      phone,
      email,
      price_gbp_inc_vat,
      quote_signature
    } = req.body;

    if (!pickup || !dropoff || !pickup_time_iso || !name || !phone) {
      return res.status(400).json({ success: false });
    }

    const recalculated = await calculatePrice(pickup, dropoff);

    if (
      quote_signature &&
      signQuote({
        pickup,
        dropoff,
        fixed: recalculated.fixed,
        miles: recalculated.miles,
        price_gbp_inc_vat: recalculated.price
      }) !== quote_signature
    ) {
      return res.status(403).json({ success: false, error: "Price tampering" });
    }

    let driverId = null;

    if (pool) {
      const start = new Date(pickup_time_iso);
      const end = new Date(start.getTime() + duration_minutes * 60000);
      driverId = await findAvailableDriver(start.toISOString(), end.toISOString());
    }

    const bookingId = crypto.randomUUID();

    if (email && process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM,
        subject: "TTTaxis Booking Confirmation",
        text:
          "Reference: " + bookingId +
          "\nPickup: " + pickup +
          "\nDropoff: " + dropoff +
          "\nPrice: £" + recalculated.price
      });
    }

    res.json({
      success: true,
      booking_id: bookingId,
      driver_id: driverId,
      price_gbp_inc_vat: recalculated.price
    });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, async () => {
  await initDatabase();
  console.log("TTTaxis backend running on port " + PORT);
});

