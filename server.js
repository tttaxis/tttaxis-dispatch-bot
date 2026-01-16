import express from "express";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import { Pool } from "pg";
import { Client, Environment } from "square";

/* =========================================================
   APP SETUP
========================================================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================================================
   🔥 GLOBAL CORS + PREFLIGHT FIX (WORDPRESS SAFE)
========================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

/* =========================================================
   BODY PARSER
========================================================= */
app.use(express.json({ limit: "256kb" }));

/* =========================================================
   CONSTANTS
========================================================= */
const GOOGLE_REVIEW_URL =
  "https://www.google.com/maps/place/TTTaxis/@54.0604009,-2.8197903";

/* =========================================================
   SENDGRID
========================================================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.warn("SENDGRID_API_KEY not set");
}

/* =========================================================
   SQUARE CLIENT
========================================================= */
const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.SQUARE_ENV === "production"
      ? Environment.Production
      : Environment.Sandbox
});

/* =========================================================
   DATABASE (POSTGRES)
========================================================= */
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function dbInit() {
  if (!pool) {
    console.warn("DATABASE_URL not set – DB disabled");
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
      payment_status TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("DB ready");
}

/* =========================================================
   TAXICALLER (OPTIONAL / SAFE)
========================================================= */
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

/* =========================================================
   EMAILS
========================================================= */
async function sendBookingEmails(data) {
  if (!process.env.SENDGRID_FROM || !process.env.OPERATOR_EMAIL) return;

  const area =
    data.service_area === "lancaster" ? "Lancaster" : "Kendal";

  await sgMail.send([
    {
      to: data.email,
      from: process.env.SENDGRID_FROM,
      subject: `Your ${area} Taxi Booking Confirmation`,
      text: `
Thank you for booking with TTTaxis ${area}.

Reference: ${data.bookingRef}

Pickup: ${data.pickup}
Drop-off: ${data.dropoff}
Time: ${data.pickupTime}

Amount paid: £${data.amountPaid}
Payment type: ${data.paymentType}

Notes: ${data.additionalInfo || "None"}

Leave a review:
${GOOGLE_REVIEW_URL}
`
    },
    {
      to: process.env.OPERATOR_EMAIL,
      from: process.env.SENDGRID_FROM,
      subject: `NEW ${area.toUpperCase()} BOOKING`,
      text: `
REF: ${data.bookingRef}

Customer: ${data.name}
Phone: ${data.phone}
Email: ${data.email}

Pickup: ${data.pickup}
Drop-off: ${data.dropoff}
Time: ${data.pickupTime}

Paid: £${data.amountPaid}
`
    }
  ]);
}

/* =========================================================
   ADMIN AUTH
========================================================= */
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

/* =========================================================
   ROUTES
========================================================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* =======================
   QUOTE
======================= */
app.post("/quote", (req, res) => {
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
});

/* =======================
   CREATE PAYMENT (SQUARE)
======================= */
app.post("/create-payment", async (req, res) => {
  try {
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

    const amountPence =
      payment_type === "deposit"
        ? Math.round(price_gbp_inc_vat * 0.1 * 100)
        : Math.round(price_gbp_inc_vat * 100);

    const { result } =
      await square.checkoutApi.createCheckout(
        process.env.SQUARE_LOCATION_ID,
        {
          idempotencyKey: crypto.randomUUID(),
          order: {
            locationId: process.env.SQUARE_LOCATION_ID,
            lineItems: [
              {
                name: "Taxi Booking",
                quantity: "1",
                basePriceMoney: {
                  amount: amountPence,
                  currency: "GBP"
                }
              }
            ]
          },
          redirectUrl: "https://tttaxis.uk/payment-confirmed",
          note: `${service_area.toUpperCase()} TAXI BOOKING`,
          prePopulateBuyerEmail: email
        }
      );

    if (pool) {
      await pool.query(
        `
        INSERT INTO bookings
        (booking_ref, service_area, customer_name, customer_email,
         customer_phone, pickup, dropoff, pickup_time,
         additional_info, price, payment_type, payment_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
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

    res.json({
      checkout_url: result.checkout.checkoutPageUrl
    });

  } catch (err) {
    console.error("PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment setup failed" });
  }
});

/* =======================
   MANUAL DISPATCH
======================= */
app.post(
  "/admin/dispatch/:booking_ref",
  requireAdmin,
  async (req, res) => {
    if (!pool) return res.status(503).json({ error: "DB unavailable" });
    if (!taxiCallerConfigured())
      return res.status(400).json({ error: "TaxiCaller not configured" });

    const ref = req.params.booking_ref;
    const r = await pool.query(
      `SELECT * FROM bookings WHERE booking_ref=$1 LIMIT 1`,
      [ref]
    );

    const booking = r.rows[0];
    if (!booking)
      return res.status(404).json({ error: "Booking not found" });

    await dispatchToTaxiCaller(booking);
    await pool.query(
      `UPDATE bookings SET status='dispatched' WHERE booking_ref=$1`,
      [ref]
    );

    res.json({ ok: true });
  }
);

/* =======================
   ADMIN DASHBOARD
======================= */
app.get("/admin", requireAdmin, async (req, res) => {
  const rows = pool
    ? (await pool.query(
        `SELECT * FROM bookings ORDER BY created_at DESC`
      )).rows
    : [];

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>TTTaxis Admin</title>
<style>
body{font-family:Arial;padding:20px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:8px}
th{background:#f5f5f5}
</style>
</head>
<body>
<h2>TTTaxis Admin</h2>
<table>
<tr><th>Ref</th><th>Area</th><th>Route</th><th>Status</th></tr>
${rows.map(b => `
<tr>
<td>${b.booking_ref}</td>
<td>${b.service_area}</td>
<td>${b.pickup} → ${b.dropoff}</td>
<td>${b.status}</td>
</tr>
`).join("")}
</table>
</body>
</html>
`);
});

/* =======================
   START SERVER
======================= */
(async () => {
  await dbInit();
  app.listen(PORT, () =>
    console.log("TTTaxis backend running on port " + PORT)
  );
})();





