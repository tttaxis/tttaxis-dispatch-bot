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
   SENDGRID SETUP
========================= */
if (!process.env.SENDGRID_API_KEY) {
  console.warn("SENDGRID_API_KEY not set");
} else {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =========================
   DATABASE (Postgres)
========================= */
const pool =
  process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
      })
    : null;

async function dbInit() {
  if (!pool) {
    console.warn("DATABASE_URL not set – DB features disabled");
    return;
  }

  // Minimal, practical schema for dispatch + lookup + audit trail
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      booking_id TEXT UNIQUE,
      booking_ref TEXT UNIQUE,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      pickup TEXT,
      dropoff TEXT,
      pickup_time TEXT,
      additional_info TEXT,
      quote_price_gbp_inc_vat NUMERIC,
      payment_type TEXT,
      amount_due NUMERIC,
      amount_paid NUMERIC,
      payment_status TEXT DEFAULT 'pending',
      square_payment_id TEXT,
      square_note TEXT,
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
  `);

  console.log("DB: bookings table ready");
}

function nowIso() {
  return new Date().toISOString();
}

async function dbUpsertPendingBooking(payload) {
  if (!pool) return;

  const {
    booking_id,
    booking_ref,
    customer_name,
    customer_email,
    customer_phone,
    pickup,
    dropoff,
    pickup_time,
    additional_info,
    quote_price_gbp_inc_vat,
    payment_type,
    amount_due,
    square_note
  } = payload;

  await pool.query(
    `
    INSERT INTO bookings (
      booking_id, booking_ref, customer_name, customer_email, customer_phone,
      pickup, dropoff, pickup_time, additional_info,
      quote_price_gbp_inc_vat, payment_type, amount_due,
      payment_status, square_note, updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,$9,
      $10,$11,$12,
      'pending', $13, NOW()
    )
    ON CONFLICT (booking_id)
    DO UPDATE SET
      booking_ref = EXCLUDED.booking_ref,
      customer_name = EXCLUDED.customer_name,
      customer_email = EXCLUDED.customer_email,
      customer_phone = EXCLUDED.customer_phone,
      pickup = EXCLUDED.pickup,
      dropoff = EXCLUDED.dropoff,
      pickup_time = EXCLUDED.pickup_time,
      additional_info = EXCLUDED.additional_info,
      quote_price_gbp_inc_vat = EXCLUDED.quote_price_gbp_inc_vat,
      payment_type = EXCLUDED.payment_type,
      amount_due = EXCLUDED.amount_due,
      square_note = EXCLUDED.square_note,
      updated_at = NOW()
    `,
    [
      booking_id,
      booking_ref,
      customer_name || null,
      customer_email || null,
      customer_phone || null,
      pickup || null,
      dropoff || null,
      pickup_time || null,
      additional_info || null,
      quote_price_gbp_inc_vat ?? null,
      payment_type || null,
      amount_due ?? null,
      square_note || null
    ]
  );
}

async function dbMarkPaidFromSquare({ booking_ref, square_payment_id, amount_paid, square_note, payment_status }) {
  if (!pool) return;

  await pool.query(
    `
    UPDATE bookings
    SET
      square_payment_id = $1,
      amount_paid = $2,
      payment_status = $3,
      square_note = COALESCE($4, square_note),
      updated_at = NOW()
    WHERE booking_ref = $5
    `,
    [square_payment_id || null, amount_paid ?? null, payment_status || "paid", square_note || null, booking_ref]
  );
}

async function dbGetRecentBookings({ limit = 200 } = {}) {
  if (!pool) return [];
  const res = await pool.query(
    `
    SELECT
      booking_ref, status, payment_status, payment_type,
      amount_due, amount_paid,
      customer_name, customer_email, customer_phone,
      pickup, dropoff, pickup_time, additional_info,
      created_at, updated_at
    FROM bookings
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
}

async function dbUpdateBookingStatus(booking_ref, status) {
  if (!pool) return;
  await pool.query(
    `
    UPDATE bookings
    SET status = $1, updated_at = NOW()
    WHERE booking_ref = $2
    `,
    [status, booking_ref]
  );
}

