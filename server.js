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
      ssl: process.env.NODE_ENV === "production"
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
   EMAILS
========================= */
async function sendBookingEmails(data) {
  if (!process.env.SENDGRID_FROM || !process.env.OPERATOR_EMAIL) return;

  const {
    bookingRef,
    pickup,
    dropoff,
    pickupTime,
    additionalInfo,
    amountPaid,
    paymentType,
    name,
    phone,
    email
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
Time: ${pickupTime}

Paid: £${amountPaid}
Payment type: ${paymentType}

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

Paid: £${amountPaid}

Notes: ${additionalInfo || "None"}
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

/* ---------- CREATE PAYMENT (SIMPLIFIED) ---------- */
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

  if (pool) {
    await pool.query(
      `
      INSERT INTO bookings
      (booking_ref, customer_name, customer_email, customer_phone, pickup, dropoff, pickup_time, additional_info, price, payment_type, payment_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid')
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
    amountPaid: price,
    paymentType: payment_type,
    name,
    phone,
    email
  });

  res.json({ booking_ref: bookingRef });
});

/* =========================
   MANUAL TAXICALLER DISPATCH
========================= */
app.post(
  "/admin/dispatch/:booking_ref",
  requireAdmin,
  async (req, res) => {
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
  }
);

/* =========================
   ADMIN DASHBOARD
========================= */
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
button{padding:6px 10px;background:#1f7a3f;color:#fff;border:0;border-radius:4px}
button.disabled{background:#aaa}
</style>
</head>
<body>
<h2>TTTaxis Admin</h2>
<table>
<tr><th>Ref</th><th>Route</th><th>Status</th><th>Dispatch</th></tr>
${rows.map(b => `
<tr>
<td>${b.booking_ref}</td>
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
