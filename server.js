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
  "https://www.google.com/maps/place/TTTaxis/@54.0604009,-2.8197903,17z/data=!3m1!4b1!4m6!3m5!1s0x487c9d6897d9dd73:0x472ee023df606acd!8m2!3d54.0604009!4d-2.8197903!16s%2Fg%2F11ympk_1b4?entry=ttu";

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
   🔥 PREFLIGHT FIX (WORDPRESS SAFE)
========================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
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
  return Boolean(process.env.TAXICALLER_API_KEY && process.env.TAXICALLER_BASE_URL);
}

async function dispatchToTaxiCaller(booking) {
  if (!taxiCallerConfigured()) throw new Error("TaxiCaller not configured");

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
   EMAILS
========================= */
async function sendBookingEmails(data) {
  if (!process.env.SENDGRID_FROM || !process.env.OPERATOR_EMAIL) return;

  const area = data.service_area === "lancaster" ? "Lancaster" : "Kendal";

  await sgMail.send([
    {
      to: data.email,
      from: process.env.SENDGRID_FROM,
      subject: `Your TTTaxis ${area} Booking Confirmation`,
      text: `
Thank you for booking with TTTaxis ${area}.

Booking reference: ${data.bookingRef}

Pickup: ${data.pickup}
Drop-off: ${data.dropoff}
Time: ${data.pickupTime}

Paid: £${data.amountPaid}
Payment type: ${data.paymentType}

Notes: ${data.additionalInfo || "None"}

If you were happy with your journey, we’d really appreciate a Google review:
${GOOGLE_REVIEW_URL}

TTTaxis
01539 556160
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
   QUOTE (Kendal + Lancaster)
========================= */
app.post("/quote", (req, res) => {
  const { pickup, dropoff, service_area } = req.body;

  if (!pickup || !dropoff) {
    return res.status(400).json({ error: "Missing locations" });
  }

  let price = 25;
  const d = dropoff.toLowerCase();

  if (d.includes("manchester")) price = service_area === "lancaster" ? 85 : 75;
  if (d.includes("liverpool")) price = service_area === "lancaster" ? 95 : 85;
  if (d.includes("leeds")) price = service_area === "lancaster" ? 80 : 70;

  res.json({ price_gbp_inc_vat: price });
});

/* =========================
   SQUARE WEBHOOK ENDPOINT
   (Stops Square retries / 404s)
========================= */
app.post("/square/webhook", (req, res) => {
  try {
    console.log("Square webhook received, bytes:", req.body?.length || 0);
    // Your original signature verification + logic can live here.
    res.status(200).send("OK");
  } catch (e) {
    console.error("Square webhook error:", e);
    res.status(500).send("Webhook error");
  }
});

/* ---------- CREATE PAYMENT ---------- */
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
      price,
      service_area
    } = req.body;

    const bookingRef = "TTT-" + crypto.randomUUID();

    /* =========================================================
       ✅ IMPORTANT: THIS IS WHERE YOUR ORIGINAL WORKING SQUARE
       CHECKOUT CREATION CODE MUST RUN.

       It MUST set: checkout_url (a full https://... Square URL)

       Example output expected:
       const checkout_url = "https://square.link/u/....";
    ========================================================= */
    let checkout_url = null;

    // >>>>> PASTE YOUR ORIGINAL "CREATE SQUARE CHECKOUT" CODE HERE <<<<<
    // It should end by setting checkout_url = <square url>;

    // SAFETY: if checkout_url is still null, return a clear error
    if (!checkout_url) {
      console.error("create-payment: checkout_url not generated");
      return res.status(500).json({
        error: "Payment setup failed (no checkout URL returned)."
      });
    }

    if (pool) {
      await pool.query(
        `
        INSERT INTO bookings
        (booking_ref, service_area, customer_name, customer_email, customer_phone,
         pickup, dropoff, pickup_time, additional_info,
         price, payment_type, amount_paid, payment_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,'pending')
        `,
        [
          bookingRef,
          service_area || "kendal",
          name,
          email,
          phone,
          pickup,
          dropoff,
          pickup_time,
          additional_info,
          price,
          payment_type
        ]
      );
    }

    // NOTE: If your original flow sent emails only after webhook confirms payment,
    // keep it that way. If you want "booking created" emails here, we can do it,
    // but it may trigger emails for failed payments.
    // await sendBookingEmails(...)

    res.json({
      booking_ref: bookingRef,
      checkout_url
    });
  } catch (e) {
    console.error("create-payment failed:", e);
    res.status(500).json({ error: "create-payment failed", detail: String(e?.message || e) });
  }
});

/* =========================
   MANUAL TAXICALLER DISPATCH
========================= */
app.post("/admin/dispatch/:booking_ref", requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "DB unavailable" });
    if (!taxiCallerConfigured()) {
      return res.status(400).json({ error: "TaxiCaller API not configured" });
    }

    const ref = req.params.booking_ref;

    const r = await pool.query(
      `SELECT * FROM bookings WHERE booking_ref=$1 LIMIT 1`,
      [ref]
    );

    const booking = r.rows[0];
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status === "dispatched") {
      return res.status(400).json({ error: "Already dispatched" });
    }

    await dispatchToTaxiCaller(booking);

    await pool.query(
      `UPDATE bookings SET status='dispatched' WHERE booking_ref=$1`,
      [ref]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("dispatch failed:", e);
    res.status(500).json({ error: "dispatch failed" });
  }
});

/* =========================
   ADMIN DASHBOARD
========================= */
app.get("/admin", requireAdmin, async (req, res) => {
  const rows = pool
    ? (await pool.query(`SELECT * FROM bookings ORDER BY created_at DESC`)).rows
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
button{padding:6px 10px;background:#1f7a3f;color:#fff;border:0;border-radius:4px}
button.disabled{background:#aaa}
</style>
</head>
<body>
<h2>TTTaxis Admin</h2>

<p>
<a href="${GOOGLE_REVIEW_URL}" target="_blank">⭐ View Google Reviews</a>
</p>

<table>
<tr><th>Ref</th><th>Area</th><th>Route</th><th>Status</th><th>Dispatch</th></tr>
${rows.map(b => `
<tr>
<td>${b.booking_ref}</td>
<td>${b.service_area || ""}</td>
<td>${b.pickup} → ${b.dropoff}</td>
<td>${b.status}</td>
<td>${
  b.status === "dispatched"
    ? "<button class='disabled'>Dispatched</button>"
    : `<button onclick="dispatch('${b.booking_ref}')">Dispatch</button>`
}</td>
</tr>
`).join("")}
</table>

<script>
async function dispatch(ref){
  if(!confirm("Dispatch " + ref + "?")) return;
  const res = await fetch("/admin/dispatch/" + ref, {
    method:"POST",
    headers:{
      "Authorization":"Basic " + btoa(prompt("User")+":"+prompt("Pass"))
    }
  });
  const data = await res.json();
  if(!res.ok) alert(data.error || "Failed");
  else location.reload();
}
</script>
</body>
</html>
`);
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);
  res.status(500).json({ error: "Server error" });
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