async function dbLookupBooking(booking_ref, email) {
  if (!pool) return null;
  const res = await pool.query(
    `
    SELECT
      booking_ref, status, payment_status, payment_type,
      amount_due, amount_paid,
      pickup, dropoff, pickup_time, additional_info,
      created_at, updated_at
    FROM bookings
    WHERE booking_ref = $1
      AND LOWER(customer_email) = LOWER($2)
    LIMIT 1
    `,
    [booking_ref, email]
  );
  return res.rows[0] || null;
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
  const res = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: {
      q: address + ", United Kingdom",
      format: "json",
      limit: 1,
      countrycodes: "gb"
    },
    headers: { "User-Agent": "TTTaxis Booking System" }
  });

  if (!res.data?.length) {
    throw new Error("Geocoding failed");
  }

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
    // Fallback approximate if ORS fails
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
  if (!res.ok) {
    console.error("Square API error:", data);
    throw new Error("Square API error");
  }
  return data;
}

/* =========================
   EMAIL HELPER (FULL DETAILS)
========================= */
async function sendBookingEmails(booking) {
  const {
    email,
    bookingRef,
    amountPaid,
    name,
    phone,
    pickup,
    dropoff,
    pickupTime,
    additionalInfo,
    paymentType
  } = booking;

  const notes = additionalInfo || "None provided";

  const customerEmail = {
    to: email,
    from: process.env.SENDGRID_FROM,
    subject: "Your TTTaxis Booking Confirmation",
    text:
`Thank you for booking with TTTaxis.

Booking reference:
${bookingRef}

Pickup:
${pickup}

Drop-off:
${dropoff}

Pickup date & time:
${pickupTime}

Payment type:
${paymentType || "Not provided"}

Payment received:
£${amountPaid}

Additional information:
${notes}

If you paid a deposit, the remaining balance is payable to the driver.

TTTaxis
01539 556160`
  };

  const operatorEmail = {
    to: process.env.OPERATOR_EMAIL,
    from: process.env.SENDGRID_FROM,
    subject: "NEW PAID BOOKING – READY FOR DISPATCH",
    text:
`NEW BOOKING CONFIRMED

Reference:
${bookingRef}

Customer:
${name || "Not provided"}
${phone || "Not provided"}
${email}

Pickup:
${pickup}

Drop-off:
${dropoff}

Pickup date & time:
${pickupTime}

Payment type:
${paymentType || "Not provided"}

Amount paid:
£${amountPaid}

Further information:
${notes}`
  };

  await sgMail.send(customerEmail);
  await sgMail.send(operatorEmail);
}

/* =========================
   SIMPLE ADMIN AUTH (Basic Auth)
========================= */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="TTTaxis Admin"');
    return res.status(401).send("Authentication required");
  }

  const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    return res.status(500).send("Admin credentials not configured");
  }

  if (user !== process.env.ADMIN_USER || pass !== process.env.ADMIN_PASS) {
    res.setHeader("WWW-Authenticate", 'Basic realm="TTTaxis Admin"');
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

/* ---------- TEST SENDGRID ---------- */
app.get("/test-sendgrid", async (req, res) => {
  try {
    await sgMail.send({
      to: process.env.OPERATOR_EMAIL,
      from: process.env.SENDGRID_FROM,
      subject: "SendGrid Test – TTTaxis",
      text: "If you received this, SendGrid is working correctly."
    });

    res.send("SendGrid test email sent successfully");
  } catch (err) {
    console.error(err.response?.body || err);
    res.status(500).send("SendGrid test failed");
  }
});

/* ---------- QUOTE ---------- */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const result = await calculatePrice(pickup, dropoff);

    res.json({
      fixed: result.fixed,
      miles: result.miles,
      price_gbp_inc_vat: result.price,
      payment_rules: {
        pay_driver: result.price <= 15,
        deposit_available: result.price > 15,
        deposit_amount: Number((result.price * 0.1).toFixed(2)),
        full_amount: result.price
      }
    });
  } catch (err) {
    console.error(err.message);
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
      price_gbp_inc_vat,
      payment_type,
      email,
      name,
      phone,
      pickup_time,
      additional_info
    } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // If cheap jobs: pay driver directly
    if (Number(price_gbp_inc_vat) <= 15) {
      // Optional: still store booking as pay-driver in DB for dashboard/lookup
      const bookingRef = `TTT-${booking_id || crypto.randomUUID()}`;
      if (pool) {
        await dbUpsertPendingBooking({
          booking_id: booking_id || bookingRef,
          booking_ref: bookingRef,
          customer_name: name,
          customer_email: email,
          customer_phone: phone,
          pickup,
          dropoff,
          pickup_time,
          additional_info,
          quote_price_gbp_inc_vat: Number(price_gbp_inc_vat),
          payment_type: "pay_driver",
          amount_due: Number(price_gbp_inc_vat),
          square_note: null
        });

        // Mark as pay-driver (not paid online)
        await pool.query(
          `UPDATE bookings SET payment_status='pay_driver', status='new', updated_at=NOW() WHERE booking_ref=$1`,
          [bookingRef]
        );
      }

      return res.json({ payment_mode: "pay_driver", booking_ref: bookingRef });
    }

    const amount =
      payment_type === "deposit"
        ? Number((Number(price_gbp_inc_vat) * 0.1).toFixed(2))
        : Number(price_gbp_inc_vat);

    // Build a clean booking reference suitable for DB + lookup
    const bookingRef = `TTT-${booking_id || crypto.randomUUID()}`;

    // Square note is the bridge to webhook; keep it readable + parsable
    const squareNote =
