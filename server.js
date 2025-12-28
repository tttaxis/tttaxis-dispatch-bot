import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import nodemailer from "nodemailer";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({
  origin: "*",
  methods: ["POST", "GET"]
}));
app.use(bodyParser.json());

/* =========================
   EMAIL (GMAIL SMTP)
========================= */
const mailer = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

/* =========================
   PRICING RULES
========================= */
const MIN_FARE = 4.20;
const LOCAL_PER_MILE = 2.20;

// Fixed airport fares
const FIXED_AIRPORT_FARES = {
  "manchester airport": 120,
  "liverpool airport": 132,
  "leeds bradford airport": 98
};

/* =========================
   DISTANCE ESTIMATE
   (simple placeholder – replace later if needed)
========================= */
function estimateMiles(pickup, dropoff) {
  return 10; // safe fallback for local journeys
}

/* =========================
   QUOTE
========================= */
app.post("/quote", (req, res) => {
  const { pickup, dropoff } = req.body;

  if (!pickup || !dropoff) {
    return res.status(400).json({ error: "Missing locations" });
  }

  const dropKey = dropoff.toLowerCase();

  // Fixed airport pricing
  if (FIXED_AIRPORT_FARES[dropKey]) {
    return res.json({
      fixed: true,
      price_gbp: FIXED_AIRPORT_FARES[dropKey]
    });
  }

  // Local pricing
  const miles = estimateMiles(pickup, dropoff);
  const price = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);

  res.json({
    fixed: false,
    price_gbp: Number(price.toFixed(2))
  });
});

/* =========================
   BOOKING + EMAILS
========================= */
app.post("/book", async (req, res) => {
  const {
    pickup,
    dropoff,
    pickup_time_iso,
    name,
    phone,
    email,
    price_gbp
  } = req.body;

  if (!pickup || !dropoff || !name || !phone || !price_gbp) {
    return res.status(400).json({ success: false });
  }

  const booking = {
    id: crypto.randomUUID(),
    pickup,
    dropoff,
    pickup_time_iso,
    name,
    phone,
    email,
    price_gbp
  };

  try {
    // CUSTOMER CONFIRMATION
    if (email) {
      await mailer.sendMail({
        from: `"TTTaxis" <${process.env.SMTP_USER}>`,
        to: email,
        subject: "Your TTTaxis Booking Confirmation",
        text:
`Thank you for booking with TTTaxis.

Booking reference: ${booking.id}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "AS
;
