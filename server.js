import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import { Pool } from "pg";
import { Client, Environment } from "square";

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
app.use(
  cors({
    origin: [
      "https://tttaxis.uk",
      "https://www.tttaxis.uk",
      "https://lancastertttaxis.uk",
      "https://www.lancastertttaxis.uk"
    ],
    methods: ["GET", "POST", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

/* =========================
   SENDGRID
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =========================
   SQUARE CLIENT
========================= */
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.SQUARE_ENV === "production"
      ? Environment.Production
      : Environment.Sandbox
});

/* =========================
   DATABASE
========================= */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function dbInit() {
  if (!pool) return;

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
      amount_paid NUMERIC,
      payment_status TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/* =========================
   EMAILS
========================= */
async function sendBookingEmails(b) {
  if (!process.env.SENDGRID_FROM || !process.env.OPERATOR_EMAIL) return;

  const areaLabel =
    b.service_area === "lancaster" ? "Lancaster" : "Kendal";

  await sgMail.send([
    {
      to: b.customer_email,
      from: process.env.SENDGRID_FROM,
      subject: `Your ${areaLabel} Taxi Booking Confirmation`,
      text: `
Thank you for booking with TTTaxis ${areaLabel}

Reference: ${b.booking_ref}
Pickup: ${b.pickup}
Drop-off: ${b.dropoff}
Time: ${b.pickup_time}

Paid: £${b.amount_paid}

Please consider leaving a review:
${GOOGLE_REVIEW_URL}
`
    },
    {
      to: process.env.OPERATOR_EMAIL,
      from: process.env.SENDGRID_FROM,
      subject: `NEW ${areaLabel.toUpperCase()} BOOKING`,
      text: `
REF: ${b.booking_ref}
AREA: ${areaLabel}

Customer: ${b.customer_name}
Phone: ${b.customer_phone}

${b.pickup} → ${b.dropoff}
Time: ${b.pickup_time}
Paid: £${b.amount_paid}
`
    }
  ]);
}

/* =========================
   HEALTH
========================= */
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/* =========================
   MAIN BOOKING + PAYMENT
========================= */
app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      destination,
      date,
      time,
      passengers,
      email,
      phone,
      sourceId,
      service_area
    } = req.body;

    if (!sourceId || !service_area) {
      return res.status(400).json({ error: "Invalid booking request" });
    }

    const booking_ref = "TTT-" + crypto.randomUUID();
    const amount = 5000; // example £50 – replace with your pricing logic

    const payment = await squareClient.paymentsApi.createPayment({
      sourceId,
      idempotencyKey: crypto.randomUUID(),
      amountMoney: {
        amount,
        currency: "GBP"
      },
      note: `${service_area.toUpperCase()} TAXI BOOKING`,
      metadata: {
        service_area,
        pickup,
        destination
      }
    });

    if (pool) {
      await pool.query(
        `
        INSERT INTO bookings
        (booking_ref, service_area, customer_email, customer_phone,
         pickup, dropoff, pickup_time, amount_paid, payment_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid')
        `,
        [
          booking_ref,
          service_area,
          email,
          phone,
          pickup,
          destination,
          `${date} ${time}`,
          amount / 100
        ]
      );
    }

    await sendBookingEmails({
      booking_ref,
      service_area,
      customer_email: email,
      customer_phone: phone,
      pickup,
      dropoff: destination,
      pickup_time: `${date} ${time}`,
      amount_paid: amount / 100
    });

    res.json({ success: true, booking_ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Payment failed" });
  }
});

/* =========================
   ADMIN AUTH
========================= */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) return res.sendStatus(401);

  const [u, p] = Buffer.from(auth.split(" ")[1], "base64")
    .toString()
    .split(":");

  if (u !== process.env.ADMIN_USER || p !== process.env.ADMIN_PASS)
    return res.sendStatus(403);

  next();
}

/* =========================
   ADMIN DASHBOARD
========================= */
app.get("/admin", requireAdmin, async (_, res) => {
  const rows = pool
    ? (await pool.query(
        `SELECT * FROM bookings ORDER BY created_at DESC`
      )).rows
    : [];

  res.send(`
  <h2>TTTaxis Admin</h2>
  <table border="1" cellpadding="6">
  <tr><th>Ref</th><th>Area</th><th>Route</th><th>Status</th></tr>
  ${rows
    .map(
      r => `<tr>
      <td>${r.booking_ref}</td>
      <td>${r.service_area}</td>
      <td>${r.pickup} → ${r.dropoff}</td>
      <td>${r.status}</td>
      </tr>`
    )
    .join("")}
  </table>
  `);
});

/* =========================
   START SERVER
========================= */
(async () => {
  await dbInit();
  app.listen(PORT, () =>
    console.log("TTTaxis backend running on " + PORT)
  );
})();

