/* =========================
   IMPORTS
========================= */
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
   ENV CHECKS
========================= */
if (!process.env.SENDGRID_API_KEY) {
  console.error("❌ SENDGRID_API_KEY missing");
}
if (!process.env.SENDGRID_FROM) {
  console.error("❌ SENDGRID_FROM missing");
}
if (!process.env.ORS_API_KEY) {
  console.error("❌ ORS_API_KEY missing");
}

/* =========================
   SENDGRID
========================= */
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json({ limit: "256kb" }));

app.use(
  cors({
    origin: ["https://tttaxis.uk", "https://www.tttaxis.uk"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

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
   GEO (UK ONLY) - NOMINATIM
========================= */
async function geocodeUK(address) {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(`${address}, United Kingdom`)}` +
    "&format=json&limit=1&countrycodes=gb";

  const res = await axios.get(url, {
    headers: {
      "User-Agent": "TTTaxis Booking System - terry@tttaxis.uk"
    },
    timeout: 12000
  });

  const data = res.data;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No geocode result for: ${address}`);
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon)
  };
}

/* =========================
   ROUTING (DRIVING DISTANCE)
   OPENROUTESERVICE
========================= */
async function routeMilesORS(from, to) {
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
      },
      timeout: 15000
    }
  );

  const meters =
    res.data?.features?.[0]?.properties?.summary?.distance;

  if (typeof meters !== "number") {
    throw new Error("No distance returned from ORS");
  }

  return meters / 1609.344; // meters → miles
}

/* =========================
   CALCULATE MILES
========================= */
async function calculateMiles(pickup, dropoff) {
  const from = await geocodeUK(pickup);
  const to = await geocodeUK(dropoff);
  const miles = await routeMilesORS(from, to);

  if (!Number.isFinite(miles) || miles <= 0) {
    throw new Error("Invalid miles calculated");
  }

  return miles;
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "tttaxis-backend",
    time: new Date().toISOString()
  });
});

/* =========================
   QUOTE ROUTE
=============

