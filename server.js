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
   SQUARE WEBHOOK RAW BODY
   (MUST BE FIRST)
========================= */
app.use(
  "/square/webhook",
  express.raw({ type: "application/json" })
);

/* =========================
   GENERAL MIDDLEWARE
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
   SENDGRID
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

  if (!res.data?.length) throw new Error("Geocode failed");

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
   DEFERRED DATABASE
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
    ssl: { rejectUnauthorized: false }
  });

  await pool.query("select 1");
  console.log("Postgres connected");
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
      Authorization: "Bearer " + process.env.SQUARE_ACCESS_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) throw new Error("Square API error");
  return data;
}

/* =========================
   SQUARE WEBHOOK VERIFY
========================= */
function verifySquareSignature(rawBody, signature) {
  const hmac = crypto
    .createHmac("sha1", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY)
    .update(rawBody)
    .digest("base64");

  return hmac === signature;
}

/* =========================
   ROUTES
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ---------- QUOTE ---------- */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff } = req.body;
    const result = await calculatePrice(pickup, dropoff);

    const payload = {
      pickup,
      dropoff,
      fixed: result.fixed,
      miles: result.miles,
      price_gbp_inc_vat: result.price
    };

    res.json({
      ...payload,
      quote_signature: signQuote(payload),
      payment_rules: {
        pay_driver: result.price <= 15,
        deposit_available: result.price > 15,
        deposit_amount: Number((result.price * 0.1).toFixed(2)),
        full_amount: result.price
      }
    });
  } catch {
    res.status(422).json({ error: "Unable to calculate quote" });
  }
});

/* ---------- CREATE SQUARE PAYMENT ---------- */
app.post("/create-payment", async (req, res) => {
  try {
    const {
      booking_id,
      pickup,
      dropoff,
      price_gbp_inc_vat,
      payment_type,
      email
    } = req.body;

    if (price_gbp_inc_vat <= 15) {
      return res.json({ payment_mode: "pay_driver" });
    }

    const amount =
      payment_type === "deposit"
        ? Number((price_gbp_inc_vat * 0.1).toFixed(2))
        : price_gbp_inc_vat;

    const checkout = await squareRequest(
      "/v2/online-checkout/payment-links",
      {
        idempotency_key: crypto.randomUUID(),
        quick_pay: {
          name:
            payment_type === "deposit"
              ? "TTTaxis Booking Deposit"
              : "TTTaxis Booking Payment",
          price_money: {
            amount: Math.round(amount * 100),
            currency: "GBP"
          },
          location_id: process.env.SQUARE_LOCATION_ID
        },
        checkout_options: {
          redirect_url: "https://tttaxis.uk/booking-confirmed"
        },
        pre_populated_data: {
          buyer_email: email
        },
        note: `Booking ${booking_id} | ${pickup} → ${dropoff}`
      }
    );

    res.json({
      checkout_url: checkout.payment_link.url,
      amount_charged: amount
    });
  } catch {
    res.status(500).json({ error: "Unable to create payment" });
  }
});

/* ---------- SQUARE WEBHOOK ---------- */
app.post("/square/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-square-hmacsha256-signature"];
    const rawBody = req.body.toString("utf8");

    if (!signature || !verifySquareSignature(rawBody, signature)) {
      return res.status(401).send("Invalid signature");
    }

    const event = JSON.parse(rawBody);

    if (event.type !== "payment.updated") {
      return res.status(200).send("Ignored");
    }

    const payment = event.data.object.payment;

    if (payment.status !== "COMPLETED") {
      return res.status(200).send("Not completed");
    }

    const amountPaid = payment.amount_money.amount / 100;

    console.log("Square payment confirmed:", amountPaid);

    if (process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to: process.env.OPERATOR_EMAIL,
        from: process.env.SENDGRID_FROM,
        subject: "Square Payment Confirmed",
        text: `Payment received: £${amountPaid}`
      });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Webhook error");
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, async () => {
  await initDatabase();
  console.log("TTTaxis backend running on port " + PORT);
});