`BookingRef: ${bookingRef}
Name: ${name || ""}
Phone: ${phone || ""}
Email: ${email || ""}
Pickup: ${pickup || ""}
Dropoff: ${dropoff || ""}
Time: ${pickup_time || ""}
Notes: ${additional_info || ""}
PaymentType: ${payment_type || ""}`;

    // Save pending booking BEFORE redirecting to checkout
    await dbUpsertPendingBooking({
      booking_id: booking_id || bookingRef,
      booking_ref: bookingRef,
      customer_name: name,
      customer_email: email,
      customer_phone: phone,
      pickup,
      dropoff,
      pickup_time,
      additional_info,
      quote_price_gbp_inc_vat: Number(price_gbp_inc_vat),
      payment_type,
      amount_due: amount,
      square_note: squareNote
    });

    const checkout = await squareRequest("/v2/online-checkout/payment-links", {
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
      note: squareNote
    });

    res.json({
      checkout_url: checkout.payment_link.url,
      amount_charged: amount,
      booking_ref: bookingRef
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Unable to create payment" });
  }
});

/* ---------- SQUARE WEBHOOK ---------- */
app.post("/square/webhook", async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString("utf8"));

    if (!event.type?.startsWith("payment.")) {
      return res.status(200).send("Ignored");
    }

    const payment = event.data.object.payment;

    if (payment.status !== "COMPLETED") {
      return res.status(200).send("Not completed");
    }

    const amountPaid = payment.amount_money.amount / 100;
    const rawNote = payment.note || "";

    // Parse note key:value lines
    const lines = rawNote.split("\n").map((l) => l.trim());
    const getValue = (label) =>
      lines.find((l) => l.startsWith(label))?.slice(label.length).trim();

    const bookingRef = getValue("BookingRef:") || "TTTAXIS";

    const bookingData = {
      bookingRef,
      name: getValue("Name:") || "",
      phone: getValue("Phone:") || "",
      email: payment.buyer_email_address || getValue("Email:") || process.env.OPERATOR_EMAIL,
      pickup: getValue("Pickup:") || "",
      dropoff: getValue("Dropoff:") || "",
      pickupTime: getValue("Time:") || "",
      additionalInfo: getValue("Notes:") || "",
      paymentType: getValue("PaymentType:") || "",
      amountPaid
    };

    // Mark paid in DB
    await dbMarkPaidFromSquare({
      booking_ref: bookingRef,
      square_payment_id: payment.id,
      amount_paid: amountPaid,
      square_note: rawNote,
      payment_status: "paid"
    });

    // Send emails (dispatch-ready)
    await sendBookingEmails(bookingData);

    /* FUTURE: TaxiCaller API (later)
    await axios.post("https://api.taxicaller.com/v1/bookings", bookingData, {
      headers: { Authorization: `Bearer ${process.env.TAXICALLER_API_KEY}` }
    });
    */

    res.status(200).send("OK");
  } catch (err) {
    console.error("WEBHOOK ERROR", err);
    res.status(500).send("Webhook error");
  }
});

