import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";

const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   SENDGRID SETUP
========================= */
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/* =========================
   MIDDLEWARE
========================= */
app.use(cors({
  origin: [
    "https://tttaxis.uk",
    "https://www.tttaxis.uk"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(bodyParser.json());

/* =========================
   PRICING RULES
========================= */
const MIN_FARE = 4.20;
const LOCAL_PER_MILE = 2.20;

const FIXED_AIRPORT_FARES = {
  "manchester airport": 120,
  "liverpool airport": 132,
  "leeds bradford airport": 98
};

/* =========================
   DISTANCE FALLBACK
========================= */
function estimateMiles() {
  return 10;
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

  if (FIXED_AIRPORT_FARES[dropKey]) {
    return res.json({
      fixed: true,
      price_gbp: FIXED_AIRPORT_FARES[dropKey]
    });
  }

  const miles = estimateMiles();
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

  if (!pickup || !dropoff || !name || !phone || typeof price_gbp !== "number") {
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
    /* CUSTOMER EMAIL */
    if (email) {
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM,
        subject: "Your TTTaxis Booking Confirmation",
        text:
`Thank you for booking with TTTaxis.

Booking reference: ${booking.id}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp}

All prices include VAT.

We will confirm your driver shortly.

TTTaxis
01539 556160`
      });
    }

    /* OPERATOR EMAIL */
    await sgMail.send({
      to: process.env.SENDGRID_FROM,
      from: process.env.SENDGRID_FROM,
      subject: "New Taxi Booking Received",
      text:
`NEW BOOKING RECEIVED

Reference: ${booking.id}

Name: ${name}
Phone: ${phone}
Email: ${email || "Not provided"}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp}`
    });

  } catch (err) {
    console.error("SENDGRID ERROR:", err);
  }

  res.json({
    success: true,
    booking
  });
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`TTTaxis backend listening on port ${PORT}`);
});
