import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";

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
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
  })
);

/* =========================
   SENDGRID
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =========================
   AREA CONFIGURATION
========================= */
const AREAS = {
  kendal: {
    label: "Kendal",
    minFare: 4.2,
    perMile: 2.2,
    squareLocation: process.env.SQUARE_LOCATION_ID,
    redirectUrl: "https://tttaxis.uk/booking-confirmed",
    operatorEmail: process.env.OPERATOR_EMAIL,
    airportFares: [
      { match: "manchester", price: 120 },
      { match: "liverpool", price: 132 },
      { match: "leeds", price: 98 }
    ]
  },

  lancaster: {
    label: "Lancaster",
    minFare: 4.5,
    perMile: 2.3,
    squareLocation: process.env.SQUARE_LOCATION_ID, // reuse or replace later
    redirectUrl: "https://tttaxis.uk/lancaster/booking-confirmed",
    operatorEmail: process.env.OPERATOR_EMAIL,
    airportFares: [
      { match: "manchester", price: 95 },
      { match: "liverpool", price: 110 },
      { match: "leeds", price: 105 }
    ]
  }
};

const VAT_RATE = 0.2;

/* =========================
   GEO + ROUTING
========================= */
async function geocodeUK(address) {
  const res = await axios.get(
    "https://nominatim.openstreetmap.org/search",
    {
      params: {
        q: address + ", United Kingdom",
        format: "json",
        limit: 1,
        countrycodes: "gb"
      },
      headers: { "User-Agent": "TTTaxis Booking System" }
    }
  );

  if (!res.data?.length) throw new Error("Geocoding failed");

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
      {
        coordinates: [[from.lon, from.lat], [to.lon, to.lat]]
      },
      {
        headers: {
          Authorization: process.env.ORS_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.features[0].properties.summary.distance / 1609.344;
  } catch {
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

/* =========================
   PRICE CALCULATION
========================= */
async function calculatePrice(areaKey, pickup, dropoff) {
  const area = AREAS[areaKey] || AREAS.kendal;
  const p = pickup.toLowerCase();
  const d = dropoff.toLowerCase();

  for (const rule of area.airportFares) {
    if (p.includes(rule.match) || d.includes(rule.match)) {
      return {
        fixed: true,
        miles: null,
        price: Number((rule.price * (1 + VAT_RATE)).toFixed(2))
      };
    }
  }

  const miles = await calculateMiles(pickup, dropoff);
  const base = Math.max(area.minFare, miles * area.perMile);

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
  if (!res.ok) throw new Error("Square API error");
  return data;
}

/* =========================
   EMAIL HELPER
========================= */
async function sendBookingEmails({ email, bookingRef, amountPaid, area }) {
  const customerEmail = {
    to: email,
    from: process.env.SENDGRID_FROM,
    subject: `Your ${area.label} TTTaxis Booking`,
    text:
`Thank you for booking with TTTaxis (${area.label}).

Booking reference: ${bookingRef}
Amount paid: £${amountPaid}

If you paid a deposit, the remaining balance is payable to the driver.

TTTaxis`
  };

  const operatorEmail = {
    to: area.operatorEmail,
    from: process.env.SENDGRID_FROM,
    subject: `New ${area.label} Booking Confirmed`,
    text:
`Booking confirmed (${area.label})

Reference: ${bookingRef}
Amount paid: £${amountPaid}`
  };

  await sgMail.send(customerEmail);
  await sgMail.send(operatorEmail);
}

/* =========================
   ROUTES
========================= */
app.get("/health", (_, res) => res.json({ ok: true }));

/* ---------- QUOTE ---------- */
app.post("/quote", async (req, res) => {
  try {
    const { pickup, dropoff, area = "kendal" } = req.body;
    const result = await calculatePrice(area, pickup, dropoff);

    res.json({
      area,
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
  } catch {
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
      area = "kendal"
    } = req.body;

    const cfg = AREAS[area] || AREAS.kendal;

    if (price_gbp_inc_vat <= 15) {
      return res.json({ payment_mode: "pay_driver" });
    }

    const amount =
      payment_type === "deposit"
        ? Number((price_gbp_inc_vat * 0.1).toFixed(2))
        : price_gbp_inc_vat;

    const checkout = await squareRequest(
      "/v2/online-checkout/payment-links",
      {
        idempotency_key: crypto.randomUUID(),
        quick_pay: {
          name: `TTTaxis ${cfg.label} Booking`,
          price_money: {
            amount: Math.round(amount * 100),
            currency: "GBP"
          },
          location_id: cfg.squareLocation
        },
        checkout_options: {
          redirect_url: cfg.redirectUrl
        },
        pre_populated_data: {
          buyer_email: email
        },
        note: `Booking ${booking_id} | ${pickup} → ${dropoff} (${cfg.label})`
      }
    );

    res.json({ checkout_url: checkout.payment_link.url });
  } catch {
    res.status(500).json({ error: "Unable to create payment" });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log("TTTaxis backend running on port " + PORT);
});










