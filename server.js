import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import { Pool } from "pg";

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
app.use(
  cors({
    origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

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
      square_note TEXT,
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
   PRICING (placeholder)
========================= */
const VAT_RATE = 0.2;
const MIN_FARE = 4.2;
const PER_MILE = 2.2;

async function calculatePrice() {
  const miles = 10;
  const base = Math.max(MIN_FARE, miles * PER_MILE);
  return Number((base * (1 + VAT_RATE)).toFixed(2));
}

/* =========================
   EMAILS
========================= */
async function sendBookingEmails(data) {
  const {
    email,
    bookingRef,
    pickup,
    dropoff,
    pickupTime,
    additionalInfo,
    amountPaid,
    paymentType,
    name,
    phone
  } = data;

  await sgMail.send([
    {
      to: email,
      from: process.env.SENDGRID_FROM,
      subject: "Your TTTaxis Booking Confirmation",
      text: `
Booking reference: ${bookingRef}

Pickup: ${pickup}
Drop-off: ${dropoff}
Pickup time: ${pickupTime}

Payment: £${amountPaid} (${paymentType})

Notes: ${additionalInfo || "None"}

TTTaxis
01539 556160
`
    },
    {
      to: process.env.OPERATOR_EMAIL,
      from: process.env.SENDGRID_FROM,
      subject: "NEW TTTAXIS BOOKING",
      text: `
REF: ${bookingRef}

Customer: ${name}
Phone: ${phone}
Email: ${email}

Pickup: ${pickup}
Drop-off: ${dropoff}
Time: ${pickupTime}

Paid: £${amountPaid} (${paymentType})

Notes: ${additionalInfo || "None"}
`
    }
  ]);
}

/* =========================
   TAXICALLER (SAFE + GUARDED)
========================= */
let taxiCallerToken = null;
let taxiCallerTokenExpires = 0;

function taxiCallerConfigured() {
  return (
    process.env.TAXICALLER_API_URL &&
    process.env.TAXICALLER_BOOKER_KEY &&
    process.env.TAXICALLER_BOOKER_SECRET
  );
}

async function getTaxiCallerToken() {
  const now = Date.now();
  if (taxiCallerToken && now < taxiCallerTokenExpires) {
    return taxiCallerToken;
  }

  const res = await axios.post(
    `${process.env.TAXICALLER_API_URL}/api/v1/booker/booker-token`,
    {
      key: process.env.TAXICALLER_BOOKER_KEY,
      secret: process.env.TAXICALLER_BOOKER_SECRET
    }
  );

  taxiCallerToken = res.data.token;
  taxiCallerTokenExpires = now + (res.data.expires_in - 60) * 1000;

  return taxiCallerToken;
}

async function dispatchToTaxiCaller(booking) {
  const token = await getTaxiCallerToken();

  const payload = {
    external_id: booking.booking_ref,
    pickup_address: booking.pickup,
    dropoff_address: booking.dropoff,
    passenger_name: booking.customer_name,
    passenger_phone: booking.customer_phone,
    pickup_time: booking.pickup_time || null,
    notes: booking.additional_info || "",
    metadata: {
      source: "TTTaxis",
      paid: true,
      payment_type: booking.payment_type
    }
  };

  const res = await axios.post(
    `${process.env.TAXICALLER_API_URL}/api/v1/booker/order`,
    payload,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  return res.data;
}

/* =========================
   ROUTES
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

/* ---------- QUOTE ---------- */
app.post("/quote", async (req, res) => {
  try {
    const price = await calculatePrice();
    res.json({ price_gbp_inc_vat: price });
  } catch {
    res.status(422).json({ error: "Unable to quote" });
  }
});

/* ---------- CREATE PAYMENT ---------- */
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
    price
  } = req.body;

  const bookingRef = "TTT-" + crypto.randomUUID();

  const squareNote = `
BookingRef:${bookingRef}
Pickup:${pickup}
Dropoff:${dropoff}
Time:${pickup_time}
Notes:${additional_info}
`;

  if (pool) {
    await pool.query(
      `
      INSERT INTO bookings
      (booking_ref, customer_name, customer_email, customer_phone,
       pickup, dropoff, pickup_time, additional_info,
       price, payment_type, payment_status, square_note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
      `,
      [
        bookingRef,
        name,
        email,
        phone,
        pickup,
        dropoff,
        pickup_time,
        additional_info,
        price,
        payment_type,
        squareNote
      ]
    );
  }

  res.json({
    checkout_url: "https://squareup.com",
    booking_ref: bookingRef
  });
});

/* ---------- SQUARE WEBHOOK ---------- */
app.post("/square/webhook", async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString("utf8"));
    if (!event.type?.startsWith("payment.")) return res.sendStatus(200);

    const payment = event.data.object.payment;
    if (payment.status !== "COMPLETED") return res.sendStatus(200);

    const note = payment.note || "";
    const refLine = note.split("\n").find(l => l.startsWith("BookingRef:"));
    const bookingRef = refLine?.split(":")[1];

    if (!bookingRef) return res.sendStatus(200);

    const result = await pool.query(
      `SELECT * FROM bookings WHERE booking_ref=$1 LIMIT 1`,
      [bookingRef]
    );

    const booking = result.rows[0];
    if (!booking) return res.sendStatus(200);

    await pool.query(
      `UPDATE bookings SET payment_status='paid', amount_paid=$1 WHERE booking_ref=$2`,
      [payment.amount_money.amount / 100, bookingRef]
    );

    await sendBookingEmails({
      bookingRef: booking.booking_ref,
      amountPaid: payment.amount_money.amount / 100,
      paymentType: booking.payment_type,
      email: booking.customer_email,
      name: booking.customer_name,
      phone: booking.customer_phone,
      pickup: booking.pickup,
      dropoff: booking.dropoff,
      pickupTime: booking.pickup_time,
      additionalInfo: booking.additional_info
    });

    /* 🚕 OPTIONAL TAXICALLER DISPATCH */
    if (taxiCallerConfigured()) {
      try {
        await dispatchToTaxiCaller(booking);
        await pool.query(
          `UPDATE bookings SET status='dispatched' WHERE booking_ref=$1`,
          [booking.booking_ref]
        );
        console.log("TaxiCaller dispatched:", booking.booking_ref);
      } catch (err) {
        console.error(
          "TaxiCaller dispatch failed (non-fatal):",
          err.response?.data || err.message
        );
      }
    } else {
      console.log("TaxiCaller not configured — dispatch skipped");
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

/* ---------- ADMIN ---------- */
app.get("/admin", requireAdmin, async (req, res) => {
  const rows = pool
    ? (await pool.query(`SELECT * FROM bookings ORDER BY created_at DESC`)).rows
    : [];
  res.send(`<pre>${JSON.stringify(rows, null, 2)}</pre>`);
});

/* ---------- LOOKUP ---------- */
app.post("/api/lookup", async (req, res) => {
  const { booking_ref, email } = req.body;
  if (!pool) return res.status(503).send("DB unavailable");

  const r = await pool.query(
    `SELECT * FROM bookings WHERE booking_ref=$1 AND customer_email=$2`,
    [booking_ref, email]
  );

  if (!r.rows.length) return res.status(404).send("Not found");
  res.json(r.rows[0]);
});

/* =========================
   START SERVER (ONCE)
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