/* =========================
   ADMIN DISPATCH DASHBOARD
========================= */
app.get("/admin", requireAdmin, (req, res) => {
  // A lightweight dashboard; JS calls /admin/api/bookings
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TTTaxis Admin Dispatch</title>
  <style>
    body{font-family:Arial,sans-serif;margin:20px;}
    h1{margin:0 0 10px;}
    .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0 18px;}
    input,select,button{padding:10px;font-size:14px;}
    table{width:100%;border-collapse:collapse;margin-top:10px;}
    th,td{border:1px solid #ddd;padding:8px;vertical-align:top;}
    th{background:#f5f5f5;text-align:left;}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eee;font-size:12px;}
    .new{background:#eef5ff;}
    .assigned{background:#fff7e6;}
    .completed{background:#e9f7ef;}
    .cancelled{background:#fdecea;}
    .muted{color:#666;font-size:12px;}
    .actions{display:flex;gap:8px;flex-wrap:wrap;}
  </style>
</head>
<body>
  <h1>TTTaxis Dispatch Dashboard</h1>
  <div class="muted">Private admin page. Shows the most recent bookings from the database.</div>

  <div class="bar">
    <button onclick="loadBookings()">Refresh</button>
    <label>Status:
      <select id="statusFilter" onchange="render()">
        <option value="">All</option>
        <option value="new">New</option>
        <option value="assigned">Assigned</option>
        <option value="completed">Completed</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </label>
    <label>Search:
      <input id="search" placeholder="ref / pickup / dropoff / email" oninput="render()" />
    </label>
  </div>

  <table>
    <thead>
      <tr>
        <th>Ref</th>
        <th>Time</th>
        <th>Pickup → Drop-off</th>
        <th>Customer</th>
        <th>Notes</th>
        <th>Payment</th>
        <th>Status</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

<script>
let bookings = [];

function esc(s){ return (s||"").toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

async function loadBookings(){
  const res = await fetch("/admin/api/bookings", { headers: { "Accept":"application/json" } });
  const data = await res.json();
  bookings = Array.isArray(data) ? data : [];
  render();
}

function render(){
  const status = document.getElementById("statusFilter").value;
  const q = (document.getElementById("search").value || "").toLowerCase().trim();

  const filtered = bookings.filter(b => {
    if(status && (b.status||"") !== status) return false;
    if(!q) return true;
    const hay = [
      b.booking_ref, b.pickup, b.dropoff, b.customer_email, b.customer_name, b.customer_phone
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });

  const tbody = document.getElementById("rows");
  tbody.innerHTML = filtered.map(b => {
    const st = (b.status||"new");
    const pay = (b.payment_status||"");
    const pt = (b.payment_type||"");
    const due = b.amount_due != null ? Number(b.amount_due).toFixed(2) : "";
    const paid = b.amount_paid != null ? Number(b.amount_paid).toFixed(2) : "";
    return \`
      <tr class="\${esc(st)}">
        <td><strong>\${esc(b.booking_ref)}</strong><div class="muted">\${esc(new Date(b.created_at).toLocaleString())}</div></td>
        <td>\${esc(b.pickup_time || "")}</td>
        <td><div><strong>\${esc(b.pickup||"")}</strong></div><div class="muted">→ \${esc(b.dropoff||"")}</div></td>
        <td>
          <div>\${esc(b.customer_name||"")}</div>
          <div class="muted">\${esc(b.customer_phone||"")}</div>
          <div class="muted">\${esc(b.customer_email||"")}</div>
        </td>
        <td>\${esc(b.additional_info||"")}</td>
        <td>
          <div><span class="pill">\${esc(pay)}</span> <span class="pill">\${esc(pt)}</span></div>
          <div class="muted">Due: £\${esc(due)} | Paid: £\${esc(paid)}</div>
        </td>
        <td><span class="pill">\${esc(st)}</span></td>
        <td class="actions">
          <button onclick="setStatus('\${esc(b.booking_ref)}','assigned')">Assign</button>
          <button onclick="setStatus('\${esc(b.booking_ref)}','completed')">Complete</button>
          <button onclick="setStatus('\${esc(b.booking_ref)}','cancelled')">Cancel</button>
        </td>
      </tr>
    \`;
  }).join("");
}

async function setStatus(ref, status){
  const res = await fetch("/admin/api/bookings/" + encodeURIComponent(ref) + "/status", {
    method: "PATCH",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ status })
  });
  if(!res.ok){
    alert("Failed to update status");
    return;
  }
  await loadBookings();
}

loadBookings();
</script>
</body>
</html>`);
});

app.get("/admin/api/bookings", requireAdmin, async (req, res) => {
  try {
    const rows = await dbGetRecentBookings({ limit: 300 });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to load bookings" });
  }
});

app.patch("/admin/api/bookings/:ref/status", requireAdmin, async (req, res) => {
  try {
    const ref = req.params.ref;
    const { status } = req.body;

    const allowed = new Set(["new", "assigned", "completed", "cancelled"]);
    if (!allowed.has(status)) return res.status(400).json({ error: "Invalid status" });

    await dbUpdateBookingStatus(ref, status);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to update status" });
  }
});

/* =========================
   BOOKING LOOKUP (CUSTOMER)
========================= */
app.get("/booking-lookup", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TTTaxis Booking Lookup</title>
  <style>
    body{font-family:Arial,sans-serif;margin:0;padding:20px;background:#f7f7f7;}
    .card{max-width:520px;margin:auto;background:#fff;border-radius:10px;padding:18px;box-shadow:0 4px 12px rgba(0,0,0,.08);}
    label{display:block;margin-top:12px;font-weight:bold;}
    input,button{width:100%;padding:10px;margin-top:6px;font-size:16px;}
    button{background:#1f7a3f;color:#fff;border:0;border-radius:6px;cursor:pointer;margin-top:14px;}
    .box{background:#eef5ff;border-radius:8px;padding:12px;margin-top:14px;}
    .muted{color:#666;font-size:13px;}
  </style>
</head>
<body>
  <div class="card">
    <h2>Booking Lookup</h2>
    <div class="muted">Enter your booking reference and the same email you used at checkout.</div>

    <label>Booking reference</label>
    <input id="ref" placeholder="e.g. TTT-..." />

    <label>Email address</label>
    <input id="email" type="email" placeholder="you@example.com" />

    <button onclick="lookup()">Find booking</button>

    <div id="out" class="box" style="display:none;"></div>
  </div>

<script>
function esc(s){ return (s||"").toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

async function lookup(){
  const ref = document.getElementById("ref").value.trim();
  const email = document.getElementById("email").value.trim();
  if(!ref || !email){ alert("Please enter your booking reference and email."); return; }

  const res = await fetch("/api/lookup", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ booking_ref: ref, email })
  });

  const out = document.getElementById("out");
  const data = await res.json();

  if(!res.ok){
    out.style.display = "block";
    out.innerHTML = "<strong>Not found.</strong><div class='muted'>Check the booking reference and email match your confirmation email.</div>";
    return;
  }

  out.style.display = "block";
  out.innerHTML = \`
    <strong>Booking found</strong><br><br>
    <strong>Reference:</strong> \${esc(data.booking_ref)}<br>
    <strong>Pickup:</strong> \${esc(data.pickup)}<br>
    <strong>Drop-off:</strong> \${esc(data.dropoff)}<br>
    <strong>Pickup time:</strong> \${esc(data.pickup_time)}<br>
    <strong>Notes:</strong> \${esc(data.additional_info || "None")}<br><br>
    <strong>Payment:</strong> \${esc(data.payment_status)} (\${esc(data.payment_type || "")})<br>
    <strong>Amount due:</strong> £\${esc((data.amount_due ?? ""))}<br>
    <strong>Amount paid:</strong> £\${esc((data.amount_paid ?? ""))}<br><br>
    <strong>Status:</strong> \${esc(data.status)}<br>
  \`;
}
</script>
</body>
</html>`);
});

app.post("/api/lookup", async (req, res) => {
  try {
    const { booking_ref, email } = req.body;
    if (!booking_ref || !email) return res.status(400).json({ error: "Missing details" });

    const row = await dbLookupBooking(booking_ref, email);
    if (!row) return res.status(404).json({ error: "Not found" });

    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lookup failed" });
  }
});

/* =========================
   START SERVER
========================= */
dbInit()
  .then(() => {
    app.listen(PORT, () => {
      console.log("TTTaxis backend running on port " + PORT);
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    // Start anyway (keeps existing system operational)
    app.listen(PORT, () => {
      console.log("TTTaxis backend running (DB init failed) on port " + PORT);
    });
  });

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log("TTTaxis backend running on port " + PORT);
});
