import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import Stripe from "stripe";

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 8080;

/* =========================
   ENV CHECKS
========================= */
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY missing");
}
if (!process.env.SENDGRID_API_KEY) {
  console.error("❌ SENDGRID_API_KEY missing");
}

/* =========================
   CLIENTS
========================= */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
const VAT_RATE = 0.20;
const MIN_FARE = 4.20;
const LOCAL_PER_MILE = 2.20;

// Fixed airport fares (base price, VAT added later)
const FIXED_AIRPORT_FARES = {
  "manchester airport": 120,
  "liverpool airport": 132,
  "leeds bradford airport": 98
};

import fetch from "node-fetch";

/* =========================
   UK GEO + DISTANCE
========================= */

async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(address + ", UK")}` +
    "&format=json&limit=1&countrycodes=gb";

  const res = await fetch(url, {
    headers: { "User-Agent": "TTTaxis/1.0 (booking@tttaxis.uk)" }
  });

  const data = await res.json();

  if (!data || !data.length) {
    throw new Error("Location not found");
  }

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon)
  };
}

function haversineMiles(a, b) {
  const R = 3958.8; // Earth radius in miles
  const toRad = d => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

async function calculateMiles(pickup, dropoff) {
  const [from, to] = await Promise.all([
    geocodeUK(pickup),
    geocodeUK(dropoff)
  ]);

  return haversineMiles(from, to);
}


/* =========================
   QUOTE
========================= */
app.post("/quote", (req, res) => {
  try {
    const { pickup, dropoff } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const dropKey = dropoff.toLowerCase().trim();
    let basePrice;
    let fixed = false;

    if (FIXED_AIRPORT_FARES[dropKey]) {
      basePrice = FIXED_AIRPORT_FARES[dropKey];
      fixed = true;
    } else {
      const miles = estimateMiles();
      basePrice = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
    }

    const priceWithVat = Number((basePrice * (1 + VAT_RATE)).toFixed(2));

    res.json({
      fixed,
      price_gbp_inc_vat: priceWithVat
    });

  } catch (err) {
    console.error("QUOTE ERROR:", err);
    res.status(500).json({ error: "Quote failed" });
  }
});

/* =========================
   STRIPE CHECKOUT
========================= */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { price_gbp, payment_option } = req.body;

    if (typeof price_gbp !== "number" || price_gbp <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    const amountPence =
      payment_option === "deposit"
        ? 2000 // £20 deposit
        : Math.round(price_gbp * 100);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name:
                payment_option === "deposit"
                  ? "TTTaxis booking deposit"
                  : "TTTaxis booking"
            },
            unit_amount: amountPence
          },
          quantity: 1
        }
      ],
      success_url: process.env.STRIPE_SUCCESS_URL,
      cancel_url: process.env.STRIPE_CANCEL_URL
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("STRIPE ERROR:", err);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

/* =========================
   BOOKING CONFIRMATION
   (Used AFTER payment success)
========================= */
app.post("/book", async (req, res) => {
  try {
    const {
      pickup,
      dropoff,
      pickup_time_iso,
      name,
      phone,
      email,
      price_gbp_inc_vat
    } = req.body;

    if (!pickup || !dropoff || !name || !phone) {
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
      price_gbp_inc_vat
    };

    // Customer email
    if (email) {
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM,
        subject: "TTTaxis booking confirmation",
        text:
`Thank you for booking with TTTaxis.

Reference: ${booking.id}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp_inc_vat} (inc VAT)

We will confirm your driver shortly.

TTTaxis
01539 556160`
      });
    }

    // Operator email
    await sgMail.send({
      to: process.env.SENDGRID_FROM,
      from: process.env.SENDGRID_FROM,
      subject: "New TTTaxis booking",
      text:
`NEW BOOKING

Ref: ${booking.id}
Name: ${name}
Phone: ${phone}
Email: ${email || "N/A"}

Pickup: ${pickup}
Dropoff: ${dropoff}
Time: ${pickup_time_iso || "ASAP"}
Price: £${price_gbp_inc_vat}`
    });

    res.json({ success: true, booking });

  } catch (err) {
    console.error("BOOKING ERROR:", err);
    res.status(500).json({ success: false });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`✅ TTTaxis backend listening on port ${PORT}`);
});

