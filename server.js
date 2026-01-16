import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import { Pool } from "pg";

/* =========================
   CONSTANTS
========================= */
const GOOGLE_REVIEW_URL =
  "https://www.google.com/maps/place/TTTaxis/@54.0604009,-2.8197903";

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   RAW BODY (Square Webhook)
========================= */
app.use("/square/webhook", express.raw({ type: "application/json" }));

/* =========================
   GENERAL MIDDLEWARE
========================= */
app.use(express.json({ limit: "256kb" }));

const corsConfig = cors({
  origin: [
    "https://tttaxis.uk",
    "https://www.tttaxis.uk",
    "https://lancastertttaxis.uk",
    "https://www.lancastertttaxis.uk"
  ],
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
});

app.use(corsConfig);

/* =========================
   CORS PREFLIGHT (FIX)
========================= */
app.options("*", corsConfig);

/* =========================
   SENDGRID
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.warn("SENDGRID_API_KEY not set");
}

/* =========================
   DATABASE (Postgres)
========================= */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : false
    })
  : null;

async function dbInit() {
  if (!pool) {
    console.warn("DATABASE_URL not set – DB features disabled");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      booking_ref TEXT UNIQUE,
      service_area TEXT,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      pickup TEXT,
      dropoff TEXT,
      pickup_time TEXT,
      additional_info TEXT,
      price NUMERIC,
      payment_type TEXT,
      amount_paid NUMERIC,
      payment_status TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("DB: bookings table ready");
}

/* =========================
   HELPERS
========================= */
function nowIso() {
  return new Date().toISOString();
}

/* =========================
   TAXICALLER (SAFE / DORMANT)
========================= */
function taxiCallerConfigured() {
  return Boolean(
    process.env.TAXICALLER_API_KEY &&
    process.env.TAXICALLER_BASE_URL
  );
}

async function dispatchToTaxiCaller(booking) {
  if (!taxiCallerConfigured()) {
    throw new Error("TaxiCaller not configured");
  }

  const payload = {
    customer_name: booking.customer_name,
    customer_phone: booking.customer_phone,
    pickup_address: booking.pickup,
    destination_address: booking.dropoff,
    reference: booking.booking_ref,
    notes: booking.additional_info || ""
  };

  const res = await axios.post(
    `${process.env.TAXICALLER_BASE_URL}/api/v1/booker/order`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.TAXICALLER_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data;
}

/* =========================
   EMAILS (GBP £)
========================= */
async function sendBookingEmails(data) {
  if (!process.env.SENDGRID_FROM || !process.env.OPERATOR_EMAIL) return;

  const areaLabel =
    data.service_area === "lancaster" ? "Lancaster" : "Kendal";

  await sgMail.send([
    {
      to: data.email,
      from: process.env.SENDGRID_FROM,
      subject: `Your ${areaLabel} Taxi Booking Confirmation`,
      text: `
Thank you for booking with TTTaxis ${areaLabel}.

Booking reference: ${data.bookingRef}

Pickup: ${data.pickup}
Drop-off: ${data.dropoff}
Time: ${data.pickupTime}

Amount paid: £${data.amountPaid}
Payment type: ${data.paymentType}

Notes: ${data.additionalInfo || "None"}

If you were happy with your journey, please leave a review:
${GOOGLE_REVIEW_URL}

TTTaxis
01539 556160
`
    },
    {
      to: process.env.OPERATOR_EMAIL,
      from: process.env.SENDGRID_FROM,
      subject: `NEW ${areaLabel.toUpperCase()} BOOKING`,
      text: `
REF: ${data.bookingRef}
AREA: ${areaLabel}

Customer: ${data.name}
Phone: ${data.phone}
Email: ${data.email}

Pickup: ${data.pickup}
Drop-off: ${data.dropoff}
Time: ${data.pickupTime}

Amount paid: £${data.amountPaid}

Notes: ${data.additionalInfo || "None"}
`
    }
  ]);
}

/* =========================
   BASIC ADMIN AUTH
========================= */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic");
    return res.status(401).send("Auth required");
  }

  const [u, p] = Buffer.from(auth.replace("Basic ", ""), "base64")
    .toString()
    .split(":");

  if (u !== process.env.ADMIN_USER || p !== process.env.ADMIN_PASS) {
    return res.status(401).send("Invalid credentials");
  }

  next();
}

/* =========================
   ROUTES
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

/* =========================
   QUOTE (GBP)
========================= */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, service_area } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    let price = 25;
    const d = dropoff.toLowerCase();

    if (d.includes("manchester"))
      price = service_area === "lancaster" ? 85 : 75;
    if (d.includes("liverpool"))
      price = service_area === "lancaster" ? 95 : 85;
    if (d.includes("leeds"))
      price = service_area === "lancaster" ? 80 : 70;

    res.json({ price_gbp_inc_vat: price });
  } catch (err) {
    console.error("QUOTE ERROR:", err);
    res.status(500).json({ error: "Quote failed" });
  }
});

/* =========================
   CREATE PAYMENT (GBP)
========================= */
app.post("/create-payment", async (req, res) => {
  const {
    pickup,
    dropoff,
    pickup_time,
    additional_info,
    email,
    name,
    phone,
    payment_type,
    price_gbp_inc_vat,
    service_area
  } = req.body;

  const bookingRef = "TTT-" + crypto.randomUUID();

  if (pool) {
    await pool.query(
      `
      INSERT INTO bookings
      (booking_ref, service_area, customer_name, customer_email,
       customer_phone, pickup, dropoff, pickup_time,
       additional_info, price, payment_type, amount_paid, payment_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,'paid')
      `,
      [
        bookingRef,
        service_area,
        name,
        email,
        phone,
        pickup,
        dropoff,
        pickup_time,
        additional_info,
        price_gbp_inc_vat,
        payment_type
      ]
    );
  }

  await sendBookingEmails({
    bookingRef,
    pickup,
    dropoff,
    pickupTime: pickup_time,
    additionalInfo: additional_info,
    amountPaid: price_gbp_inc_vat,
    paymentType: payment_type,
    name,
    phone,
    email,
    service_area
  });

  res.json({
    booking_ref: bookingRef,
    checkout_url: "/payment-confirmed/"
  });
});

/* =========================
   START SERVER
========================= */
(async () => {
  try {
    await dbInit();
  } catch (e) {
    console.error("DB init failed", e);
  }

  app.listen(PORT, () => {
    console.log("TTTaxis backend running on port " + PORT);
  });
})();



