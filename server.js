import express from "express";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import { Pool } from "pg";
import { Client, Environment } from "square";

/* =====================================================
   APP SETUP
===================================================== */
const app = express();
const PORT = process.env.PORT || 8080;

/* =====================================================
   GLOBAL CORS (WORDPRESS SAFE)
===================================================== */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "256kb" }));

/* =====================================================
   CONSTANTS
===================================================== */
const GOOGLE_REVIEW_URL =
  "https://www.google.com/maps/place/TTTaxis/@54.0604009,-2.8197903";

/* =====================================================
   SENDGRID
===================================================== */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =====================================================
   SQUARE CLIENT
===================================================== */
const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.SQUARE_ENV === "production"
      ? Environment.Production
      : Environment.Sandbox
});

/* =====================================================
   DATABASE
===================================================== */
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
      price NUMERIC,
      payment_type TEXT,
      payment_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/* =====================================================
   QUOTE
===================================================== */
app.post("/quote", (req, res) => {
  const { pickup, dropoff, service_area } = req.body;

  if (!pickup || !dropoff)
    return res.status(400).json({ error: "Missing locations" });

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

/* =====================================================
   CREATE PAYMENT — SQUARE PAYMENT LINK (CORRECT)
===================================================== */
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
      await square.checkoutApi.createPaymentLink({
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
        checkoutOptions: {
          redirectUrl: "https://tttaxis.uk/payment-confirmed/",
          askForShippingAddress: false
        },
        prePopulatedData: {
          buyerEmail: email
        },
        description: `${service_area.toUpperCase()} TAXI BOOKING`
      });

    if (pool) {
      await pool.query(
        `
        INSERT INTO bookings
        (booking_ref, service_area, customer_name, customer_email,
         customer_phone, pickup, dropoff, pickup_time,
         additional_info, price, payment_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
      checkout_url: result.paymentLink.url
    });

  } catch (err) {
    console.error("PAYMENT ERROR:", err);
    res.status(500).json({ error: "Payment setup failed" });
  }
});

/* =====================================================
   HEALTH
===================================================== */
app.get("/health", (_, res) => res.json({ ok: true }));

/* =====================================================
   START SERVER
===================================================== */
(async () => {
  await dbInit();
  app.listen(PORT, () =>
    console.log("TTTaxis backend running on port " + PORT)
  );
})();






