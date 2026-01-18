import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import pg from "pg";

const { Pool } = pg;

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   RAW BODY (Square Webhook)
   MUST be before express.json
========================= */
app.use("/square/webhook", express.raw({ type: "application/json" }));

/* =========================
   GENERAL MIDDLEWARE
========================= */
app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin: [
      "https://tttaxis.uk",
      "https://www.tttaxis.uk",
      "https://terryt28.sg-host.com"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

/* =========================
   SENDGRID
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =========================
   POSTGRES SETUP
========================= */
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

/* =========================
   AREA CONFIGURATION
========================= */
const AREAS = {
  kendal: {
    label: "Kendal",
    minFare: 4.2,
    perMile: 2.2,
    squareLocation: process.env.SQUARE_LOCATION_ID,
    redirectUrl: "https://tttaxis.uk/booking-confirmed",
    operatorEmail: process.env.OPERATOR_EMAIL,
    airportFares: [
      { match: "manchester", price: 120 },
      { match: "liverpool", price: 132 },
      { match: "leeds", price: 98 }
    ]
  },
  lancaster: {
    label: "Lancaster",
    minFare: 4.5,
    perMile: 2.3,
    squareLocation: process.env.SQUARE_LOCATION_ID,
    redirectUrl: "https://tttaxis.uk/lancaster/booking-confirmed",
    operatorEmail: process.env.OPERATOR_EMAIL,
    airportFares: [
      { match: "manchester", price: 95 },
      { match: "liverpool", price: 110 },
      { match: "leeds", price: 105 }
    ]
  }
};

const VAT_RATE = 0.2;

/* =========================
   GEO + ROUTING
========================= */
async function geocodeUK(address) {
  const res = await axios.get(
    "https://nominatim.openstreetmap.org/search",
    {
      params: {
        q: address + ", United Kingdom",
        format: "json",
        limit: 1,
        countrycodes: "gb"
      },
      headers: { "User-Agent": "TTTaxis Booking System" }
    }
  );

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
    return 10;
  }
}

/* =========================
   PRICE CALCULATION
========================= */
async function calculatePrice(areaKey, pickup, dropoff) {
  const area = AREAS[areaKey] || AREAS.kendal;
  const p = pickup.toLowerCase();
  const d = dropoff.toLowerCase();

  for (const rule of area.airportFares) {
    if (p.includes(rule.match) || d.includes(rule.match)) {
      return {
        fixed: true,
        miles: null,
        price: Number((rule.price * (1 + VAT_RATE)).toFixed(2))
      };
    }
  }

  const miles = await calculateMiles(pickup, dropoff);
  const base = Math.max(area.minFare, miles * area.perMile);

  return {
    fixed: false,
    miles: Number(miles.toFixed(2)),
    price: Number((base * (1 + VAT_RATE)).toFixed(2))
  };
}

/* =========================
   SQUARE SETUP
========================= */
const SQUARE_API_BASE =
  process.env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

async function squareRequest(path, body) {
  const res = await fetch(SQUARE_API_BASE + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("Square API error:", data);
    throw new Error("Square API error");
  }
  return data;
}

/* =========================
   SQUARE WEBHOOK VERIFY
========================= */
function verifySquareSignature(rawBody, signature) {
  const hmac = crypto
    .createHmac("sha256", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY)
    .update(rawBody)
    .digest("base64");

  return hmac === signature;
}

/* =========================
   ROUTES
========================= */
app.get("/health", (_, res) => res.json({ ok: true }));

/* ---------- QUOTE ---------- */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, area = "kendal" } = req.body;
    const result = await calculatePrice(area, pickup, dropoff);

    res.json({
      area,
      fixed: result.fixed,
      miles: result.miles,
      price_gbp_inc_vat: result.price
    });
  } catch {
    res.status(422).json({ error: "Unable to calculate quote" });
  }
});

/* ---------- CREATE PAYMENT ---------- */
app.post("/create-payment", async (req, res) => {
  try {
    const {
      booking_id,
      pickup,
      dropoff,
      email,
      price_gbp_inc_vat,
      payment_type,
      area = "kendal"
    } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    if (price_gbp_inc_vat <= 15) {
      return res.json({ payment_mode: "pay_driver" });
    }

    const cfg = AREAS[area] || AREAS.kendal;

    const amount =
      payment_type === "deposit"
        ? Number((price_gbp_inc_vat * 0.1).toFixed(2))
        : price_gbp_inc_vat;

    const checkout = await squareRequest(
      "/v2/online-checkout/payment-links",
      {
        idempotency_key: crypto.randomUUID(),
        quick_pay: {
          name: `TTTaxis ${cfg.label} Booking`,
          price_money: {
            amount: Math.round(amount * 100),
            currency: "GBP"
          },
          location_id: cfg.squareLocation
        },
        checkout_options: {
          redirect_url: cfg.redirectUrl
        },
        pre_populated_data: {
          buyer_email: email
        },
        note: booking_id || "TTTAXIS"
      }
    );

    res.json({
      checkout_url: checkout.payment_link.url
    });
  } catch (err) {
    console.error("Create payment error:", err.message);
    res.status(500).json({ error: "Unable to create payment" });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log("TTTaxis backend running on port " + PORT);
});
