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

  /* BOOKINGS TABLE */
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

  /* DRIVER APPLICATIONS TABLE */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS driver_applications (
      id BIGSERIAL PRIMARY KEY,

      -- Personal details
      full_name TEXT NOT NULL,
      address TEXT NOT NULL,
      date_of_birth DATE NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,

      -- Licensing documents
      driving_licence_front_path TEXT NOT NULL,
      driving_licence_back_path TEXT NOT NULL,
      ph_or_hackney_licence_path TEXT NOT NULL,

      -- DBS & DVLA
      dbs_certificate_path TEXT NOT NULL,
      dbs_update_service_code TEXT,
      dvla_check_code TEXT NOT NULL,

      -- Vehicle & insurance
      has_own_vehicle BOOLEAN NOT NULL DEFAULT false,
      vehicle_registration TEXT,
      hire_and_reward_insurance_path TEXT,
      public_liability_insurance_path TEXT,

      -- English language verification
      english_audio_path TEXT NOT NULL,

      -- Admin workflow
      status TEXT NOT NULL DEFAULT 'submitted',
      admin_notes TEXT,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
  `);

  console.log("DB: bookings table ready");
  console.log("DB: driver_applications table ready");
}

/* =========================
   HELPERS
========================= */
function nowIso() {
  return new Date().toISOString();
}

/* =========================
   PRICING
========================= */
const VAT_RATE = 0.2;
const MIN_FARE = 4.2;
const PER_MILE = 2.2;

async function calculatePrice() {
  const miles = 10; // placeholder
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
      (booking_ref, customer_name, customer_email, customer_phone, pickup, dropoff, pickup_time, additional_info, price, payment_type, payment_status, square_note)
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

/* ---------- DRIVER APPLICATION (PHASE A) ---------- */
app.post("/drivers/apply", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "DB unavailable" });

    const {
      full_name,
      address,
      date_of_birth,
      phone,
      email,
      dvla_check_code,
      dbs_update_service_code,
      has_own_vehicle,
      vehicle_registration
    } = req.body;

    await pool.query(
      `
      INSERT INTO driver_applications (
        full_name, address, date_of_birth, phone, email,
        dvla_check_code, dbs_update_service_code,
        has_own_vehicle, vehicle_registration,
        driving_licence_front_path,
        driving_licence_back_path,
        ph_or_hackney_licence_path,
        dbs_certificate_path,
        english_audio_path,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
              'PENDING','PENDING','PENDING','PENDING','PENDING','submitted')
      `,
      [
        full_name,
        address,
        date_of_birth,
        phone,
        email,
        dvla_check_code,
        dbs_update_service_code || null,
        has_own_vehicle === true,
        vehicle_registration || null
      ]
    );

    res.json({ ok: true, message: "Driver application received" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to submit application" });
  }
});

/* ---------- ADMIN: DRIVER APPLICATIONS ---------- */
app.get("/admin/drivers", requireAdmin, async (req, res) => {
  const rows = await pool.query(
    `SELECT id, full_name, email, phone, status, created_at
     FROM driver_applications
     ORDER BY created_at DESC`
  );
  res.json(rows.rows);
});

/* ---------- BOOKING LOOKUP ---------- */
app.get("/booking-lookup", (req, res) => {
  res.send(`
<form method="POST" action="/api/lookup">
<input name="booking_ref" placeholder="Booking ref"/>
<input name="email" placeholder="Email"/>
<button>Lookup</button>
</form>
`);
});

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
