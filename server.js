import express from "express";
import cors from "cors";
import crypto from "crypto";
import axios from "axios";
import sgMail from "@sendgrid/mail";

const app = express();
const PORT = process.env.PORT || 8080;

/* ENV CHECKS */
if (!process.env.SENDGRID_API_KEY) console.error("SENDGRID_API_KEY missing");
if (!process.env.SENDGRID_FROM) console.error("SENDGRID_FROM missing");
if (!process.env.ORS_API_KEY) console.error("ORS_API_KEY missing");

/* SENDGRID */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* MIDDLEWARE */
app.use(express.json());
app.use(
  cors({
    origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

/* PRICING */
const VAT_RATE = 0.2;
const MIN_FARE = 4.2;
const LOCAL_PER_MILE = 2.2;

const FIXED_AIRPORT_FARES = [
  { match: "manchester", price: 120 },
  { match: "liverpool", price: 132 },
  { match: "leeds", price: 98 }
];

/* GEOCODE (UK ONLY) */
async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    "?q=" +
    encodeURIComponent(address + ", United Kingdom") +
    "&format=json&limit=1&countrycodes=gb";

  const res = await axios.get(url, {
    headers: {
      "User-Agent": "TTTaxis Booking System"
    }
  });

  if (!res.data || !res.data.length) {
    throw new Error("Geocode failed");
  }

  return {
    lat: Number(res.data[0].lat),
    lon: Number(res.data[0].lon)
  };
}

/* ROUTING */
async function routeMiles(from, to) {
  const res = await axios.post(
    "https://api.openrouteservice.org/v2/directions/driving-car",
    {
      coordinates: [
        [from.lon, from.lat],
        [to.lon, to.lat]
      ]
    },
    {
      headers: {
        Authorization: process.env.ORS_API_KEY,
        "Content-Type": "application/json"
      }
    }
  );

  const meters =
    res.data.features[0].properties.summary.distance;

  return meters / 1609.344;
}

async function calculateMiles(pickup, dropoff) {
  const from = await geocodeUK(pickup);
  const to = await geocodeUK(dropoff);
  return routeMiles(from, to);
}

/* HEALTH */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* QUOTE */
app.post("/quote", async (req, res) => {
  try {
    const pickup = req.body.pickup;
    const dropoff = req.body.dropoff;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: "Missing locations" });
    }

    const p = pickup.toLowerCase();
    const d = dropoff.toLowerCase();

    for (const rule of FIXED_AIRPORT_FARES) {
      if (p.includes(rule.match) || d.includes(rule.match)) {
        const total = Number(
          (rule.price * (1 + VAT_RATE)).toFixed(2)
        );

        return res.json({
          fixed: true,
          miles: null,
          price_gbp_inc_vat: total,
          vat_rate: VAT_RATE,
          currency: "GBP",
          pricing_model: "fixed_airport"
        });
      }
    }

    const miles = await calculateMiles(pickup, dropoff);
    const base = Math.max(MIN_FARE, miles * LOCAL_PER_MILE);
    const total = Number((base * (1 + VAT_RATE)).toFixed(2));

    res.json({
      fixed: false,
      miles: Number(miles.toFixed(2)),
      price_gbp_inc_vat: total,
      vat_rate: VAT_RATE,
      currency: "GBP",
      pricing_model: "distance"
    });
  } catch (e) {
    console.error(e.message);
    res.status(422).json({ error: "Unable to calculate distance" });
  }
});

/* BOOK */
app.post("/book", async (req, res) => {
  try {
    const booking = {
      id: crypto.randomUUID(),
      pickup: req.body.pickup,
      dropoff: req.body.dropoff,
      name: req.body.name,
      phone: req.body.phone,
      email: req.body.email || null,
      price_gbp_inc_vat: req.body.price_gbp_inc_vat
    };

    if (!booking.pickup || !booking.dropoff || !booking.name || !booking.phone) {
      return res.status(400).json({ success: false });
    }

    if (booking.email && process.env.SENDGRID_API_KEY) {
      await sgMail.send({
        to: booking.email,
        from: process.env.SENDGRID_FROM,
        subject: "TTTaxis Booking Confirmation",
        text:
          "Reference: " +
          booking.id +
          "\nPickup: " +
          booking.pickup +
          "\nDropoff: " +
          booking.dropoff +
          "\nPrice: £" +
          booking.price_gbp_inc_vat
      });
    }

    res.json({ success: true, booking });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ success: false });
  }
});

/* START */
app.listen(PORT, () => {
  console.log("TTTaxis backend running on port " + PORT);
});
